// 离线功能检查：不访问模型或 QQ，不引入测试框架。
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 会话存档写到临时目录，检查不碰 data/。
const sessionDir = mkdtempSync(join(tmpdir(), 'qqbot-check-'));
process.env.SESSION_DIR = sessionDir;
process.env.LLM_BASE_URL = 'https://mock.invalid/v1';
process.env.LLM_CONTEXT_TOKENS = '1280';
process.env.LLM_MAX_OUTPUT_TOKENS = '256';
process.env.LLM_COMPRESS_AT = '0.8';
process.env.LLM_SUMMARY_TURNS = '4';
process.env.AGENT_PROMPT = '检查用提示词';
process.env.BATCH_PRIVATE_MS = '2500';
process.env.BATCH_GROUP_MS = '5000';
process.env.BATCH_MAX_WAIT_MS = '10000';
process.env.BATCH_MAX_BATCH = '10';

const { chatLoop, estimateSize, trimContext } = await import('./src/agent.ts');
const { openSession } = await import('./src/store.ts');
const { readableText } = await import('./src/napcat.ts');
const { batchDefaults, createBatcher, formatBatch, sessionKey } = await import('./src/batch.ts');

const summaryMark = '【摘要】前面在聊测试。';
const requests = [];
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  const content = body.messages.length === 1 ? summaryMark : '你好';
  return Response.json({ choices: [{ message: { content, reasoning_content: '模拟字段' }, finish_reason: 'stop' }] });
};

// 1. 事件顺序、请求体、发言人标注
const session = openSession('private:1');
session.user('小明(1)', 'hello');
const events = [];
for await (const event of chatLoop(session)) events.push(event);
assert.deepEqual(events.map(e => e.type), ['model.started', 'model.reasoning', 'model.completed', 'reply']);
assert.equal(events.at(-1).history.at(-1).content, '你好');
assert.equal(requests[0].messages.length, 2); // system + 本次输入
assert.equal(requests[0].messages[1].content, '[小明(1)] hello');
assert.equal(requests[0].max_tokens, 256);
session.reply(events.at(-1).text);
assert.equal(readFileSync(session.file, 'utf8').trim().split('\n').length, 2); // turn + reply 各一行

// 2. 消息段转换：@ 转成 @QQ号，其余类型转占位符
const seg = (type, data) => ({ type, data });
assert.equal(readableText([seg('at', { qq: '2372709869' }), seg('text', { text: ' 在吗' })]), '@2372709869 在吗');
assert.equal(readableText([seg('at', { qq: 'all' })]), '@全体成员');
assert.equal(readableText([seg('text', { text: '看这个' }), seg('image', { file: 'a.jpg' })]), '看这个[图片]');
assert.equal(readableText([seg('reply', { id: 1 }), seg('text', { text: '同意' }), seg('face', { id: 21 })]), '[引用]同意[表情21]');
assert.equal(readableText([]), '');

// 3. 消息聚合：debounce、最长等待、批量上限、格式化
// 假时钟：每个用例一个实例，避免定时器互相干扰
const makeClock = () => {
  let t = 0; let id = 0; const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const handle = ++id; timers.set(handle, { at: t + ms, fn }); return handle; },
    clearTimer: handle => timers.delete(handle),
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = target;
    },
  };
};
// 每个用例一套独立的时钟 + 聚合器，免得定时器跨用例互相干扰
const freshBatcher = () => {
  const clock = makeClock();
  const flushed = [];
  const batcher = createBatcher((key, batch) => flushed.push({ key, batch: [...batch] }),
    { ...batchDefaults, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const push = (key, prefix, text, uid = '1') => batcher.push(key, { prefix, text, uid });
  return { clock, flushed, push, batcher };
};

// 单条：窗口期满后处理
{
  const { clock, flushed, push } = freshBatcher();
  push('group:1', '小明(1)', '我今天');
  clock.advance(4999);
  assert.equal(flushed.length, 0, '窗口内不应处理');
  clock.advance(2);
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].batch.map(m => m.text), ['我今天']);
}

// 连发：每条都重新计时，最后一起处理（实测有人两句话隔 3.8 秒）
{
  const { clock, flushed, push } = freshBatcher();
  push('group:1', '小明(1)', '我今天');
  clock.advance(4000);
  push('group:1', '小明(1)', '去公司');
  clock.advance(1000);
  push('group:1', '小明(1)', '发现老板没来');
  clock.advance(4999);
  assert.equal(flushed.length, 0, '持续来消息时应一直推后');
  clock.advance(2);
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].batch.map(m => m.text), ['我今天', '去公司', '发现老板没来'], '应攒成一批');
}

// 最长等待：一直连发也必须在 maxWaitMs 内处理掉
{
  const { clock, flushed, push } = freshBatcher();
  push('group:1', '小明(1)', 'a');
  for (let i = 0; i < 5; i++) { clock.advance(3001); push('group:1', '小明(1)', `续${i}`); }
  assert.equal(flushed.length, 1, '超过最长等待后应强制处理，即使还在连发');
  assert.deepEqual(flushed[0].batch.map(m => m.text), ['a', '续0', '续1', '续2'], '按 10 秒上限，攒到第 4 条时强制处理');
}

