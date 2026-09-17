// 写入链路：一段聊天结束 → 提取候选 → 找已有相关记忆 → ADD / UPDATE / IGNORE → 落库。
// 两个要点：
// 1. 不是"来一条消息就 embedding"，而是等一段聊天安静下来，用 Flash 判断值不值得长期记。
// 2. 证据强度决定去向：本人陈述才算画像，第三方说法只降级成事件，模型推断直接丢。
import { log } from './logger.ts';
import { prompts } from './prompts.ts';
import { embed, embedConfigured } from './embed.ts';
import {
  addEvents, addProfiles, listProfiles, memoryEnabled, recentEvents, searchEvents, updateEvent, updateProfile,
  type EventRow, type Evidence, type ProfileRow,
} from './memory.ts';

const env = process.env;
const minImportance = Number(env.MEMORY_MIN_IMPORTANCE || 0.4);
const maxDistance = Number(env.MEMORY_MAX_DISTANCE || 0.45);
const model = () => env.LLM_MEMORY_MODEL || env.LLM_DECIDE_MODEL || env.LLM_MODEL;
const url = () => (env.LLM_MEMORY_URL || env.LLM_DECIDE_URL || env.LLM_BASE_URL || '').replace(/\/$/, '');
const apiKey = () => env.LLM_MEMORY_KEY || env.LLM_DECIDE_KEY || env.LLM_API_KEY;
const maxTokens = Number(env.LLM_MEMORY_MAX_TOKENS || 1024);
const timeoutMs = Number(env.LLM_MEMORY_TIMEOUT_MS || 60_000);
const evidences: Evidence[] = ['self_statement', 'observed_event', 'third_party_claim', 'inference'];

export type Candidate = {
  target: 'profile' | 'event';
  subject: string;      // 昵称，用于注入时显示
  subject_id: string;   // QQ 号
  type: string;
  content: string;
  evidence: Evidence;
  importance: number;
  confidence: number;
};

export type Op = { op: 'ADD' | 'UPDATE' | 'IGNORE'; candidate?: number; existing_id?: string; content?: string; importance?: number; confidence?: number; reason?: string };

export type RememberInput = {
  scope: string;                     // group:<群号> / private:<QQ号>
  segment: string;                   // 一段聊天记录（每行带时间和发言人）
  speakers: { id: string; name: string }[];
  sourceIds: string;                 // 逗号分隔的消息 ID，用于追溯
  participants: string[];
};

const clamp = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
};

/** 模型偶尔会带 ```json 围栏或前后废话，这里只负责把 JSON 挖出来。 */
export function parseJson(raw: string): any | undefined {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  const candidates = [text, text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()];
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* 换下一种切法 */ }
  }
  return undefined;
}

/** 归一化候选记忆：非法条目直接丢掉，宁可少记也不要写脏数据。 */
export function parseCandidates(raw: string): Candidate[] {
  const list = parseJson(raw)?.memories;
  if (!Array.isArray(list)) return [];
  const result: Candidate[] = [];
  for (const item of list) {
    const content = String(item?.content ?? '').trim();
    const target = item?.target === 'profile' ? 'profile' : item?.target === 'event' ? 'event' : undefined;
    if (!content || !target) continue;
    const evidence = evidences.includes(item?.evidence) ? item.evidence as Evidence : 'observed_event';
    const subjectId = String(item?.subject_id ?? '').replace(/\D/g, '');
    if (target === 'profile' && !subjectId) continue; // 画像必须挂在具体的人身上
    result.push({
      target,
      subject: String(item?.subject ?? '').trim(),
      subject_id: subjectId,
      type: String(item?.type ?? (target === 'profile' ? 'identity' : 'event')).trim() || 'identity',
      content: content.slice(0, 300),
      evidence,
      importance: clamp(item?.importance, 0.6),
      confidence: clamp(item?.confidence, 0.6),
    });
  }
  return result;
}

/** 规则层：证据强度不够的直接在这里处理掉，不浪费模型调用。 */
export function applyEvidenceRules(candidates: Candidate[]): { kept: Candidate[]; dropped: string[] } {
  const kept: Candidate[] = [];
  const dropped: string[] = [];
  for (const candidate of candidates) {
    if (candidate.evidence === 'inference') { dropped.push(`推断不记：${candidate.content.slice(0, 20)}`); continue; }
    if (candidate.target === 'event' && candidate.importance < minImportance) { dropped.push(`不重要：${candidate.content.slice(0, 20)}`); continue; }
    // 第三方描述不能当画像用，降级成事件，可信度打折。
    if (candidate.target === 'profile' && candidate.evidence === 'third_party_claim') {
      kept.push({ ...candidate, target: 'event', type: 'claim', confidence: Math.max(0.2, candidate.confidence * 0.5) });
      dropped.push(`第三方说法降级为事件：${candidate.content.slice(0, 20)}`);
      continue;
    }
    kept.push(candidate);
  }
  return { kept, dropped };
}

