// 会话存档：每个会话一个 JSONL 文件，追加写入，只加不改。
// 记录类型：turn（用户消息）/ reply（模型回复）/ summary（压缩摘要）/ drop（兜底裁剪）/ clear（清空）。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Message } from './agent.ts';

export type Record_ =
  | { type: 'turn'; t: number; prefix?: string; text: string }
  | { type: 'reply'; t: number; text: string }
  | { type: 'summary'; t: number; text: string; dropped: number }
  | { type: 'drop'; t: number; dropped: number }
  | { type: 'clear'; t: number }
  // 意图识别判定不参与的消息：只归档留证，不进模型上下文。
  | { type: 'skip'; t: number; prefix?: string; text: string; reason: string };

export type Session = {
  key: string;
  file: string;
  messages: Message[];  // 上下文窗口，压缩后只剩最近若干条
  summary: string;      // 被压缩掉的那段历史
  user(prefix: string | undefined, text: string): void;
  reply(text: string): void;
  skip(prefix: string | undefined, text: string, reason: string): void;
  summarize(text: string, drop: number): void;
  trim(keep: number): void;
  clear(): void;
};

const dir = process.env.SESSION_DIR || 'data/sessions';
const pathOf = (key: string) => `${dir}/${createHash('sha1').update(key).digest('hex').slice(0, 16)}.jsonl`;
// 群聊里发言人的标注来自 NapCat 推送的 sender（群名片优先），缺字段时退回 QQ 号。
// 旧存档只有 uid，用 `[QQ 123]` 复原；批量消息自带时间与发言人，重复的前缀会被去掉。
const asMessage = (text: string, prefix?: string): Message => {
  if (!prefix) return { role: 'user', content: text };
  // 批量消息每行都是「时间 发言人：内容」，此时外层前缀是重复的。
  const name = prefix.replace(/\(\d+\)$/, '');
  const lines = text.split('\n');
  const attributed = lines.length > 1 && lines.every(line =>
    /^\d{2}:\d{2}:\d{2} /.test(line) && (line.includes(`${prefix}：`) || line.includes(`${name}：`)));
  return { role: 'user', content: attributed ? text : `[${prefix}] ${text}` };
};

// 打开会话：重放 JSONL 恢复上下文，之后每条记录都追加到文件尾。
export function openSession(key: string): Session {
  mkdirSync(dir, { recursive: true });
  const file = pathOf(key);
  const append = (record: Record_) => appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  const session: Session = {
    key, file, messages: [], summary: '',
    user(prefix, text) {
      append({ type: 'turn', t: Date.now(), prefix, text });
      session.messages.push(asMessage(text, prefix));
    },
    reply(text) {
      append({ type: 'reply', t: Date.now(), text });
      session.messages.push({ role: 'assistant', content: text });
    },
    skip(prefix, text, reason) {
      append({ type: 'skip', t: Date.now(), prefix, text, reason });
    },
    summarize(text, drop) {
      append({ type: 'summary', t: Date.now(), text, dropped: drop });
      session.summary = text;
      session.messages.splice(0, drop); // 被压缩的原文仍留在 JSONL 里可查。
    },
    trim(keep) {
      const drop = Math.max(0, session.messages.length - keep);
      if (!drop) return;
      append({ type: 'drop', t: Date.now(), dropped: drop });
      session.messages.splice(0, drop);
    },
    clear() {
      append({ type: 'clear', t: Date.now() });
      session.messages = [];
      session.summary = '';
    },
  };

  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let record: Record_;
      try { record = JSON.parse(line); } catch { continue; } // 崩溃可能留下半行，跳过。
      // 旧格式只存了 uid，用 `[QQ 123]` 复原，保证老存档还能重放。
      if (record.type === 'turn') {
        const prefix = record.prefix ?? ((record as any).uid !== undefined ? `QQ ${(record as any).uid}` : undefined);
        session.messages.push(asMessage(record.text, prefix));
      }
      else if (record.type === 'reply') session.messages.push({ role: 'assistant', content: record.text });
      else if (record.type === 'summary') {
        session.summary = record.text;
        // 重放时把已被压缩掉的原文一并去掉，内存与存档才一致。
        if (record.dropped > 0) session.messages.splice(0, record.dropped);
      } else if (record.type === 'drop') session.messages.splice(0, record.dropped);
      else if (record.type === 'clear') { session.messages = []; session.summary = ''; }
    }
  }
  return session;
}