// 私聊窗口比群聊短
{
  const { clock, flushed, push } = freshBatcher();
  push('private:1', '小明', '在吗');
  clock.advance(2499);
  assert.equal(flushed.length, 0, '私聊窗口内不应处理');
  clock.advance(2);
  assert.equal(flushed.length, 1);
}

// 处理期间到达的消息：并回同一批，处理结束后补冲一次
{
  const { clock, flushed, push, batcher } = freshBatcher();
  push('group:1', '小明(1)', '你知不知道');
  clock.advance(5001);
  assert.deepEqual(flushed[0].batch.map(m => m.text), ['你知不知道']);
  batcher.busy('group:1');            // 模拟进入判断/请求阶段
  push('group:1', '小明(1)', '这个新群友');
  push('group:1', '小明(1)', '的名字');
  clock.advance(3000);
  assert.equal(flushed.length, 1, '处理期间不应再冲批次');
  batcher.done('group:1');            // 处理结束 → 续批立刻冲
  assert.deepEqual(flushed[1].batch.map(m => m.text), ['这个新群友', '的名字']);
  assert.equal(batcher.pending('group:1'), 0);
}

// 批量上限：攒够立即处理，不等窗口
{
  const { flushed, push } = freshBatcher();
  for (let i = 0; i < 10; i++) push('group:2', '小红(2)', `连发${i}`, '2');
  assert.equal(flushed.at(-1).batch.length, 10, '达到上限应立即处理');
}

// 会话 key：群和私聊分开
assert.equal(sessionKey({ message_type: 'group', group_id: 9 }), 'group:9');
assert.equal(sessionKey({ message_type: 'private', user_id: 8 }), 'private:8');

// 3. 纯函数裁剪：旧问答成对删除，系统提示与最新一条保留
const system = { role: 'system', content: 'test' };
const latest = { role: 'user', content: 'latest' };
assert.deepEqual(trimContext([system, { role: 'user', content: 'x'.repeat(2000) }, { role: 'assistant', content: 'ok' }, latest], 200), [system, latest]);
assert.throws(() => trimContext([system, { role: 'user', content: 'x'.repeat(2000) }], 200));

// 4. 到 80% 就压缩：调一次模型出摘要、旧记录被替换、摘要落盘
const long = openSession('group:9');
for (let i = 0; i < 12; i++) {
  long.user(`群友${i}(${100 + i})`, `第${i}条 ${'x'.repeat(200)}`);
  long.reply('收到');
}
// 预算 1280-256=1024，阈值 80% = 819
assert.ok(estimateSize([{ role: 'system', content: process.env.AGENT_PROMPT }, ...long.messages]) > 819, '应已超过压缩阈值');
let summarizeCalls = 0;
const summarize = dropped => { summarizeCalls++; assert.ok(dropped.length > 0); return Promise.resolve(summaryMark); };
const started = [];
for await (const event of chatLoop(long, summarize)) if (event.type === 'model.started') started.push(event);
assert.equal(summarizeCalls, 1, '每轮最多压缩一次');
assert.equal(requests.at(-1).messages[1].content, `[前情摘要] ${summaryMark}`);
assert.ok(estimateSize(started.at(-1).messages) <= 819, '压缩后应回落到阈值以内');
assert.ok(long.summary === summaryMark, '摘要应写回会话');
assert.ok(readFileSync(long.file, 'utf8').includes('"type":"summary"'), '摘要应落盘');

// 5. 重启恢复：上下文和摘要都还在，且被压掉的原文不会复活
const reopened = openSession('group:9');
assert.equal(reopened.summary, summaryMark);
assert.deepEqual(reopened.messages, long.messages);

// 6. /清空 后上下文为空，重开仍是空的
reopened.clear();
assert.equal(reopened.messages.length, 0);
assert.equal(reopened.summary, '');
assert.equal(openSession('group:9').messages.length, 0);

// 7. 旧格式存档（只有 uid）仍能重放成 `[QQ 123] 文本`
const { createHash } = await import('node:crypto');
const legacyFile = join(sessionDir, `${createHash('sha1').update('group:7').digest('hex').slice(0, 16)}.jsonl`);
appendFileSync(legacyFile, JSON.stringify({ type: 'turn', t: 1, uid: 42, text: '老记录' }) + '\n');
assert.equal(openSession('group:7').messages[0].content, '[QQ 42] 老记录');

// 8. 请求失败：用户消息已落盘，模型没有回复
const failing = openSession('private:2');
globalThis.fetch = async () => new Response('mock error', { status: 500 });
failing.user('小明(2)', 'fail');
await assert.rejects(async () => { for await (const event of chatLoop(failing)) {} }, /HTTP 500/);
assert.equal(failing.messages.length, 1);

console.log('检查通过：事件顺序、消息段转换(@/图片/表情)、消息聚合(debounce/最长等待/批量上限/处理中续批)、发言人标注、80% 阈值压缩、摘要落盘与重启恢复、旧存档兼容、请求失败。');
