import { openSession } from './src/store.ts';
import { chatLoop } from './src/agent.ts';
import { connect, sendReply, type QQEvent } from './src/napcat.ts';
import { createBatcher, formatBatch, sessionKey, type BatchMessage } from './src/batch.ts';
import { createTracker, shouldReply } from './src/decide.ts';
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

// 一批消息处理一次：先判断要不要参与，再落盘、请求模型，发送成功了才写回复。
// 处理期间该会话的新消息由聚合器攒着，结束后再冲一次；所以一个会话同一时刻只有一批在处理。
async function handleBatch(key: string, batch: BatchMessage[]) {
  const event = latest.get(key);
  if (!event) return;
  const session = sessionOf(key);
  const text = formatBatch(batch);
  const chatKey = String(event.message_type === 'group' ? event.group_id : event.user_id);
  const participants = [...new Set(batch.map(m => m.uid))];
  batcher.busy(key);
  try {
    const decision = await shouldReply({
      selfId: String(event.self_id),
      isGroup: event.message_type === 'group',
      text,
      segments: event.message ?? [],
      participants,
      history: recentHistory(key),
    }, tracker, chatKey);

    if (!decision.reply) {
      log('不参与', { key, reason: decision.reason, source: decision.source });
      session.skip(undefined, text, `${decision.source}:${decision.reason}`);
      return;
    }
    log('参与', { key, reason: decision.reason, source: decision.source });
    log('消息聚合', { key, count: batch.length, text });
    // 整批当成一条 user 消息；每行已带时间和发言人，不再套外层前缀。
    session.user(undefined, text);
    const iterator = chatLoop(session);
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
      // 记下"我说过什么、对谁说的"，用于后续的引用与追问判断。
      const mentioned = [...result.value.reply.matchAll(/@(\d{5,})/g)].map(m => m[1]);
      tracker.sent(chatKey, messageId, result.value.reply, '我自己', mentioned.length ? mentioned : participants);
    }
  } catch (error: any) {
    log('聊天失败', error.message);
  } finally {
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
  batcher.push(key, { prefix, text, uid: String(event.user_id) });
}

connect((event, text) => {
  handleMessage(event, text).catch(error => log('处理失败', error.message));
});
