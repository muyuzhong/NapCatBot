// 离线功能检查：不访问模型或 QQ，不引入测试框架。
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
// 提示词从文件读，代码里不该有措辞。
const promptsDir = mkdtempSync(join(tmpdir(), 'qqbot-prompts-'));
process.env.PROMPTS_DIR = promptsDir;
writeFileSync(join(promptsDir, 'system.txt'), '检查用提示词');
writeFileSync(join(promptsDir, 'decide.txt'), '历史：{{history}}\n当前：{{messages}}\n只输出 true 或 false');
writeFileSync(join(promptsDir, 'summary.txt'), '压缩这段：\n{{history}}');
// 记忆相关的提示词同样用固定文本，测的是加载与渲染，不是措辞。
writeFileSync(join(promptsDir, 'memory-extract.txt'), 'fixture-extract\n范围：{{scope}}\n说话人：{{speakers}}\n记录：\n{{segment}}');
writeFileSync(join(promptsDir, 'memory-merge.txt'), 'fixture-merge\n已有：\n{{existing}}\n候选：\n{{candidates}}');
writeFileSync(join(promptsDir, 'memory-inject.txt'), '[记忆] 背景如下：\n{{profiles}}\n{{events}}');
process.env.BATCH_PRIVATE_MS = '2500';
process.env.BATCH_GROUP_MS = '5000';
process.env.BATCH_MAX_WAIT_MS = '10000';
process.env.BATCH_MAX_BATCH = '10';
// 记忆库也写到临时目录，检查不碰 data/。
const memoryDir = mkdtempSync(join(tmpdir(), 'qqbot-memory-'));
process.env.MEMORY_DIR = memoryDir;
process.env.MEMORY_ENABLED = '1';
process.env.LLM_EMBED_MODEL = 'mock-embed';
// 检查里让"相关记忆"的判定宽松一点，事件检索的阈值由用例显式传参控制。
process.env.MEMORY_MAX_DISTANCE = '1';

const { chatLoop, estimateSize, trimContext } = await import('./src/agent.ts');
const { openSession } = await import('./src/store.ts');
const { readableText } = await import('./src/napcat.ts');
const { batchDefaults, createBatcher, formatBatch, sessionKey } = await import('./src/batch.ts');
const { prompts } = await import('./src/prompts.ts');
const { createTracker, ruleDecision, parseJudge, shouldReply, buildJudgePrompt, batchRuleInput } = await import('./src/decide.ts');
const { memoryStats, addEvents, searchEvents, listProfiles } = await import('./src/memory.ts');
const { needMemory, recall } = await import('./src/recall.ts');
const { parseCandidates, applyEvidenceRules, parseOps, rememberSegment, buildRememberInput, createMemoryQueue } = await import('./src/remember.ts');

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
assert.ok(estimateSize([{ role: 'system', content: prompts.system }, ...long.messages]) > 819, '应已超过压缩阈值');
let summarizeCalls = 0;
const summarize = dropped => { summarizeCalls++; assert.ok(dropped.length > 0); return Promise.resolve(summaryMark); };
const started = [];
for await (const event of chatLoop(long, { onCompress: summarize })) if (event.type === 'model.started') started.push(event);
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

// 8. 意图识别：规则优先、Flash 只判参与、解析失败按不参与
const tracker = createTracker();
const base = { selfId: '2372709869', isGroup: true, text: '13:21:01 小明(1)：今天天气不错', segments: [{ type: 'text', data: { text: '今天天气不错' } }], participants: ['1'], history: [] };
const rule = (over = {}) => ruleDecision({ ...base, ...over }, tracker, '9');

// 私聊、@我、引用我 → 规则直接放行
assert.equal(rule({ isGroup: false }).reason, '私聊');
assert.equal(rule({ text: '13:21:01 小明(1)：@2372709869 在吗', segments: [{ type: 'at', data: { qq: '2372709869' } }] }).reason, '被@');
// 普通群聊闲聊 → 交给 Flash（规则返回 null）
assert.equal(rule(), null);

// 机器人刚回了某人并提问，对方接着答话 → 规则放行
tracker.sent('9', 555, '@1 你周末有空吗？', '我自己', ['1']);
assert.equal(rule({ participants: ['1'] }).reason, '在回答我的提问');
assert.equal(rule({ participants: ['2'] }), null, '别人说话不算回答');
// 引用机器人那条消息 → 规则放行（消息 ID 匹配）
assert.equal(rule({ segments: [{ type: 'reply', data: { id: 555 } }] }).reason, '引用了我');

