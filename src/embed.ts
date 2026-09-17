// 向量化：只用 OpenAI 兼容的 /embeddings 接口，配置缺失或调用失败都返回 null，
// 让上层退化成"没有向量"（画像仍按精确过滤工作，事件检索直接跳过）。
import { log } from './logger.ts';

const env = process.env;
const timeoutMs = Number(env.LLM_EMBED_TIMEOUT_MS || 20_000);

export const embedConfigured = () => Boolean(env.LLM_EMBED_MODEL && (env.LLM_EMBED_URL || env.LLM_BASE_URL));

export async function embed(text: string): Promise<number[] | null> {
  if (!embedConfigured()) return null;
  const base = (env.LLM_EMBED_URL || env.LLM_BASE_URL)!.replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.LLM_EMBED_KEY || env.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.LLM_EMBED_MODEL, input: [text], encoding_format: 'float' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const vector = (await response.json())?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length) throw new Error('响应里没有 embedding');
    return vector.map(Number);
  } catch (error: any) {
    log('向量化失败，本次跳过事件检索/写入', { error: error.message, chars: text.length });
    return null;
  }
}
