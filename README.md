# QQbot

单 QQ、单 Agent，使用 TypeScript 和 Node.js 原生 fetch / WebSocket。除了长期记忆用的 LanceDB，没有别的第三方依赖。

## 文件结构

- `bot.ts`：启动入口、消息队列、会话记录及事件消费。
- `src/agent.ts`：OpenAI 兼容模型调用、超预算时的摘要压缩、模型事件流。
- `src/store.ts`：会话 JSONL 存档，追加写入并在启动时重放恢复上下文。
- `src/batch.ts`：同一会话的消息聚合（debounce + 最长等待 + 批量上限），并按时间/发言人格式化。
- `src/decide.ts`：意图识别，规则优先 + Flash 参与判断。
- `src/napcat.ts`：NapCat 连接、消息过滤、QQ 发送和回执、断线重连。
- `src/logger.ts`：终端与 `data/bot.log` 日志、密钥遮盖。
- `compose.yaml`：只启动第一个 NapCat，沿用原登录数据。

## 配置和启动

需要 Node.js 22.18+，Docker 和 Compose。模型配置继续使用已有 `.env`：

```dotenv
LLM_BASE_URL=https://你的模型服务/v1
LLM_API_KEY=你的密钥
LLM_MODEL=模型名
LLM_CONTEXT_TOKENS=8192
LLM_MAX_OUTPUT_TOKENS=1024
LLM_SUMMARY_TURNS=8
PROMPTS_DIR=prompts
LLM_EMBED_MODEL=doubao-embedding-vision-250328   # 不配也能跑：只跳过事件记忆的向量检索
MEMORY_ENABLED=1
MEMORY_DIR=data/memory
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_TOKEN=接口口令
```

提示词都在 `prompts/` 下的纯文本文件里，代码只负责读取和填空；每次调用前重新读盘，**改完不用重启**，下一条消息就生效。目录用 `PROMPTS_DIR` 指定（默认 `prompts`）：`system.txt` 人格设定、`decide.txt` 参与判断（`{{history}}`/`{{messages}}`）、`summary.txt` 压缩摘要（`{{history}}`）、`memory-extract.txt` / `memory-merge.txt` / `memory-inject.txt` 长期记忆的提取、合并与注入。文件缺失或为空时用内建兜底并记日志。旧的 `AGENT_PROMPT` / `AGENT_PROMPT_1` 不再读取；旧的第二、第三账号及讨论轮数配置也不再使用，其数据目录不删除。

```bash
sudo docker compose up -d napcat
npm install          # 长期记忆用到 LanceDB，会装原生二进制
npm start
```

如旧 napcat2 / napcat3 容器仍运行，先用 `sudo docker ps` 查容器名，再运行 `sudo docker stop 容器名` 停止它们；旧 bot 进程也应先 Ctrl+C，再启动当前版本。

管理页面：http://127.0.0.1:6099/webui/ ，管理口令使用 `.env` 的 `WEBUI_TOKEN`。
在 NapCat 网络配置开启正向 WebSocket 服务：监听 `0.0.0.0:3001`，消息格式 `array`，Token 与 `ONEBOT_TOKEN` 一致。

## 聊天行为

不设白名单：任何群的文字消息、任何人的私聊都会响应，无需 @。忽略自身消息。`/清空` 清除当前会话的上下文，不影响存档原文。

同一会话里连发的消息会攒成一批再处理：来一条就把定时器往后推（debounce），私聊窗口 `BATCH_PRIVATE_MS`（默认 2.5 秒）、群聊 `BATCH_GROUP_MS`（默认 5 秒）；单批最多等 `BATCH_MAX_WAIT_MS`（默认 10 秒），防止一直连发导致永不处理；攒够 `BATCH_MAX_BATCH`（默认 10 条）立即处理。

