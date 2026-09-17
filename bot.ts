import { openSession } from './src/store.ts';
import { chatLoop } from './src/agent.ts';
import { connect, sendReply, type QQEvent } from './src/napcat.ts';
import { log } from './src/logger.ts';

// 单 Agent；入口负责会话隔离、串行调度和消费模型事件。
const sessions = new Map<string, ReturnType<typeof openSession>>();
const sessionOf = (key: string) => {
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = openSession(key);
  sessions.set(key, session);
  return session;
};

async function handleMessage(event: QQEvent, text: string) {
  const group = event.message_type === 'group';
  // 会话 key 直接用来源 ID，群、私聊、临时会话天然分开。
  const key = group ? `group:${event.group_id}` : `private:${event.user_id}`;
  const session = sessionOf(key);
  if (text === '/清空') {
    session.clear();
    await sendReply(event, '上下文已清空。');
    return;
  }
  // 群里用「群名片或昵称(QQ号)」标注发言人，私聊直接用昵称；字段缺失时退回 QQ 号。
  const name = event.sender?.card?.trim() || event.sender?.nickname?.trim() || '';
  const speaker = group ? `${name || '未知'}(${event.user_id})` : (name || String(event.user_id));
  // 消息先落盘再请求模型：模型或发送失败都不会丢掉用户这句话。
  session.user(speaker, text);
  try {
    const iterator = chatLoop(session);
    let result = await iterator.next();
    while (!result.done) {
      const item = result.value;
      log(item.type, item.type === 'reply' ? item.text : item);
      if (item.type === 'reply') await sendReply(event, item.text); // 发送失败时不写入历史
      result = await iterator.next();
    }
    if (result.value?.reply) session.reply(result.value.reply);
  } catch (error: any) {
    log('聊天失败', error.message);
  }
}

// ponytail: 全局串行；确需多个会话并发时再拆成会话队列。
let pending = Promise.resolve();
connect((event, text) => {
  pending = pending.then(() => handleMessage(event, text)).catch(error => log('处理失败', error.message));
});
