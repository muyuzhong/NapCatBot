// 意图识别：先走便宜规则，模糊情况才问 Flash 要不要参与。它只做"要不要回"，不负责回答。
import { log } from './logger.ts';
import { prompts } from './prompts.ts';

export type Decision = { reply: boolean; reason: string; source: 'rule' | 'flash' };
export type RuleInput = {
  selfId: string;                       // 机器人自己的 QQ 号
  isGroup: boolean;
  text: string;                         // 已解析的消息文本（@ 会变成 @QQ号）
  segments: { type: string; data?: Record<string, any> }[];
  participants: string[];               // 本批都有谁在说话
  history: { me: boolean; prefix: string; text: string }[];
};

const env = process.env;
const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
// 引用匹配靠消息 ID；拿不到 ID 的适配器退回"上一条回复的对象 + 时间窗"。
const answerWindowMs = num(env.INTENT_ANSWER_WINDOW_MS, 300_000);
const historySize = num(env.INTENT_HISTORY, 6);
const judgeTimeoutMs = num(env.LLM_DECIDE_TIMEOUT_MS, 10_000);

const isQuestion = (text: string) => /[?？]|[吗呢吧]\s*$/.test(text.trim());
const replyId = (segments: { type: string; data?: Record<string, any> }[]) =>
  segments.find(s => s.type === 'reply')?.data?.id;

export type Tracker = {
  /** 记录机器人刚发出的回复，供"引用我"和"回答我的提问"判断。 */
  sent(chatKey: string, messageId: number | undefined, text: string, name: string, targets: string[]): void;
  /** 机器人是否在本批之前已经回应过这些人（用于给 Flash 提供参照）。 */
  answeredRecently(chatKey: string, names: string[], withinMs?: number): boolean;
  isReplyToBot(chatKey: string, segments: { type: string; data?: Record<string, any> }[]): boolean;
  awaitingAnswer(chatKey: string, participants: string[]): boolean;
};

/** 机器人自己说过的话：只记内存，重启即失效，不参与存档。 */
export function createTracker(): Tracker {
  const last = new Map<string, { id?: number; at: number; name: string; targets: string[]; question: boolean }>();
  const isSelf = (name: string) => name === '我自己';
  return {
    sent(chatKey, messageId, text, name, targets) {
      last.set(chatKey, { id: messageId, at: Date.now(), name, targets, question: isQuestion(text) });
    },
    answeredRecently(chatKey, names, withinMs = answerWindowMs) {
      const record = last.get(chatKey);
      if (!record || Date.now() - record.at > withinMs) return false;
      return names.some(n => record.targets.includes(n) || record.targets.includes('@全体成员'));
    },
    isReplyToBot(chatKey, segments) {
      const id = replyId(segments);
      const record = last.get(chatKey);
      if (!record) return false;
      if (id !== undefined && record.id !== undefined) return String(id) === String(record.id);
      // 适配器没给消息 ID 时：只认"引用 + 时间窗内机器人刚回过"这种弱信号。
      return id !== undefined && Date.now() - record.at <= answerWindowMs;
    },
    awaitingAnswer(chatKey, participants) {
      const record = last.get(chatKey);
      if (!record || !record.question || Date.now() - record.at > answerWindowMs) return false;
      return participants.some(p => record.targets.includes(p));
    },
  };
}

/** 明确情况走规则；返回 null 表示交给 Flash 判断。 */
export function ruleDecision(input: RuleInput, tracker: Tracker, chatKey: string): Decision | null {
  if (!input.isGroup) return { reply: true, reason: '私聊', source: 'rule' };
  if (input.text.includes(`@${input.selfId}`)) return { reply: true, reason: '被@', source: 'rule' };
  if (tracker.isReplyToBot(chatKey, input.segments)) return { reply: true, reason: '引用了我', source: 'rule' };
  if (tracker.awaitingAnswer(chatKey, input.participants)) return { reply: true, reason: '在回答我的提问', source: 'rule' };
  return null;
}

/** 给 Flash 的判断请求：只回答参与与否，附带一句理由。措辞在 prompts/decide.txt。 */
export function buildJudgePrompt(input: RuleInput): string {
  const history = input.history.slice(-historySize)
    .map(m => `${m.me ? '我自己' : m.prefix}：${m.text.replace(/\n/g, ' / ')}`)
    .join('\n');
  return prompts.decide({ history: history || '（无）', messages: input.text });
}

/** 解析判断结果：模型只回一个 true / false。认不出来返回 null，由上层按不参与处理。 */
export function parseJudge(raw: string): boolean | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/\btrue\b/.test(text)) return true;
  if (/\bfalse\b/.test(text)) return false;
  return null;
}

async function askFlash(input: RuleInput): Promise<Decision> {
  const base = (env.LLM_DECIDE_URL || env.LLM_BASE_URL || '').replace(/\/$/, '');
  const model = env.LLM_DECIDE_MODEL || env.LLM_MODEL;
  if (!base || !model) throw new Error('未配置判断模型（LLM_DECIDE_MODEL）');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LLM_DECIDE_KEY || env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: buildJudgePrompt(input) }],
      stream: false,
      temperature: 0,
      // 只需要一个 true / false，额度够覆盖推理开销即可。
      max_tokens: num(env.LLM_DECIDE_MAX_TOKENS, 64),
    }),
    signal: AbortSignal.timeout(judgeTimeoutMs),
  });
  if (!response.ok) throw new Error(`判断模型 HTTP ${response.status}`);
  const message = (await response.json()).choices?.[0]?.message;
  const raw = String(message?.content || message?.reasoning_content || '');
  const reply = parseJudge(raw);
  if (reply === null) throw new Error(`判断模型未返回 true/false：${raw.slice(0, 80)}`);
  // 把模型原样输出留在 reason 里，日志一眼能看出它到底回了什么。
  return { reply, reason: `judge:${raw.trim().slice(0, 40)}`, source: 'flash' };
}

/** 最终判定：规则优先，模糊才交给 Flash；判断失败按"不参与"处理，保证不会因此卡住。 */
export async function shouldReply(input: RuleInput, tracker: Tracker, chatKey: string): Promise<Decision> {
  const ruled = ruleDecision(input, tracker, chatKey);
  if (ruled) return ruled;
  try {
    const decision = await askFlash(input);
    log('参与判断', { chatKey, reply: decision.reply, reason: decision.reason });
    return decision;
  } catch (error: any) {
    log('参与判断失败，按不参与处理', { chatKey, error: error.message });
    return { reply: false, reason: `判断失败：${error.message}`, source: 'flash' };
  }
}
