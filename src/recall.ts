// 读取链路：Memory Gate → 画像精确过滤 + 事件向量检索 → 阈值过滤 → 最多 1~3 条注入。
// Gate 的意义是"只在需要时回忆"：随手一句"哈哈哈哈"也去翻旧账，召回得再准也会把话题带偏。
import { log } from './logger.ts';
import { prompts } from './prompts.ts';
import { embed, embedConfigured } from './embed.ts';
import { listProfiles, memoryEnabled, searchEvents, type EventHit, type ProfileRow } from './memory.ts';

const env = process.env;
const eventLimit = Math.min(3, Math.max(1, Number(env.MEMORY_RECALL_EVENTS || 2)));
const maxDistance = Number(env.MEMORY_MAX_DISTANCE || 0.45);
const profileLimit = Number(env.MEMORY_RECALL_PROFILES || 6);

// 明显在接前文/翻旧账的说法才去查长期记忆。匹配规则留在代码里，判断口径的口径写在 README。
const recallPatterns: [RegExp, string][] = [
  [/上次|上回|之前|以前|原先|原来|当初/, '提到以前'],
  [/还记得|记不记得|记得|忘了/, '问记不记得'],
  [/后来|怎么样了|如何了|进展|结果/, '问后续'],
  [/过了|考完|考得|搞定|成了|结束|出了/, '说结果'],
  [/答应|说好|约好/, '提到约定'],
  [/去过|吃过|干过|玩过|做过|见过|说过/, '提到经历'],
];

/** 规则版 Memory Gate：命中回忆信号才查；其余一律不查（宁可少查，不要乱翻旧账）。 */
export function needMemory(text: string): { need: boolean; reason: string } {
  const value = String(text ?? '').trim();
  if (env.MEMORY_GATE === '0') return { need: true, reason: 'Gate 已关闭，默认都查' };
  if (!value) return { need: false, reason: '空消息' };
  for (const [pattern, reason] of recallPatterns) if (pattern.test(value)) return { need: true, reason };
  if (value.replace(/\s/g, '').length <= 8) return { need: false, reason: '短句闲聊' };
  return { need: false, reason: '没有回忆信号' };
}

export type RecallResult = {
  text?: string;
  profiles: number;
  events: number;
  reason: string;
  profileIds: string[];
  eventIds: string[];
};

const none = (reason: string): RecallResult => ({ profiles: 0, events: 0, reason, profileIds: [], eventIds: [] });

const formatProfiles = (rows: ProfileRow[]) => {
  const byUser = new Map<string, { name: string; facts: string[] }>();
  for (const row of rows) {
    const key = row.user_id || '';
    const entry = byUser.get(key) ?? { name: row.user_id ? `${row.user_name || '某人'}(${row.user_id})` : '本群', facts: [] };
    entry.facts.push(row.content);
    byUser.set(key, entry);
  }
  return [...byUser.values()].map(({ name, facts }) => `- ${name}：${facts.join('；')}`).join('\n');
};

const formatEvents = (rows: EventHit[]) => rows
  .map(row => `- ${new Date(row.created_at).toISOString().slice(0, 10)} ${row.content}`)
  .join('\n');

/**
 * 取当前会话可用的长期记忆。任何一步失败都退化成"没有记忆"，绝不挡住回复。
 * scope 用会话 key（group:<群号> / private:<QQ号>），画像和事件都按它隔离。
 */
export async function recall(input: { scope: string; speakerIds: string[]; text: string }): Promise<RecallResult> {
  if (!memoryEnabled()) return none('记忆功能已关闭');
  const gate = needMemory(input.text);
  if (!gate.need) return none(`Gate 跳过：${gate.reason}`);
  const profiles = await listProfiles(input.scope, [...new Set([...input.speakerIds, ''])], profileLimit);
  let events: EventHit[] = [];
  if (embedConfigured()) {
    const vector = await embed(input.text);
    // 没配 embedding 或向量化失败时不做事件检索：宁可没有往事，也不要塞不相关的。
    if (vector) events = await searchEvents(vector, { scope: input.scope, limit: eventLimit, maxDistance });
  }
  if (!profiles.length && !events.length) return none(`没有相关记忆（Gate：${gate.reason}）`);
  const result: RecallResult = {
    text: prompts.memoryInject({ profiles: formatProfiles(profiles), events: formatEvents(events) }),
    profiles: profiles.length,
    events: events.length,
    reason: gate.reason,
    profileIds: profiles.map(row => row.id),
    eventIds: events.map(row => row.id),
  };
  log('记忆召回', { scope: input.scope, reason: gate.reason, profiles: result.profiles, events: result.events });
  return result;
}