// 解析 Flash 的结构化输出
// 只认 true / false 两个词
assert.equal(parseJudge('true'), true);
assert.equal(parseJudge('TRUE\n'), true);
assert.equal(parseJudge('false'), false);
assert.equal(parseJudge(' false '), false);
assert.equal(parseJudge('我觉得应该回复'), null, '认不出来就不能替主 Agent 决策');
assert.equal(parseJudge(''), null);
assert.equal(parseJudge('truely'), null, '不能把别的词误当成 true');

// Flash 判定：走独立的判断模型配置，且只输出参与与否
const decideCalls = [];
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  decideCalls.push({ url: String(url), model: body.model, prompt: body.messages[0].content });
  return Response.json({ choices: [{ message: { content: 'true' } }] });
};
process.env.LLM_DECIDE_MODEL = 'mock-flash';
process.env.LLM_DECIDE_URL = 'https://flash.invalid/v1';
const decided = await shouldReply({ ...base, history: [{ me: false, prefix: '小明(1)', text: '这机器人谁写的' }] }, createTracker(), '9');
assert.equal(decided.reply, true);
assert.equal(decided.source, 'flash');
assert.equal(decideCalls[0].model, 'mock-flash', '应调用判断模型而不是主模型');
assert.ok(decideCalls[0].prompt.startsWith('历史：'), '判断提示词应来自 prompts/decide.txt');
assert.ok(decideCalls[0].prompt.includes('小明(1)：这机器人谁写的'), '应带上历史发言人');
assert.ok(/只输出 true 或 false/.test(decideCalls[0].prompt), '应要求只输出 true/false');
// 判断模型挂了 → 不参与，不能卡住
globalThis.fetch = async () => new Response('boom', { status: 500 });
const failed = await shouldReply(base, createTracker(), '9');
assert.equal(failed.reply, false);
assert.ok(failed.reason.includes('判断失败'));

// 8.5 混合批次：一批里好几个人说话，规则按整批判断，而不是只看触发事件（最新那条）
const mixed = [
  { t: 1, prefix: '小刚(3)', text: '[引用]在吗', uid: '3', segments: [{ type: 'reply', data: { id: 555 } }, { type: 'text', data: { text: '在吗' } }] },
  { t: 2, prefix: '小明(1)', text: '晚上七点老地方', uid: '1', segments: [{ type: 'text', data: { text: '晚上七点老地方' } }] },
  { t: 3, prefix: '小红(2)', text: '行', uid: '2', segments: [{ type: 'text', data: { text: '行' } }] },
];
// 触发事件取最后一条（闲聊），引用在最前面那条 —— 正是"只看最后一条"会漏掉的形状
const groupEvent = { self_id: 2372709869, message_type: 'group', group_id: 9, user_id: 2, message: mixed.at(-1).segments };
const mixedInput = batchRuleInput(groupEvent, mixed, []);
assert.equal(mixedInput.text, formatBatch(mixed), '上下文里每行仍要带时间和发言人');
assert.deepEqual(mixedInput.participants, ['3', '1', '2'], '发言人取整批去重');
assert.equal(ruleDecision(mixedInput, tracker, '9')?.reason, '引用了我', '引用出现在批内任意一行都要认出来');
assert.equal(groupEvent.message.some(s => s.type === 'reply'), false, '触发事件本身没有引用 —— 只看它就会漏');

// 引用的不是机器人那条 → 不按"引用了我"放行，落回 Flash
const otherQuote = { ...groupEvent, message: [] };
const quoted999 = batchRuleInput(otherQuote, [{ ...mixed[0], segments: [{ type: 'reply', data: { id: 999 } }] }], []);
assert.equal(ruleDecision(quoted999, tracker, '9'), null, '引用别人的消息不算在跟我说话');
// 多行引用里只要有一条指向机器人就算（不能只看第一条引用）
const twoQuotes = batchRuleInput(groupEvent, [
  { ...mixed[0], segments: [{ type: 'reply', data: { id: 999 } }] },
  mixed[0],
], []);
assert.equal(ruleDecision(twoQuotes, tracker, '9')?.reason, '引用了我', '多行引用要逐条比对');

