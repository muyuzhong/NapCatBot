# QQbot

单 QQ、单 Agent，使用 TypeScript 和 Node.js 原生 fetch / WebSocket。无 SDK、无第三方依赖。

## 文件结构

- `bot.ts`：启动入口、消息队列、会话记录及事件消费。
- `src/agent.ts`：OpenAI 兼容模型调用、超预算时的摘要压缩、模型事件流。
- `src/store.ts`：会话 JSONL 存档，追加写入并在启动时重放恢复上下文。
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
AGENT_PROMPT="你的提示词"
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_TOKEN=接口口令
```

`AGENT_PROMPT` 未填写时沿用原 `AGENT_PROMPT_1`。旧的第二、第三账号及讨论轮数配置不再使用；其数据目录不删除。

```bash
sudo docker compose up -d napcat
npm start
```

如旧 napcat2 / napcat3 容器仍运行，先用 `sudo docker ps` 查容器名，再运行 `sudo docker stop 容器名` 停止它们；旧 bot 进程也应先 Ctrl+C，再启动当前版本。

管理页面：http://127.0.0.1:6099/webui/ ，管理口令使用 `.env` 的 `WEBUI_TOKEN`。
在 NapCat 网络配置开启正向 WebSocket 服务：监听 `0.0.0.0:3001`，消息格式 `array`，Token 与 `ONEBOT_TOKEN` 一致。

## 聊天行为

不设白名单：任何群的文字消息、任何人的私聊都会响应，无需 @。忽略自身消息。`/清空` 清除当前会话的上下文，不影响存档原文。

模型事件：`model.started` → 可选 `model.reasoning` → `model.completed` → `reply`。入口消费事件、发送 QQ，确认成功后写入回复。请求或发送失败只记日志，不自动补发，下一条消息仍可继续；用户消息已经落盘，不会因为失败而丢失。

## 上下文与存档

每个会话一个 JSONL 文件：`data/sessions/<sha1(会话key) 前16位>.jsonl`，逐行追加、只加不改，记录类型 `turn` / `reply` / `summary` / `drop` / `clear`。群聊和私聊按来源分开，进程重启时重放文件恢复上下文和摘要。

上下文按 UTF-8 字节数保守估算 token，用到窗口的 `LLM_COMPRESS_AT`（默认 0.8）时开始压缩：把最旧的若干轮（每次至少 `LLM_SUMMARY_TURNS` 轮）交给模型压成一段摘要，每轮对话最多一次摘要调用，摘要以单独 system 消息注入；被压缩的原文仍留在 JSONL 里可查。摘要调用失败或返回空则退回纯裁剪，不影响本轮回复。模型请求超时为 60 秒，QQ 发送回执超时为 15 秒。

发言人标注取自 NapCat 推送的 `sender`：群里用「群名片或昵称(QQ号)」，私聊用昵称，字段缺失时退回 QQ 号；旧存档里 `[QQ 123]` 形式的记录仍可重放。

推理型模型会先把输出额度花在 reasoning 上：`LLM_MAX_OUTPUT_TOKENS` 太小会导致正文为空（摘要调用同样如此，它单独上限为 1024），建议不低于 1024。

日志同时写入终端与 `data/bot.log`，包含输入、模型输出、实际返回的 reasoning 字段及 QQ 回执。模型请求是非流式，完整响应到达后才显示思考和输出；无法展示接口未提供的内部过程。

> `LLM_CONTEXT_TOKENS` 按 UTF-8 字节估算，1M 字节约合 40 万 token 中文，所以填 1M 时窗口利用是保守的。这个值要和模型服务端实际开放的上下文一致。

## 本地检查

```bash
node check.mjs
```

离线模拟模型，不调用真实模型或发送 QQ 消息。
