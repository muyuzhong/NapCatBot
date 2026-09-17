// 模型层只负责上下文和事件流，不操作 QQ。
import type { Message, Session } from './store.ts';
import { prompts } from './prompts.ts';

export type { Message };
export type AgentEvent =
  | { type: 'model.started'; messages: Message[] }
  | { type: 'model.reasoning'; text: string }
  | { type: 'model.completed'; finishReason: string; usage: unknown }
  | { type: 'reply'; text: string; history: Message[] };

const env = process.env;
const contextTokens = Number(env.LLM_CONTEXT_TOKENS || 8192);
const outputTokens = Number(env.LLM_MAX_OUTPUT_TOKENS || 1024);
// 用到窗口的这个比例就开始压缩，留出输出额度和估算误差。
const compressAt = Math.min(1, Math.max(0.1, Number(env.LLM_COMPRESS_AT || 0.8)));
const summaryTurns = Math.max(1, Number(env.LLM_SUMMARY_TURNS || 8));
// 措辞放在 prompts/system.txt，改提示词不用动代码。
const system = (): Message => ({ role: 'system', content: prompts.system });

// ponytail: UTF-8 字节数保守估算 token；精确利用窗口时再接 tokenizer。
export function estimateSize(messages: Message[]): number {
  return 32 + messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + 16, 0);
}

// 只保留系统提示和最新一条，其余旧记录按完整的 user + assistant 删除。
// 这是压缩不可用时的兜底：丢的是内容，不是整轮对话的边界。
export function trimContext(messages: Message[], budget: number): Message[] {
  const result = [...messages];
  while (result.length > 3 && estimateSize(result) > budget) result.splice(1, 2);
  if (estimateSize(result) > budget) throw new Error('消息超过上下文预算，请缩短消息或调大预算');
  return result;
}

// 超预算时把最旧的若干段交给模型压成摘要，每轮对话最多一次摘要调用。
// 先按批收集要丢掉的消息、再一次性压缩，避免步长不够时反复调用模型。
async function compress(session: Session, threshold: number, summarize: typeof summarizeHistory): Promise<void> {
  const head = () => (session.summary ? [{ role: 'system' as const, content: session.summary }] : []);
  const size = () => estimateSize([system(), ...head(), ...session.messages]);
  if (session.messages.length - 1 < 2 || size() <= threshold) throw new Error('消息超过上下文预算，请缩短消息或调大预算');
  const dropped: Message[] = [];
  let estimate = size();
  // 每次多丢 summaryTurns 轮，直到按摘要体积估算能回到阈值以内。
  while (session.messages.length - dropped.length > 1 && estimate > threshold) {
    const take = Math.min(session.messages.length - 1 - dropped.length, summaryTurns * 2);
    if (take < 2) break;
    dropped.push(...session.messages.slice(dropped.length, dropped.length + take));
    estimate = estimateSize([system(), ...head(), { role: "user" as const, content: "摘".repeat(400) }, ...session.messages.slice(dropped.length)]);
  }
  if (!dropped.length) throw new Error('消息超过上下文预算，请缩短消息或调大预算');
  const summary = await summarize(dropped).catch((error: any) => {
    throw new Error(`摘要失败，本轮未发送：${error.message}`);
  });
  if (!summary) throw new Error('摘要为空，本轮未发送');
  session.summarize(summary, dropped.length);
}

function buildMessages(session: Session): Message[] {
  return [
    system(),
    ...(session.summary ? [{ role: 'system' as const, content: `[前情摘要] ${session.summary}` }] : []),
    ...session.messages,
  ];
}

// 摘要调用也走同一个接口；措辞放在 prompts/summary.txt，超长记录直接截断避免撑爆窗口。
async function summarizeHistory(dropped: Message[]): Promise<string | undefined> {
  const prompt = prompts.summary({
    history: dropped.map(m => `${m.role === 'user' ? '对方' : '我'}：${m.content.slice(0, 2000)}`).join('\n'),
  });
  const response = await fetch(`${env.LLM_BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      // 推理型模型会先把额度花在 reasoning 上，留小了正文会是空的。
      max_tokens: Math.min(outputTokens, 1024),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`摘要 HTTP ${response.status}`);
  const message = (await response.json()).choices?.[0]?.message;
  const text = message?.content || message?.reasoning_content || message?.reasoning;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

// 一轮对话：压缩决策在 model.started 之前完成，所以 started 里的就是最终请求体。
export async function* chatLoop(
  session: Session,
  onCompress: (dropped: Message[]) => Promise<string | undefined> = summarizeHistory,
): AsyncGenerator<AgentEvent, { reply: string }> {
  const budget = contextTokens - outputTokens;          // 能安全发送的上限
  const threshold = Math.floor(budget * compressAt);    // 到此比例开始压缩
  if (estimateSize(buildMessages(session)) > threshold) {
    // 摘要出不来时不放弃这一轮，退回纯裁剪继续回复；裁剪也装不下才抛错。
    try { await compress(session, threshold, onCompress); }
    catch { session.trim(trimContext([system(), ...session.messages], threshold).length); }
  }
  const messages = buildMessages(session);
  if (estimateSize(messages) > budget) throw new Error('消息超过上下文预算，请缩短消息或调大预算');
  yield { type: 'model.started', messages };
  const response = await fetch(`${env.LLM_BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.LLM_MODEL, messages, stream: false, max_tokens: outputTokens }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`模型 HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  const data = await response.json();
  const choice = data.choices?.[0];
  const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  // 只展示接口明确返回的思考字段；非流式请求需等完整响应返回。
  if (reasoning) yield { type: 'model.reasoning', text: typeof reasoning === 'string' ? reasoning : JSON.stringify(reasoning) };
  yield { type: 'model.completed', finishReason: choice?.finish_reason, usage: data.usage };
  const textOutput = choice?.message?.content;
  if (typeof textOutput !== 'string' || !textOutput.trim()) throw new Error('模型未返回文本');
  const reply = textOutput.trim();
  yield { type: 'reply', text: reply, history: [...session.messages, { role: 'assistant', content: reply }] };
  return { reply };
}