// 经聚合器走一遍：消息段要一路保留到判断层，不能被攒批丢掉
const carried = [];
const capture = createBatcher((_key, items) => carried.push(...items));
capture.push('group:9', { prefix: '小刚(3)', text: '[引用]在吗', uid: '3', segments: [{ type: 'reply', data: { id: 555 } }] });
capture.push('group:9', { prefix: '小明(1)', text: '哈哈哈哈', uid: '1', segments: [{ type: 'text', data: { text: '哈哈哈哈' } }] });
capture.busy('group:9');
capture.done('group:9');
assert.equal(carried.length, 2, '聚合器应把两条消息并成一批');
assert.equal(ruleDecision(batchRuleInput(groupEvent, carried, []), tracker, '9')?.reason, '引用了我', '经聚合器之后仍要认出第一行的引用');

// 8.6 真实提示词文件：混合批次按"有一条值得接就说话"处理
const realDecide = readFileSync('prompts/decide.txt', 'utf8');
assert.ok(realDecide.includes('{{history}}') && realDecide.includes('{{messages}}'), '真实提示词要保留两个占位符');
assert.ok(/一条[\s\S]{0,20}值得/.test(realDecide), '要写明这批里有一条值得接就说话');

// 9. 请求失败：用户消息已落盘，模型没有回复
const failing = openSession('private:2');
globalThis.fetch = async () => new Response('mock error', { status: 500 });
failing.user('小明(2)', 'fail');
await assert.rejects(async () => { for await (const event of chatLoop(failing)) {} }, /HTTP 500/);
assert.equal(failing.messages.length, 1);

// 10. 长期记忆：Gate、证据强度、ADD/UPDATE/IGNORE、精确过滤、阈值、注入
process.env.LLM_MEMORY_MODEL = 'mock-memory';
process.env.LLM_MEMORY_URL = 'https://memory.invalid/v1';

// 玩具向量：只按字符桶计数，够验证"相同的能召回、不相关的被阈值挡掉"。
const toyVector = text => {
  const vector = new Array(32).fill(0);
  for (const char of String(text)) vector[(char.codePointAt(0) ?? 0) % 32] += 1;
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => Number((value / norm).toFixed(6)));
};
let extractReply = { memories: [] };
let mergeReply = () => ({ ops: [] });
const memoryCalls = [];
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  if (String(url).endsWith('/embeddings')) return Response.json({ data: [{ embedding: toyVector(body.input[0]) }] });
  const prompt = String(body.messages?.[0]?.content ?? '');
  if (prompt.startsWith('fixture-extract')) {
    memoryCalls.push('extract');
    return Response.json({ choices: [{ message: { content: JSON.stringify(extractReply) } }] });
  }
  if (prompt.startsWith('fixture-merge')) {
    memoryCalls.push('merge');
    return Response.json({ choices: [{ message: { content: JSON.stringify(mergeReply(prompt)) } }] });
  }
  return Response.json({ choices: [{ message: { content: '你好' } }] });
};

// 10.1 Memory Gate：随口一句不翻旧账，明显在接前文才查
assert.equal(needMemory('哈哈哈哈').need, false);
assert.equal(needMemory('好困').need, false);
assert.equal(needMemory('吃饭了吗').need, false);
for (const text of ['我过了', '上次那个怎么样了', '你还记得之前那个人吗', '老王是不是也干过这个']) {
  assert.equal(needMemory(text).need, true, `应该去查记忆：${text}`);
}