窗口大小取决于"人打字有多慢"：实测有人两句话之间隔 3.8 秒，窗口只要小于它，一句话就会被切成两次回复。**处理期间（意图判断 + 模型请求）该会话的新消息不会再另起一批**，而是攒着等本次处理结束后立刻补冲一次，所以同一会话始终串行、也不会一边判断一边被新消息插队。不同会话之间可以并发。一批合成一条上下文消息，但逐行保留时间与发言人，模型能看出这是连续发送而不是一句话：

```
13:21:01 小明(123)：我今天
13:21:02 小明(123)：去公司
13:21:03 小明(123)：发现老板没来
```

批量消息每行已带时间和发言人，落盘时不再套外层 `[发言人]` 前缀；旧存档里被套过的记录在重放时会自动去掉重复的那层。

模型事件：`model.started` → 可选 `model.reasoning` → `model.completed` → `reply`。入口消费事件、发送 QQ，确认成功后写入回复。请求或发送失败只记日志，不自动补发，下一条消息仍可继续；用户消息已经落盘，不会因为失败而丢失。

## 意图识别

消息进入主 Agent 之前先判断"要不要参与"：`QQ消息 → 消息聚合 → 简单规则 → Flash 参与判断 → 主 Agent`。

明确情况走规则，不调模型：私聊、群里 @ 机器人、引用机器人的消息、以及机器人在 `INTENT_ANSWER_WINDOW_MS`（默认 5 分钟）内提过问且被问的人接着回话。其余群聊闲聊交给判断模型，它只看最近 `INTENT_HISTORY`（默认 6 条）对话和当前这批消息，**只回一个 `true` / `false`**（参与 / 不参与），不写回复内容；回复内容由主 Agent 负责。判断模型的原始输出会记进日志。改判断尺度直接编辑 `prompts/decide.txt`。

规则和判断模型都是**按整批**给一个答案，不是逐条给答案：一批里通常有好几个人、好几条消息，任意一行 @ 了机器人或引用了机器人，都算在跟机器人说话（消息段随每批一起保留到判断层，不只看最新那条）。所以一批里既有该接的、也有不该接的（比如别人俩正好在一对一约时间）时，判断标准是"**这批里有没有一条值得接**"：有就说话，由主 Agent 自己挑该接的那句、忽略其余的；一条都没有才沉默。这样一次判断 + 一次生成就能覆盖一批，代价是不能做到"回 A 不回 B"。

判断模型用 `LLM_DECIDE_MODEL`（配 `LLM_DECIDE_URL`/`LLM_DECIDE_KEY`，留空则退回 `LLM_MODEL`），不负责写回复内容。判断失败、超时或返回无法解析的内容都按"不参与"处理，不会卡住也不会被它替主 Agent 决策。判定不参与的消息写进存档的 `skip` 记录（只留证，不进模型上下文）。

## 上下文与存档

每个会话一个 JSONL 文件：`data/sessions/<sha1(会话key) 前16位>.jsonl`，逐行追加、只加不改，记录类型 `turn` / `reply` / `summary` / `drop` / `clear`。群聊和私聊按来源分开，进程重启时重放文件恢复上下文和摘要。

上下文按 UTF-8 字节数保守估算 token，用到窗口的 `LLM_COMPRESS_AT`（默认 0.8）时开始压缩：把最旧的若干轮（每次至少 `LLM_SUMMARY_TURNS` 轮）交给模型压成一段摘要，每轮对话最多一次摘要调用，摘要以单独 system 消息注入；被压缩的原文仍留在 JSONL 里可查。摘要调用失败或返回空则退回纯裁剪，不影响本轮回复。模型请求超时为 60 秒，QQ 发送回执超时为 15 秒。

发言人标注取自 NapCat 推送的 `sender`：群里用「群名片或昵称(QQ号)」，私聊用昵称，字段缺失时退回 QQ 号；旧存档里 `[QQ 123]` 形式的记录仍可重放。

推理型模型会先把输出额度花在 reasoning 上：`LLM_MAX_OUTPUT_TOKENS` 太小会导致正文为空（摘要调用同样如此，它单独上限为 1024），建议不低于 1024。

