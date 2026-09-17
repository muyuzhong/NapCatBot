import { openSession } from './src/store.ts';
import { chatLoop } from './src/agent.ts';
import { connect, sendReply, type QQEvent } from './src/napcat.ts';
import { createBatcher, sessionKey, type BatchMessage } from './src/batch.ts';
import { batchRuleInput, createTracker, shouldReply } from './src/decide.ts';
import { recall } from './src/recall.ts';
import { buildRememberInput, createMemoryQueue, rememberSegment } from './src/remember.ts';
import { memoryStats } from './src/memory.ts';
import { log } from './src/logger.ts';

// 单 Agent；入口负责会话隔离、消息聚合、意图识别、串行调度和消费模型事件。
const sessions = new Map<string, ReturnType<typeof openSession>>();
const sessionOf = (key: string) => {
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = openSession(key);
  sessions.set(key, session);
  return session;
};

const tracker = createTracker();
// 一批消息用哪条事件回复（用该批最后一条，回复上下文最新）。
const latest = new Map<string, QQEvent>();
// 会话之间可以并发；同一会话由聚合器的 busy/done 保证串行。

/** 供判断模型参考的近期对话：系统提示和摘要不算，机器人自己的话标成"我自己"。 */
function recentHistory(key: string) {
  // 第一条永远是系统提示（压缩只动它之后的记录），摘要也是 system，一并跳过。
  return sessionOf(key).messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      me: m.role === 'assistant',
      prefix: m.role === 'assistant' ? '我自己' : m.content.match(/^\[([^\]]+)\]/)?.[1] ?? '群友',
      text: m.content.replace(/^\[[^\]]+\]\s*/, ''),
    }));
}

// 一段聊天"结束"的判定：该会话安静 MEMORY_IDLE_MS 之后才提取长期记忆，避免边聊边写。
// 每个会话同时只有一个定时器；处理完之后只在有新消息时才真的提取。
const memoryIdleMs = Number(process.env.MEMORY_IDLE_MS || 180_000);
const memoryMinMessages = Math.max(1, Number(process.env.MEMORY_MIN_MESSAGES || 2));
const memorySegmentMessages = Math.max(2, Number(process.env.MEMORY_SEGMENT_MESSAGES || 12));
const memoryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const memoryRefs = new Map<string, { mid?: number; uid: string; name: string }[]>();
// 这段聊天攒下的记录：群友说的话（哪怕我们没参与）+ 我们自己的回复。
// 不能只从会话上下文取——没参与的消息不进上下文，那样"群里聊过什么"就永远记不住。
// 提取成功后由队列消费掉；缓冲区有上限，不能拿数组长度当游标（那样塞满之后就永远认为没有新消息）。
const memoryQueue = createMemoryQueue(memorySegmentMessages);

function scheduleRemember(key: string) {
  if (process.env.MEMORY_ENABLED === '0') return;
  clearTimeout(memoryTimers.get(key));
  memoryTimers.set(key, setTimeout(() => {
    memoryTimers.delete(key);
    rememberNow(key).catch(error => log('记忆提取失败', error.message));
  }, memoryIdleMs));
}

/** 把最近一段对话交给记忆提取：谁说的、说了什么、对应的 QQ 消息 ID。 */
async function rememberNow(key: string) {
  const entries = memoryQueue.peek(key, memoryMinMessages);
  if (!entries.length) return;
  const input = buildRememberInput(key, entries, (memoryRefs.get(key) ?? []).slice(-memorySegmentMessages), memorySegmentMessages);
  const result = await rememberSegment(input);
  memoryQueue.consume(key, entries.length); // 提取成功才消费；失败留着下次重试
  log('记忆提取', { key, added: result.added, updated: result.updated, ignored: result.ignored, reason: result.reason, dropped: result.dropped.slice(0, 3) });
}