// 10.2 证据强度：推断不记、第三方说法降级成事件、太不重要的不记
const candidates = parseCandidates(JSON.stringify({ memories: [
  { target: 'profile', subject: '张三', subject_id: '10001', type: 'state', content: '在准备考公', evidence: 'self_statement', importance: 0.8, confidence: 0.9 },
  { target: 'profile', subject: '张三', subject_id: '10001', type: 'interest', content: '天天打原神', evidence: 'third_party_claim', importance: 0.6, confidence: 0.6 },
  { target: 'profile', subject: '张三', subject_id: '10001', type: 'state', content: '可能想跳槽', evidence: 'inference', importance: 0.9, confidence: 0.9 },
  { target: 'event', subject: '张三', subject_id: '10001', type: 'event', content: '打了个哈欠', evidence: 'observed_event', importance: 0.1, confidence: 0.5 },
  { target: 'profile', subject: '某人', subject_id: '', type: 'identity', content: '没有 QQ 号', evidence: 'self_statement', importance: 0.8, confidence: 0.9 },
] }));
assert.equal(candidates.length, 4, '没有 QQ 号的画像要丢掉');
const ruled = applyEvidenceRules(candidates);
assert.equal(ruled.kept.length, 2, '只留本人陈述和降级后的第三方事件');
assert.equal(ruled.kept.find(item => item.content === '天天打原神').target, 'event', '第三方说法不能改画像');
assert.ok(!ruled.kept.some(item => item.evidence === 'inference'), '推断不进长期记忆');
assert.equal(parseCandidates('```json\n{"memories":[{"target":"profile","subject":"李四","subject_id":"10002","content":"后端开发"}]}\n```').length, 1, '要能容错 Markdown 围栏');
assert.equal(parseOps('{"ops":[{"op":"ADD","candidate":0}]}').length, 1);

// 10.3 ADD：库里没有相关记忆时不再问第二个模型，直接写
extractReply = { memories: [
  { target: 'profile', subject: '张三', subject_id: '10001', type: 'state', content: '正在准备考公', evidence: 'self_statement', importance: 0.8, confidence: 0.9 },
  { target: 'event', subject: '张三', subject_id: '10001', type: 'event', content: '张三说 9 月 15 日要参加字节一面', evidence: 'self_statement', importance: 0.9, confidence: 0.9 },
] };
memoryCalls.length = 0;
const added = await rememberSegment({ scope: 'group:9', segment: '14:00:00 张三(10001)：我在准备考公，9 月 15 日要面字节', speakers: [{ id: '10001', name: '张三' }], sourceIds: '111,112', participants: ['10001'] });
assert.equal(added.added, 2, '画像和事件各写一条');
assert.deepEqual(memoryCalls, ['extract'], '没有相关记忆时不该再调合并模型');

// 画像按 group + user 精确过滤，不是向量检索
assert.equal((await listProfiles('group:9', ['10001'])).length, 1);
assert.equal((await listProfiles('group:9', ['10001']))[0].content, '正在准备考公');
assert.equal((await listProfiles('group:9', ['10002'])).length, 0, '别人的画像取不到');
assert.equal((await listProfiles('group:8', ['10001'])).length, 0, '别的群取不到（会话隔离）');

// 10.4 UPDATE：信息变了改写旧记忆，而不是再加一条冲突的
extractReply = { memories: [{ target: 'profile', subject: '张三', subject_id: '10001', type: 'state', content: '不考公了，开始找后端工作', evidence: 'self_statement', importance: 0.85, confidence: 0.9 }] };
mergeReply = prompt => {
  const id = prompt.match(/\[([0-9a-f-]{36})\] profile/)?.[1];
  assert.ok(id, '合并提示词里要带已有记忆的 id');
  return { ops: [{ op: 'UPDATE', candidate: 0, existing_id: id, content: '张三当前主要方向：后端求职', confidence: 0.9 }] };
};
memoryCalls.length = 0;
const updated = await rememberSegment({ scope: 'group:9', segment: '15:00:00 张三(10001)：我不考公了，开始找后端工作', speakers: [{ id: '10001', name: '张三' }], sourceIds: '120', participants: ['10001'] });
assert.deepEqual(memoryCalls, ['extract', 'merge'], '有相关记忆时才问合并模型');
assert.equal(updated.updated, 1);
const afterUpdate = await listProfiles('group:9', ['10001']);
assert.equal(afterUpdate.length, 1, '同一个人同一个方面只该有一条');
assert.equal(afterUpdate[0].content, '张三当前主要方向：后端求职');

// 10.5 IGNORE：重复的说法不再写
extractReply = { memories: [{ target: 'profile', subject: '张三', subject_id: '10001', type: 'state', content: '在找后端工作', evidence: 'self_statement', importance: 0.7, confidence: 0.8 }] };
mergeReply = () => ({ ops: [{ op: 'IGNORE', candidate: 0, reason: '和已有记忆重复' }] });
const ignored = await rememberSegment({ scope: 'group:9', segment: '16:00:00 张三(10001)：还是在找后端', speakers: [{ id: '10001', name: '张三' }], sourceIds: '130', participants: ['10001'] });
assert.equal(ignored.ignored, 1);
assert.equal(ignored.added, 0);
assert.equal((await listProfiles('group:9', ['10001'])).length, 1, 'IGNORE 之后不该多出记录');