日志同时写入终端与 `data/bot.log`，包含输入、模型输出、实际返回的 reasoning 字段及 QQ 回执。模型请求是非流式，完整响应到达后才显示思考和输出；无法展示接口未提供的内部过程。

> `LLM_CONTEXT_TOKENS` 按 UTF-8 字节估算，1M 字节约合 40 万 token 中文，所以填 1M 时窗口利用是保守的。这个值要和模型服务端实际开放的上下文一致。

## 长期记忆

三层记忆，各管各的：**短期会话记忆**（上面的 JSONL，管当前话题）→ **画像记忆**（人和群的长期情况，精确过滤读取）→ **事件记忆**（以前发生过什么，LanceDB 向量检索）。第一版只做四件事：记住人、记住重要事件、能更新旧记忆、只在需要时回忆。

存储用 LanceDB（`@lancedb/lancedb`，项目唯一的生产依赖），两张表都放在 `MEMORY_DIR`（默认 `data/memory`）：

| 表 | 内容 | 读取方式 |
|---|---|---|
| `profiles` | 某个人的身份、兴趣、长期状态、稳定关系，以及群的固定梗 | 按 `group_id` + `user_id` + `type` **精确过滤**，不做向量检索 |
| `events` | 发生过/将要发生的事，带 `importance` / `confidence` / `source_message_ids` | 按 embedding 做向量检索，阈值过滤后最多取 `MEMORY_RECALL_EVENTS`（默认 2）条 |

记忆按会话隔离：`group_id` 存的是会话 key（`group:<群号>` / `private:<QQ号>`），一个群学到的画像不会漏到别的群。

**写入不是"来一条消息就 embedding"**，而是等一段聊天安静下来（`MEMORY_IDLE_MS`，默认 3 分钟）：

```
一段聊天结束 → Flash 提取候选 → 找已有相关记忆 → ADD / UPDATE / IGNORE → 写 LanceDB
```

- 库里没有任何相关记忆时直接 ADD，不再多问一次模型；有相关记忆才让它决定怎么合并。
- 信息变了要 UPDATE 旧条目而不是堆新的：已在准备考公 + "我不考公了，开始找后端工作" → 画像改成"当前主要方向：后端求职"。旧状态本身发生过，提取提示词允许另外 ADD 一条事件。
- 决策解析失败时兜底按 ADD 处理：宁可多记一条，也不要悄悄丢信息。

**证据强度**决定一条候选能去哪（群聊里别人说的话不能当本人画像）：

| evidence | 去向 |
|---|---|
| `self_statement` 本人陈述 | 可写画像，高可信 |
| `observed_event` 明确发生 | 可写事件 |
| `third_party_claim` 第三方描述 | **不能改画像**，自动降级成 `claim` 事件，可信度打折 |
| `inference` 模型推断 | 直接丢弃，不进长期事实 |

**读取要保守**，否则召回"正确"的旧信息反而把话题带偏。所以先过 Memory Gate（规则版）："我过了"、"上次那个怎么样了"、"你还记得之前那个人吗"、"老王是不是也干过这个"这类明显在接前文的才去查；"哈哈哈哈"、"好困"、"吃饭了吗"不查。命中后注入 `prompts/memory-inject.txt` 渲染的 system 消息，**只作用于本轮请求，不写进会话存档**。

`LLM_EMBED_MODEL` 不配也不影响使用：画像仍按精确过滤工作，只是事件检索自动跳过（宁可没有往事，也不要塞不相关的）。**实测**：火山方舟 coding plan 端点（`.../api/coding/v3`）只认 `doubao-embedding-vision-250328`（2048 维），`doubao-embed`、`doubao-embedding-text-240715` 都会返回 `UnsupportedModel`；标准方舟端点则可用 `doubao-embedding-text-240715` 之类。向量维度按第一次写入自动适配，**换 embedding 模型要清空 `MEMORY_DIR` 重建**。

还没做（第一版刻意不做）：遗忘曲线、复杂评分、知识图谱、自动反思。

## 本地检查

```bash
node check.mjs
```

离线模拟模型，不调用真实模型或发送 QQ 消息。
