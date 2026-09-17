// 消息聚合：同一会话里连发的消息攒成一批再处理。
// 两条规则：新消息把定时器往后推（debounce），但总等待不超过 maxWaitMs，防止一直发导致永不处理。
// 处理期间（意图判断 + 模型请求）仍然收消息：它们并入同一批，等本次处理结束后再补发一次，
// 否则"人还在打字，前一条已经送去判断了"会把一句话拆成两次回复。
// segments 保留原始消息段：一批里可能有好几个人、好几条消息，
// 判断"有没有引用我"必须能看到每一行，而不是只有最后一行。
export type BatchMessage = { t: number; prefix: string; text: string; uid: string; segments: { type: string; data?: Record<string, any> }[] };

export type Batcher = {
  push(key: string, message: { prefix: string; text: string; uid: string; segments?: { type: string; data?: Record<string, any> }[]; t?: number }): void;
  /** 标记该会话正在处理；处理期间 push 的消息会攒着，done 时再冲一次。 */
  busy(key: string): void;
  done(key: string): void;
  pending(key: string): number;
};

type Options = {
  privateMs: number;   // 私聊 debounce 窗口
  groupMs: number;     // 群聊 debounce 窗口
  maxWaitMs: number;   // 单批最长等待
  maxBatch: number;    // 一批最多攒多少条，超过立即处理
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
};

const env = process.env;
const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

// 默认值：私聊 2.5 秒、群聊 5 秒、单批最多等 10 秒。
// 窗口取多大取决于"人打字有多慢"：实测有人两句话之间隔 3.8 秒，窗口小于它就必然被切成两批。
export const batchDefaults = {
  privateMs: num(env.BATCH_PRIVATE_MS, 2500),
  groupMs: num(env.BATCH_GROUP_MS, 5000),
  maxWaitMs: num(env.BATCH_MAX_WAIT_MS, 10000),
  maxBatch: num(env.BATCH_MAX_BATCH, 10),
};

/** 群、私聊、临时会话按来源分开，和会话存档用同一套 key。 */
export const sessionKey = (event: { message_type?: string; group_id?: number; user_id?: number }) =>
  event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id}`;

export function createBatcher(
  flush: (key: string, batch: BatchMessage[]) => void,
  options: Options = batchDefaults as Options,
): Batcher {
  const { privateMs, groupMs, maxWaitMs, maxBatch } = options;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const window = (key: string) => (key.startsWith('group:') ? groupMs : privateMs);
  const buffers = new Map<string, { items: BatchMessage[]; timer: any; flying: boolean }>();
  const bufferOf = (key: string) => {
    const existing = buffers.get(key);
    if (existing) return existing;
    const created = { items: [], timer: undefined, flying: false };
    buffers.set(key, created);
    return created;
  };

  const take = (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer || !buffer.items.length) return;
    clearTimer(buffer.timer);
    const batch = buffer.items;
    buffer.items = [];
    buffer.flying = true;
    try { flush(key, batch); }
    catch { buffer.flying = false; }
  };

  return {
    push(key, message) {
      const at = message.t ?? now();
      const buffer = bufferOf(key);
      buffer.items.push({ t: at, prefix: message.prefix, text: message.text, uid: message.uid, segments: message.segments ?? [] });
      clearTimer(buffer.timer);
      // 正在处理就攒着，由 done() 负责补发；否则按窗口/上限决定何时冲。
      if (buffer.flying) return;
      if (buffer.items.length >= maxBatch) return take(key);
      const due = buffer.items[0].t + maxWaitMs;          // 首批至今的总等待上限
      const delay = Math.min(window(key), Math.max(0, due - at));
      buffer.timer = setTimer(() => take(key), delay);
    },
    busy(key) { bufferOf(key).flying = true; },
    done(key) {
      const buffer = bufferOf(key);
      buffer.flying = false;
      if (buffer.items.length) take(key);
    },
    pending: (key) => buffers.get(key)?.items.length ?? 0,
  };
}

const two = (n: number) => String(n).padStart(2, '0');
/** 一批消息合成一条上下文消息：每行独立成句，保留时间和发言人，避免被当成一句话。 */
export function formatBatch(batch: BatchMessage[]): string {
  return batch.map(({ t, prefix, text }) => {
    const d = new Date(t);
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${prefix}：${text}`;
  }).join('\n');
}

/** 把整批的原始消息段摊平，供意图规则逐行判断（@我、引用我可能出现在任意一行）。 */
export function batchSegments(batch: BatchMessage[]): { type: string; data?: Record<string, any> }[] {
  return batch.flatMap(({ segments }) => segments);
}