// 10.6 事件检索：阈值过滤 + 会话隔离
const memoryState = await memoryStats();
assert.equal(memoryState.ready, true, 'LanceDB 应可用');
assert.ok(memoryState.events >= 1, '事件应已写进 LanceDB');
const eventText = '张三说 9 月 15 日要参加字节一面';
assert.ok((await searchEvents(toyVector(eventText), { scope: 'group:9', maxDistance: 0.01 })).length >= 1, '相同向量应命中');
assert.equal((await searchEvents(toyVector('完全不相干的另一句话'), { scope: 'group:9', maxDistance: 0.01 })).length, 0, '阈值要挡掉不相关的');
assert.equal((await searchEvents(toyVector(eventText), { scope: 'group:999', maxDistance: 1 })).length, 0, '别的群搜不到');

// 10.7 召回：Gate 放行的查询能拿到画像，闲聊连查都不查
const recalled = await recall({ scope: 'group:9', speakerIds: ['10001'], text: '上次那个后来怎么样了' });
assert.ok(recalled.text?.includes('张三'), '应注入说话人的画像');
assert.ok(recalled.text.includes('张三当前主要方向：后端求职'), '注入内容要带上画像');
assert.equal(recalled.profiles, 1);
const skipped = await recall({ scope: 'group:9', speakerIds: ['10001'], text: '哈哈哈哈' });
assert.equal(skipped.text, undefined);
assert.ok(skipped.reason.includes('Gate 跳过'));

// 10.8 注入是这一轮的系统背景，不写进会话存档
const memorySession = openSession('private:77');
memorySession.user('小明', '在吗');
const injected = [];
for await (const event of chatLoop(memorySession, { memory: recalled.text })) if (event.type === 'model.started') injected.push(event);
assert.ok(injected[0].messages.some(message => message.role === 'system' && message.content.includes('张三当前主要方向')), '记忆要作为 system 消息注入');
assert.ok(!memorySession.messages.some(message => message.content.includes('张三当前主要方向')), '记忆不能写进会话存档');

// 10.9 段落组装：机器人没参与的话题也要进提取范围，说话人和消息 ID 要能对上
const segmentInput = buildRememberInput('group:9', [
  '14:00:00 小明(10002)：国庆去青岛吧',
  '14:00:20 小红(10003)：行',
  '我：带上我',
], [{ mid: 900, uid: '10002', name: '小明' }, { mid: 901, uid: '10003', name: '小红' }, { mid: 902, uid: '10002', name: '小明' }], 12);
assert.ok(segmentInput.segment.includes('国庆去青岛'), '没被回复过的话题也要在段落里');
assert.ok(segmentInput.segment.includes('我：带上我'), '机器人自己的话也要带上');
assert.deepEqual(segmentInput.speakers, [{ id: '10002', name: '小明' }, { id: '10003', name: '小红' }], '说话人按 QQ 号去重');
assert.equal(segmentInput.sourceIds, '900,901,902', '消息 ID 用于追溯');
assert.equal(buildRememberInput('group:9', ['1', '2', '3'], [], 2).segment, '2\n3', '只取最近几条');

// 10.10 真实提示词文件：占位符不能被改没了
for (const [file, placeholders] of [
  ['prompts/memory-extract.txt', ['{{scope}}', '{{speakers}}', '{{segment}}']],
  ['prompts/memory-merge.txt', ['{{existing}}', '{{candidates}}']],
  ['prompts/memory-inject.txt', ['{{profiles}}', '{{events}}']],
]) {
  const text = readFileSync(file, 'utf8');
  for (const placeholder of placeholders) assert.ok(text.includes(placeholder), `${file} 要保留 ${placeholder}`);
}

