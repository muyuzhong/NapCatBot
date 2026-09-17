import { log } from './logger.ts';

export type QQEvent = {
  post_type?: string; message_type?: string; user_id?: number; self_id?: number;
  group_id?: number; message_id?: number;
  message?: { type: string; data?: Record<string, any> }[];
  // NapCat 推送里带着发送者昵称和群名片，组上下文时用它代替纯 QQ 号。
  sender?: { user_id?: number; nickname?: string; card?: string; role?: string };
  echo?: string; status?: string; retcode?: number; wording?: string;
};
const env = process.env;
let socket: WebSocket;
const receipts = new Map<string, { socket: WebSocket; finish: (error?: Error) => void }>();

// send() 只代表提交到连接；必须等待 echo 对应的成功回执，才算本次回复完成。
export async function sendReply(event: QQEvent, text: string) {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('NapCat 未连接');
  const echo = crypto.randomUUID();
  log( 'QQ 发送，等待回执', { echo, group: event.group_id, user: event.user_id, text });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('QQ 发送回执超时')), 15_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      receipts.delete(echo);
      log( error ? 'QQ 发送失败' : 'QQ 发送成功', { echo, error: error?.message });
      error ? reject(error) : resolve();
    };
    receipts.set(echo, { socket: ws, finish });
    const group = event.message_type === 'group';
    try {
      ws.send(JSON.stringify({ action: group ? 'send_group_msg' : 'send_private_msg', params: {
        ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
        message: [{ type: 'text', data: { text } }],
      }, echo }));
    } catch { finish(new Error('QQ 发送失败')); }
  });
}

// 只取能读懂的部分：文字原样，@ 转成 @QQ号（这样模型知道有没有被叫到），
// 其余类型转成占位符，让模型知道"这里还有个东西"而不是当作没发生。
export function readableText(segments: { type: string; data?: Record<string, any> }[]): string {
  return segments.map(segment => {
    const data = segment.data ?? {};
    switch (segment.type) {
      case 'text': return typeof data.text === 'string' ? data.text : '';
      case 'at': return data.qq === 'all' ? '@全体成员' : `@${data.qq}`;
      case 'image': return '[图片]';
      case 'face': return `[表情${data.id ?? ''}]`;
      case 'reply': return '[引用]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'file': return `[文件${data.name ? ' ' + data.name : ''}]`;
      case 'forward': return '[合并转发]';
      case 'json': case 'xml': return '[卡片消息]';
      default: return `[${segment.type}]`;
    }
  }).join('').trim();
}

export function connect(onMessage: (event: QQEvent, text: string) => void) {
  const url = new URL(env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001');
  url.searchParams.set('access_token', env.ONEBOT_TOKEN!);
  const ws = new WebSocket(url);
  socket = ws;
  ws.addEventListener('open', () => log('已连接 NapCat'));
  ws.addEventListener('message', ({ data }) => {
    let event: QQEvent;
    try { event = JSON.parse(String(data)); } catch { return; }
    if (!event || typeof event !== 'object') return;
    // 回执立即处理，不能排在等待它的聊天任务后面。
    if (event.echo) {
      log('QQ 回执', { echo: event.echo, status: event.status, retcode: event.retcode, wording: event.wording });
      const receipt = receipts.get(event.echo);
      if (receipt?.socket === ws) receipt.finish(event.status === 'ok' ? undefined : new Error(`QQ 发送失败: ${event.retcode}`));
      return;
    }
    if (event.post_type !== 'message' || String(event.user_id) === String(event.self_id) || !Array.isArray(event.message)) return;
    // 不设白名单，任何群聊和私聊都响应；上一行的 self_id 判断已排除机器人自己。
    const text = readableText(event.message);
    if (!text) return; // 完全读不出内容（纯图片也会读成 [图片]，不会走到这里）
    log('新消息入队', { group: event.group_id, user: event.user_id, text });
    onMessage(event, text);
  });
  ws.addEventListener('error', () => log('WebSocket 连接失败'));
  ws.addEventListener('close', () => {
    for (const receipt of receipts.values()) if (receipt.socket === ws) receipt.finish(new Error('QQ 连接断开'));
    log('连接断开，5 秒后重连');
    setTimeout(() => connect(onMessage), 5000);
  });
}