async function ask(prompt: string): Promise<string> {
  const endpoint = url();
  const name = model();
  if (!endpoint || !name) throw new Error('未配置记忆模型（LLM_MEMORY_MODEL / LLM_DECIDE_MODEL）');
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`记忆模型 HTTP ${response.status}`);
  const message = (await response.json()).choices?.[0]?.message;
  // 推理型模型可能把额度花在 reasoning 上，正文为空时退回 reasoning。
  return String(message?.content || message?.reasoning_content || '');
}

const newId = () => crypto.randomUUID();
const now = () => Date.now();

/** 找这条候选可能对应/冲突的已有记忆：画像按人精确取，事件按向量取（没向量就按人取最近的）。 */
async function relatedTo(candidate: Candidate, scope: string, vector?: number[] | null) {
  const profiles = candidate.target === 'profile' ? await listProfiles(scope, [candidate.subject_id], 8) : [];
  const events = candidate.target === 'event'
    ? (vector ? await searchEvents(vector, { scope, limit: 3, maxDistance })
              : await recentEvents(scope, [candidate.subject_id], 3))
    : [];
  return { profiles, events };
}

const profileRow = (candidate: Candidate, input: RememberInput): ProfileRow => ({
  id: newId(), group_id: input.scope, user_id: candidate.subject_id, user_name: candidate.subject,
  type: candidate.type, content: candidate.content, evidence: candidate.evidence,
  confidence: candidate.confidence, created_at: now(), updated_at: now(), source_message_ids: input.sourceIds,
});

const eventRow = (candidate: Candidate, input: RememberInput, embedding: number[]): EventRow => ({
  id: newId(), group_id: input.scope, subject_user_id: candidate.subject_id,
  participants: input.participants.join(','), type: candidate.type, content: candidate.content,
  importance: candidate.importance, confidence: candidate.confidence, evidence: candidate.evidence,
  created_at: now(), updated_at: now(), source_message_ids: input.sourceIds, embedding,
});

export type RememberResult = { added: number; updated: number; ignored: number; dropped: string[]; reason?: string };

/**
 * 组装一段待提取的聊天：最近若干条记录 + 说话人对照 + 消息 ID。
 * 记录里既有群友的话（哪怕机器人没参与），也有机器人自己的回复，这样没搭话的话题也能记住。
 */
export function buildRememberInput(
  scope: string,
  entries: string[],
  refs: { mid?: number; uid: string; name: string }[],
  limit: number,
): RememberInput {
  const segment = entries.slice(-limit);
  const speakers = [...new Map(refs.map(ref => [ref.uid, ref.name])).entries()].map(([id, name]) => ({ id, name }));
  return {
    scope,
    segment: segment.join('\n'),
    speakers,
    sourceIds: refs.map(ref => ref.mid).filter(Boolean).join(','),
    participants: [...new Set(refs.map(ref => ref.uid))],
  };
}

/**
 * 处理一段聊天：提取 → 决策 → 落库。返回计数便于日志和测试。
 * 任何一步失败都只记日志，不抛给调用方（记忆写失败不该影响聊天）。
 */