// 10.11 队列：提取成功后必须消费掉记录。旧实现拿数组长度当游标，缓冲区塞满后"新消息数"永远是 0，提取永久停摆。
const queue = createMemoryQueue(3);            // 上限 6 条
for (let i = 1; i <= 6; i++) queue.push('k', `m${i}`);
assert.equal(queue.peek('k', 2).length, 6, '够条数就该能提取');
assert.equal(queue.peek('k', 7).length, 0, '不够 min 条不提');
queue.consume('k', 6);
assert.equal(queue.size('k'), 0, '提取成功后要消费掉');
queue.push('k', 'm7');
queue.push('k', 'm8');
assert.equal(queue.peek('k', 2).length, 2, '消费之后新消息必须还能触发提取（旧实现在这里永远是 0）');
for (let i = 0; i < 10; i++) queue.push('k', `x${i}`);
assert.equal(queue.size('k'), 6, '缓冲区要有上限，不能无限涨');

// 10.12 事件 UPDATE：要真的改到 events 表，而且向量跟着内容一起换（profiles 表存在时最容易静默失败）
extractReply = { memories: [{ target: 'event', subject: '张三', subject_id: '10001', type: 'event', content: '张三 9 月 15 日要面字节', evidence: 'self_statement', importance: 0.9, confidence: 0.9 }] };
mergeReply = () => ({ ops: [{ op: 'ADD', candidate: 0 }] }); // 库里已有别的事件，这一步走合并分支
const seededEvent = await rememberSegment({ scope: 'group:9', segment: '17:00:00 张三(10001)：9 月 15 日要面字节', speakers: [{ id: '10001', name: '张三' }], sourceIds: '140', participants: ['10001'] });
assert.equal(seededEvent.added, 1, '先写一条事件');
const before = (await searchEvents(toyVector('张三 9 月 15 日要面字节'), { scope: 'group:9', maxDistance: 0.01 }))[0];
assert.ok(before, '新事件应该能按向量搜到');
extractReply = { memories: [{ target: 'event', subject: '张三', subject_id: '10001', type: 'event', content: '张三字节一面通过了', evidence: 'self_statement', importance: 0.9, confidence: 0.9 }] };
mergeReply = () => ({ ops: [{ op: 'UPDATE', candidate: 0, existing_id: before.id, content: '张三字节一面通过了' }] });
const changedEvent = await rememberSegment({ scope: 'group:9', segment: '17:30:00 张三(10001)：字节一面过了', speakers: [{ id: '10001', name: '张三' }], sourceIds: '141', participants: ['10001'] });
assert.equal(changedEvent.updated, 1, '事件 UPDATE 必须落地');
assert.equal(changedEvent.added, 0, 'UPDATE 不该再多写一条');
assert.ok((await searchEvents(toyVector('张三字节一面通过了'), { scope: 'group:9', maxDistance: 0.01 })).some(row => row.id === before.id), '内容改了向量也要跟着改，否则搜到的还是旧语义');
assert.equal((await searchEvents(toyVector('张三 9 月 15 日要面字节'), { scope: 'group:9', maxDistance: 0.01 })).filter(row => row.id === before.id).length, 0, '旧向量不该再命中');

// 10.13 UPDATE 只能改这次真正检索出来的记忆，凭空给的 id 直接拒绝
mergeReply = () => ({ ops: [{ op: 'UPDATE', candidate: 0, existing_id: '00000000-0000-0000-0000-000000000000', content: '凭空改写' }] });
extractReply = { memories: [{ target: 'event', subject: '张三', subject_id: '10001', type: 'event', content: '张三又去面试了', evidence: 'self_statement', importance: 0.8, confidence: 0.8 }] };
const bogus = await rememberSegment({ scope: 'group:9', segment: '18:00:00 张三(10001)：又去面了一家', speakers: [{ id: '10001', name: '张三' }], sourceIds: '142', participants: ['10001'] });
assert.ok(bogus.dropped.some(text => text.includes('UPDATE 目标不在候选里')), '凭空给的 id 要被拒绝');

console.log('检查通过：事件顺序、消息段转换(@/图片/表情)、消息聚合(debounce/最长等待/批量上限/处理中续批)、意图识别(规则/判断模型/降级/混合批次按整批判断)、长期记忆(Gate/证据强度/ADD/UPDATE/IGNORE/精确过滤/阈值/注入隔离/队列消费/事件向量更新)、发言人标注、80% 阈值压缩、摘要落盘与重启恢复、旧存档兼容、请求失败。');
