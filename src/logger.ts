import { appendFileSync, mkdirSync } from 'node:fs';

const env = process.env;
mkdirSync('data', { recursive: true });
// 日志同时写入终端和本地文件；屏蔽已配置的密钥，不记录请求头。
export function log(stage: string, detail: unknown = '') {
  let text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  for (const [key, value] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD)/.test(key) && value) text = text.split(value).join('[REDACTED]');
  }
  const line = `${new Date().toISOString()} [agent] ${stage} ${text}`;
  console.log(line);
  try { appendFileSync('data/bot.log', line + '\n', { mode: 0o600 }); }
  catch { console.error('日志文件写入失败'); }
}