// 一批消息处理一次：先判断要不要参与，再落盘、请求模型，发送成功了才写回复。
// 处理期间该会话的新消息由聚合器攒着，结束后再冲一次；所以一个会话同一时刻只有一批在处理。
async function handleBatch(key: string, batch: BatchMessage[]) {
  const event = latest.get(key);
  if (!event) return;
  const session = sessionOf(key);
  const chatKey = String(event.message_type === 'group' ? event.group_id : event.user_id);
  // 规则看整批（任意一行的 @ / 引用都算），回复仍然发到最后一条事件上。
  const input = batchRuleInput(event, batch, recentHistory(key));
  const text = input.text;
  batcher.busy(key);
  try {
    const decision = await shouldReply(input, tracker, chatKey);

    if (!decision.reply) {
      log('不参与', { key, reason: decision.reason, source: decision.source });
      session.skip(undefined, text, `${decision.source}:${decision.reason}`);
      memoryQueue.push(key, text); // 我们没参与，但这段照样可能值得长期记
      return;
    }
    log('参与', { key, reason: decision.reason, source: decision.source });
    log('消息聚合', { key, count: batch.length, text });
    // 只在要参与时才回忆（Gate 在 recall 里）；检索失败退化成"没有记忆"，不能挡住回复。
    const memory = await recall({ scope: key, speakerIds: input.participants, text }).catch((error: any) => {
      log('记忆检索失败', error.message);
      return undefined;
    });
    // 整批当成一条 user 消息；每行已带时间和发言人，不再套外层前缀。
    session.user(undefined, text);
    memoryQueue.push(key, text);
    const iterator = chatLoop(session, { memory: memory?.text });
    let result = await iterator.next();
    let messageId: number | undefined;
    while (!result.done) {
      const item = result.value;
      log(item.type, item.type === 'reply' ? item.text : item);
      if (item.type === 'reply') messageId = await sendReply(event, item.text); // 发送失败时不写入历史
      result = await iterator.next();
    }
    if (result.value?.reply) {
      session.reply(result.value.reply);
      memoryQueue.push(key, `我：${result.value.reply}`);
      // 记下"我说过什么、对谁说的"，用于后续的引用与追问判断。
      const mentioned = [...result.value.reply.matchAll(/@(\d{5,})/g)].map(m => m[1]);
      tracker.sent(chatKey, messageId, result.value.reply, '我自己', mentioned.length ? mentioned : input.participants);
    }
  } catch (error: any) {
    log('聊天失败', error.message);
  } finally {
    scheduleRemember(key); // 这段聊天安静下来后再提取长期记忆
    batcher.done(key); // 处理期间攒下的消息接着走下一批
  }
}

// 同一会话里连发的消息攒成一批；私聊窗口短、群聊窗口长，最长等 maxWaitMs。
// 聚合器已保证同一会话串行，所以这里直接起任务，无需再排队。
const batcher = createBatcher((key, batch) => {
  handleBatch(key, batch).catch(error => log('批次处理失败', error.message));
});

async function handleMessage(event: QQEvent, text: string) {
  const key = sessionKey(event);
  if (text === '/清空') {
    sessionOf(key).clear();
    await sendReply(event, '上下文已清空。');
    return;
  }
  // 群里用「群名片或昵称(QQ号)」标注发言人，私聊直接用昵称；字段缺失时退回 QQ 号。
  const group = event.message_type === 'group';
  const name = event.sender?.card?.trim() || event.sender?.nickname?.trim() || '';
  const prefix = group ? `${name || '未知'}(${event.user_id})` : (name || String(event.user_id));
  latest.set(key, event);
  batcher.push(key, { prefix, text, uid: String(event.user_id), segments: event.message ?? [] });
  // 记下说话人和消息 ID，供这段聊天结束后的记忆提取做追溯。
  const refs = memoryRefs.get(key) ?? [];
  refs.push({ mid: event.message_id, uid: String(event.user_id), name: name || String(event.user_id) });
  memoryRefs.set(key, refs.slice(-40));
}

connect((event, text) => {
  handleMessage(event, text).catch(error => log('处理失败', error.message));
});

// 记忆库状态只在启动时报一次，装不上原生模块时这里就能看出来。
memoryStats().then(stats => log('长期记忆', stats)).catch(error => log('长期记忆状态未知', error.message));