export async function rememberSegment(input: RememberInput): Promise<RememberResult> {
  const empty: RememberResult = { added: 0, updated: 0, ignored: 0, dropped: [] };
  if (!memoryEnabled()) return { ...empty, reason: '记忆功能已关闭' };
  if (!input.segment.trim()) return { ...empty, reason: '这段没有内容' };
  const extracted = await ask(prompts.memoryExtract({
    scope: input.scope,
    speakers: input.speakers.map(s => `${s.name}=${s.id}`).join('，') || '（未知）',
    segment: input.segment,
  }));
  const { kept, dropped } = applyEvidenceRules(parseCandidates(extracted));
  if (!kept.length) return { ...empty, dropped, reason: '没有值得长期记的内容' };

  // 事件必须有向量；画像按精确过滤读取，不需要向量，省一次调用。
  const vectors = new Map<Candidate, number[] | null>();
  for (const candidate of kept) {
    vectors.set(candidate, candidate.target === 'event' && embedConfigured() ? await embed(candidate.content) : null);
  }
  const related = await Promise.all(kept.map(candidate => relatedTo(candidate, input.scope, vectors.get(candidate))));

  const additions: { candidate: Candidate; vector: number[] | null }[] = [];
  const updates: { id: string; content?: string; importance?: number; confidence?: number }[] = [];
  let ignored = 0;

  const hasRelated = related.some(({ profiles, events }) => profiles.length || events.length);
  if (!hasRelated) {
    // 库里没有任何相关记忆，不需要再问一次模型，直接 ADD。
    for (const candidate of kept) additions.push({ candidate, vector: vectors.get(candidate) ?? null });
  } else {
    const ops = parseOps(await ask(prompts.memoryMerge({
      existing: formatExisting(related.flatMap(({ profiles, events }) => [...profiles.map(p => ({ ...p, kind: 'profile' })), ...events.map(e => ({ ...e, kind: 'event' }))])),
      candidates: kept.map((candidate, index) => `[${index}] ${candidate.target} ${candidate.subject}(${candidate.subject_id}) ${candidate.type}：${candidate.content}（证据 ${candidate.evidence}，重要度 ${candidate.importance}）`).join('\n'),
    })));
    if (!ops) {
      // 决策解析失败时按 ADD 处理：宁可多记一条，也不要悄悄丢掉信息。
      for (const candidate of kept) additions.push({ candidate, vector: vectors.get(candidate) ?? null });
    } else {
      for (const op of ops) {
        const candidate = typeof op.candidate === 'number' && !Number.isNaN(op.candidate) ? kept[op.candidate] : undefined;
        if (op.op === 'ADD' && candidate) additions.push({ candidate, vector: vectors.get(candidate) ?? null });
        else if (op.op === 'UPDATE' && op.existing_id) updates.push({ id: op.existing_id, content: op.content, importance: op.importance, confidence: op.confidence });
        else ignored++;
      }
      // 模型漏掉的候选补成 ADD：提取到了却没落地，比多记一条更糟。
      const covered = new Set(ops.map(op => op.candidate).filter(index => typeof index === 'number'));
      kept.forEach((candidate, index) => {
        if (!covered.has(index)) additions.push({ candidate, vector: vectors.get(candidate) ?? null });
      });
    }
  }

  let added = 0;
  let updated = 0;
  for (const { candidate, vector } of additions) {
    if (candidate.target === 'profile') added += await addProfiles([profileRow(candidate, input)]);
    else if (vector) added += await addEvents([eventRow(candidate, input, vector)]);
    else dropped.push(`没有向量，事件未写入：${candidate.content.slice(0, 20)}`);
  }
  for (const change of updates) {
    const values: Record<string, any> = { updated_at: now(), source_message_ids: input.sourceIds };
    if (change.content) values.content = change.content;
    if (change.importance !== undefined) values.importance = clamp(change.importance, 0.6);
    if (change.confidence !== undefined) values.confidence = clamp(change.confidence, 0.6);
    const done = await updateProfile(change.id, values) || await updateEvent(change.id, values);
    if (done) updated++;
  }
  return { added, updated, ignored, dropped };
}

function formatExisting(rows: any[]): string {
  if (!rows.length) return '（无）';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    lines.push(row.kind === 'profile'
      ? `[${row.id}] profile ${row.user_name || ''}(${row.user_id}) ${row.type}：${row.content}（证据 ${row.evidence}）`
      : `[${row.id}] event ${row.content}（证据 ${row.evidence}）`);
  }
  return lines.join('\n');
}

/** 解析 ADD/UPDATE/IGNORE 决策；认不出来返回 undefined，由调用方按 ADD 兜底。 */
export function parseOps(raw: string): Op[] | undefined {
  const list = parseJson(raw)?.ops;
  if (!Array.isArray(list)) return undefined;
  const ops: Op[] = [];
  for (const item of list) {
    const op = String(item?.op ?? '').toUpperCase();
    // 每条 op 都要带 candidate 下标：下面用它判断"哪些候选已经处理过"，漏了就会重复写一条。
    const candidate = Number(item?.candidate);
    if (op === 'ADD') ops.push({ op: 'ADD', candidate });
    else if (op === 'UPDATE') ops.push({ op: 'UPDATE', candidate, existing_id: String(item?.existing_id ?? ''), content: item?.content ? String(item.content) : undefined, importance: item?.importance, confidence: item?.confidence });
    else if (op === 'IGNORE') ops.push({ op: 'IGNORE', candidate, reason: item?.reason ? String(item.reason) : undefined });
  }
  return ops.length ? ops : undefined;
}
