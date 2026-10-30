# MOSS 前后端对接文档

> 本文档以当前代码为唯一真相源：`src/modules/server/index.ts`（158 条 REST 路由）、`src/modules/remote/index.ts`（10 条，合计 168 条）、`src/modules/server/ws-handler.ts`（20 种 WS 入站消息）。接口变更时请同步更新本文件。
>
> 系统**不存在插件机制**，没有 `/api/plugins`、`/api/extensions`；扩展能力通过模组、Skill、Command、MCP 提供。
>
> 配套文档：[architecture.md](./architecture.md)（系统总览、模组与数据持久化）

---

## 一、通用约定

### 1.1 通信通道

| 通道 | 用途 | 协议 |
|---|---|---|
| HTTP REST | 配置、Provider、会话、任务、Agent 注册表、子代理、MCP、Skill/Command、自动化、文件系统、终端、浏览器/桌面、日志、上下文、规则/钩子/记忆、语音、远程访问 | `/api/*`，JSON |
| WebSocket | 流式任务、ask/confirm 回复、任务/终端/语音/自动化/AI 诊断 | `/ws`，JSON 帧 |
| MCP over HTTP | 对外暴露 MOSS 工具（`mcpServer.enabled`） | `/mcp` |
| MCP over stdio | `moss mcp` 供 Claude Desktop / Cursor 等客户端调用 | stdio |

### 1.2 鉴权

- 配置项：`config.security.authToken`（空字符串表示无需鉴权）
- HTTP：请求头 `Authorization: Bearer <token>`；前端从 `localStorage['moss-token']` 读取并自动注入
- WebSocket：同源信任，不强制 Token；远程访问开启时由 `RemoteGuard` 在升级握手前校验远程密码 cookie
- 免鉴权例外：`GET /api/health`、`GET /api/version`、`GET /api/filesystem/media`（query token 校验）、`GET /api/voice/wasm/*`（浏览器加载器直接请求）

### 1.3 统一响应格式

**成功**：HTTP 200，body 为业务数据 JSON。

**错误**：HTTP 4xx/5xx，body 统一为：

```json
{ "error": "错误描述" }
```

### 1.4 CORS

后端已开启（`Access-Control-Allow-Origin: *`），开发模式由 Vite 代理 `/api` + `/ws` → 7766。

### 1.5 日期格式

所有时间字段统一使用 ISO 8601 字符串（如 `2026-08-06T11:21:00.000Z`）。

---

## 二、HTTP REST 接口

以下按业务域分组，共 **168 条**（server 158 + remote 10）。列 `/api/*` 均省略前缀。

### 2.1 健康与版本

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 服务状态、运行时长、模块数量与状态 |
| GET | `/api/version` | 否 | 版本、channel、buildDate（读取根 `package.json`） |

**`GET /api/health` 响应**：

```ts
{
  status: 'ok';
  timestamp: string;
  services: string[];
  uptime: number;
  modules: number;
  moduleStates: Record<string, string>;
}
```

**`GET /api/version` 响应**：

```ts
{ version: string; channel: string; buildDate?: string }
```

### 2.2 应用与模型配置

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/config` | 是 | 读取 AppConfig |
| PUT | `/api/config` | 是 | 更新 AppConfig（部分字段） |
| GET | `/api/api-config` | 是 | 读取 ApiConfig（providers 结构） |
| PUT | `/api/api-config` | 是 | 更新 ApiConfig |

### 2.3 Provider 与模型

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/providers` | 是 | Provider/模型总览与当前选择 |
| PUT | `/api/providers/current` | 是 | 设置当前模型 |
| PUT | `/api/providers/search-current` | 是 | 设置当前联网搜索服务商 |
| PUT | `/api/providers/reorder` | 是 | Provider 排序 |
| POST | `/api/providers` | 是 | 新建 Provider |
| PATCH | `/api/providers/:id` | 是 | 更新 Provider |
| DELETE | `/api/providers/:id` | 是 | 删除 Provider |
| POST | `/api/providers/:id/models` | 是 | 添加模型 |
| POST | `/api/providers/:id/models/fetch` | 是 | 从远端拉取模型列表 |
| POST | `/api/providers/:id/balance` | 是 | 查询余额 |
| POST | `/api/providers/:id/models/:modelId/test` | 是 | 测试模型可用性 |
| PATCH | `/api/providers/:id/models/:modelId` | 是 | 更新模型 |
| DELETE | `/api/providers/:id/models/:modelId` | 是 | 删除模型 |
| POST | `/api/providers/:id/services` | 是 | 添加服务（搜索 / 语音等服务商项） |
| PATCH | `/api/providers/:id/services/:serviceId` | 是 | 更新服务 |
| DELETE | `/api/providers/:id/services/:serviceId` | 是 | 删除服务 |

### 2.4 会话

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/session` | 是 | 会话列表 |
| GET | `/api/session/:id` | 是 | 会话历史消息 |
| DELETE | `/api/session/:id` | 是 | 删除会话 |
| GET | `/api/session/:id/state` | 是 | 会话运行状态快照（与 `task.switch` 回复同构） |
| GET | `/api/sessions/:id/context` | 是 | 上下文文件与 token 占用 |
| GET | `/api/sessions/:id/truncate-preview` | 是 | 撤回预览（待删除消息范围） |
| POST | `/api/sessions/:id/truncate` | 是 | 撤回消息 |
| POST | `/api/sessions/:id/truncate-restore` | 是 | 恢复撤回 |
| POST | `/api/sessions/:id/regenerate-target` | 是 | 计算重新生成目标 |

### 2.5 MCP

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/mcp/servers` | 是 | MCP 服务器列表与状态 |
| GET | `/api/mcp/tools` | 是 | 工具列表（可按 server 过滤） |
| POST | `/api/mcp/call` | 是 | 调用 MCP 工具 |
| POST | `/api/mcp/connect` | 是 | 连接服务器 |
| POST | `/api/mcp/disconnect` | 是 | 断开服务器 |
| POST | `/api/mcp/servers` | 是 | 新增服务器配置 |
| PUT | `/api/mcp/servers/:name` | 是 | 更新服务器配置 |
| DELETE | `/api/mcp/servers/:name` | 是 | 删除服务器配置 |

另有对外 MCP Server 端点 `/mcp`（HTTP，`mcpServer.enabled` 时启用），不属于 `/api` REST 路由。

### 2.6 Skill / Command / 工具

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/skills` | 是 | Skill 列表 |
| GET | `/api/skills/:name` | 是 | Skill 详情 |
| PATCH | `/api/skills/:name` | 是 | 启停 Skill |
| POST | `/api/skills` | 是 | 新建 Skill |
| POST | `/api/skills/import` | 是 | 导入 Skill |
| GET | `/api/commands` | 是 | 自定义命令列表 |
| POST | `/api/commands` | 是 | 新建命令 |
| PUT | `/api/commands/:name` | 是 | 更新命令内容 |
| DELETE | `/api/commands/:name` | 是 | 删除命令 |
| PATCH | `/api/commands/:name` | 是 | 启停命令 |
| GET | `/api/tools` | 是 | 内置工具列表与配置 |
| PATCH | `/api/tools/:name` | 是 | 更新工具配置 |

### 2.7 Todo 与文件历史

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/todos/:sessionId` | 是 | 读取会话 Todo |
| PUT | `/api/todos/:sessionId` | 是 | 覆盖会话 Todo |
| GET | `/api/file-history/:sessionId` | 是 | 会话文件变更历史 |
| POST | `/api/file-history/:sessionId/undo` | 是 | 撤回最近变更 |
| POST | `/api/file-history/:sessionId/restore` | 是 | 恢复被撤回变更 |

### 2.8 任务与分组

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/tasks` | 是 | 任务分组 + 任务列表（分页参数） |
| POST | `/api/tasks` | 是 | 创建任务 |
| GET | `/api/tasks/:id` | 是 | 任务详情、消息、todo、上下文文件 |
| PATCH | `/api/tasks/:id` | 是 | 更新标题 / 分组 |
| DELETE | `/api/tasks/:id` | 是 | 删除任务 |
| PUT | `/api/tasks/reorder` | 是 | 任务排序 |
| GET | `/api/task-groups` | 是 | 分组列表 |
| POST | `/api/task-groups` | 是 | 新建分组 |
| PATCH | `/api/task-groups/:id` | 是 | 重命名 / 折叠状态 |
| DELETE | `/api/task-groups/:id` | 是 | 删除分组（可迁移任务） |
| GET | `/api/search` | 是 | 任务与消息搜索（query `q`） |

### 2.9 Agent 注册表与子代理

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/agents` | 是 | Agent 列表与默认 Agent |
| POST | `/api/agents` | 是 | 新建 Agent |
| GET | `/api/agents/:id` | 是 | Agent 详情 |
| PATCH | `/api/agents/:id` | 是 | 更新 Agent |
| DELETE | `/api/agents/:id` | 是 | 删除 Agent |
| PUT | `/api/agents/default` | 是 | 设置默认 Agent |
| POST | `/api/subagents/run` | 是 | 运行一次性 subagent |

### 2.10 自动化

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/automations` | 是 | 自动化任务列表 |
| POST | `/api/automations` | 是 | 新建（cron / once） |
| GET | `/api/automations/:id` | 是 | 任务详情 |
| PATCH | `/api/automations/:id` | 是 | 更新任务 |
| DELETE | `/api/automations/:id` | 是 | 删除任务 |
| POST | `/api/automations/:id/trigger` | 是 | 立即触发 |
| POST | `/api/automations/:id/pause` | 是 | 暂停 |
| POST | `/api/automations/:id/resume` | 是 | 恢复 |
| GET | `/api/automations/:id/history` | 是 | 运行历史 |

### 2.11 文件系统

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/filesystem/resolve-paths` | 是 | 解析路径选择器结果 |
| POST | `/api/filesystem/save-attachment` | 是 | 粘贴附件落盘到 `~/.moss/agent/attachments/` |
| POST | `/api/filesystem/upload` | 是 | 上传文件到授权目录（重名 409，上限 12MB） |
| GET | `/api/filesystem/suggest-paths` | 是 | 路径补全建议 |
| GET | `/api/filesystem/search-files` | 是 | 工作目录文件名搜索（`@` 提及菜单） |
| GET | `/api/filesystem/list` | 是 | 列出目录直接子项（走 roots 权限） |
| GET | `/api/filesystem/drives` | 是 | 驱动器枚举与容量 |
| GET | `/api/filesystem/raw` | 是 | 只读文件预览（白名单 + roots 权限） |
| GET | `/api/filesystem/media` | 否 | 音视频直链（`<video>/<audio>` 无法带 Header，handler 内校验 query token） |
| GET | `/api/filesystem/text` | 是 | 通用文本提取（Office / 电子书回退） |
| GET | `/api/filesys/roots` | 是 | 授权 roots 列表 |
| PUT | `/api/filesys/roots` | 是 | 更新授权 roots |

### 2.12 终端 / 计算机 / 浏览器

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/terminal/interpreters` | 是 | 本机可用解释器类型（新建终端菜单数据源） |
| GET | `/api/computer/status` | 是 | cua-driver 安装/连接/屏幕状态 |
| GET | `/api/computer/windows` | 是 | 桌面窗口列表 |
| GET | `/api/computer/screenshot` | 是 | 实时截图（返回图片） |
| POST | `/api/computer/install` | 是 | 安装 cua-driver |
| POST | `/api/computer/control` | 是 | 暂停 / 恢复 Agent 桌面控制 |
| GET | `/api/browser/status` | 是 | 扩展桥接 / 内置 Chrome / 实例状态 |
| POST | `/api/browser/extension/open` | 是 | 打开扩展目录（供手动加载） |
| POST | `/api/browser/builtin` | 是 | 启动 / 停止内置 Chrome |
| POST | `/api/browser/chrome-for-testing` | 是 | 下载 Chrome for Testing |
| POST | `/api/browser/install` | 是 | 安装浏览器扩展 |

### 2.13 日志与系统监控

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/logs/files` | 是 | 日志文件列表 |
| GET | `/api/logs` | 是 | 日志查询（级别 / 关键字 / 分页过滤） |
| POST | `/api/logs/cleanup` | 是 | 清理过期日志 |
| GET | `/api/system-monitor/snapshot` | 是 | 系统资源 + MOSS 进程树占用快照 |

### 2.14 上下文引擎

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/context/summary-models` | 是 | 可用摘要模型列表 |
| GET | `/api/context/:sessionId/stats` | 是 | 会话上下文统计 |
| GET | `/api/context/:sessionId/compactions` | 是 | 压缩历史 |
| GET | `/api/context/:sessionId/compact-preview` | 是 | 手动压缩预览 |
| POST | `/api/context/:sessionId/compact` | 是 | 手动触发压缩 |
| GET | `/api/context/file-index/status` | 是 | 文件索引状态 |
| POST | `/api/context/file-index/rebuild` | 是 | 重建文件索引 |

### 2.15 规则 / 钩子 / 记忆

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/rules` | 是 | 规则列表（global / project 双作用域） |
| POST | `/api/rules` | 是 | 新建规则 |
| GET | `/api/rules/:id` | 是 | 规则详情 |
| PATCH | `/api/rules/:id` | 是 | 更新规则 |
| DELETE | `/api/rules/:id` | 是 | 删除规则 |
| GET | `/api/hooks` | 是 | 钩子列表 |
| POST | `/api/hooks` | 是 | 新建钩子 |
| GET | `/api/hooks/history` | 是 | 钩子执行历史 |
| GET | `/api/hooks/:id` | 是 | 钩子详情 |
| PATCH | `/api/hooks/:id` | 是 | 更新钩子 |
| DELETE | `/api/hooks/:id` | 是 | 删除钩子 |
| POST | `/api/hooks/:id/test` | 是 | 手动触发测试 |
| GET | `/api/memory/tree` | 是 | 记忆宫殿树 |
| POST | `/api/memory/distill` | 是 | 手动蒸馏 |
| GET | `/api/memory` | 是 | 记忆列表 / 搜索 |
| POST | `/api/memory` | 是 | 新建记忆 |
| GET | `/api/memory/:id` | 是 | 记忆详情 |
| PATCH | `/api/memory/:id` | 是 | 更新记忆 |
| DELETE | `/api/memory/:id` | 是 | 删除单条记忆 |
| DELETE | `/api/memory` | 是 | 批量清空 |

### 2.16 语音

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/voice/status` | 是 | 总览（开关 / 引擎 / 默认模型 / 服务商） |
| GET | `/api/voice/models` | 是 | 模型目录与安装状态 |
| POST | `/api/voice/enable` | 是 | 开关语音输入 |
| POST | `/api/voice/default-model` | 是 | 设置默认本地模型 |
| PUT | `/api/voice/provider` | 是 | 设置在线语音服务商 |
| POST | `/api/voice/models/:id/install` | 是 | 下载并安装模型 |
| DELETE | `/api/voice/models/:id` | 是 | 卸载模型 |
| GET | `/api/voice/wasm/manifest` | 否 | 浏览器 WASM 推理文件表 |
| GET | `/api/voice/wasm/data` | 否 | 模型字节流（Emscripten 加载器直接 GET） |

### 2.17 远程访问

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/remote/status` | 是 | 远程总览（LAN / 隧道 / URL / 密码状态） |
| POST | `/api/remote/enable` | 是 | 开启远程访问（热重绑 0.0.0.0） |
| POST | `/api/remote/disable` | 是 | 关闭远程访问（热重绑回环） |
| POST | `/api/remote/lan` | 是 | 局域网开关 |
| POST | `/api/remote/lan/password` | 是 | 局域网密码操作（refresh/custom/enable/disable） |
| POST | `/api/remote/lan-ip` | 是 | 手动指定局域网 IP |
| POST | `/api/remote/tunnel/start` | 是 | 启动 cloudflared 隧道 |
| POST | `/api/remote/tunnel/stop` | 是 | 停止隧道 |
| POST | `/api/remote/tunnel/password` | 是 | 公网密码操作（refresh/custom） |
| GET | `/api/remote/passwords` | 是 | 密码明文视图（仅已认证者） |

### 2.18 关键接口请求/响应

**`GET /api/session/:id/state`**

```ts
{
  sessionId: string;
  running: boolean;
  totalMessages: number;
  newestIndex: number;
  liveDraft: unknown | null;
  pendingAsks: Array<{ toolCallId: string; sessionId: string; questions: AskQuestion[] }>;
  pendingConfirms: Array<{ toolCallId: string; sessionId: string; question: string; ruleSuggestion?: string }>;
  permissionMode?: 'ask' | 'auto' | 'skip';
  lastRunStats?: RunStats;
}
```

> WebSocket `session.subscribed` 与 `task.switch` 的回复载荷是精简版快照：`{ running, runId?, totalMessages, newestIndex, liveDraft? }`（不含 pending 列表，pending 由订阅逻辑单独补发）。

**`GET /api/tasks/:id`**

```ts
{
  task: TaskItem;
  messages: TaskMessage[];
  todos: TodoItem[];
  contextFiles: ContextFile[];
  activeSkill?: string;
  permissionMode?: 'ask' | 'auto' | 'skip';
}
```

**`GET /api/providers`**

```ts
{
  providers: ProviderConfig[];
  current: string;               // 当前默认模型（config.agent.defaultModel）
  currentSearchProvider: string; // 空串 = 本地免费引擎链
}
```

**`POST /api/mcp/call`**

```ts
// 请求
{ server: string; tool: string; arguments: Record<string, unknown> }
// 响应
{ content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { data: string; mimeType: string } }>; isError?: boolean }
```

**`GET /api/automations`**

```ts
{ automations: AutomationItem[] }
```

**`GET /api/voice/status`**

```ts
// 语音服务未就绪
{ available: false }
// 已就绪
{
  available: true;
  enabled: boolean;
  runtimeAvailable: boolean;
  runtimeVersion?: string;
  platform: string;
  platformSupported: boolean;
  runtimeError?: string;
  defaultModel: string;   // 空串 = 未选择
  installed: string[];
  providerId: string;     // 空串 = 内置本地引擎
}
```

---

## 三、WebSocket 协议

### 3.1 连接

- 地址：`ws://<host>:7766/ws`
- 帧格式：`{ type: string; sessionId?: string; payload?: unknown }`
- 连接后按需发送 `session.subscribe` / `terminal.list` 订阅会话与终端；重连后服务端会补发该会话 pending ask / confirm

### 3.2 客户端 → 服务端（20 种）

| type | 用途 | payload |
|---|---|---|
| `task.stream` | 发送用户消息并启动流式任务 | `{ message, attachments?, model?, cwd?, runId?, agentId?, permissionMode?, clientMessageId? }` |
| `task.guide` | 运行中追加引导消息 | `{ message, runId?, attachments?, clientMessageId? }` |
| `task.abort` | 中断当前任务 | `{}` |
| `task.create` | 创建任务 | `{ title, groupId?, id? }` |
| `task.switch` | 切换/订阅任务会话（`taskId` 或 `sessionId`） | `{ taskId? }` |
| `session.subscribe` | 订阅会话事件与 pending ask/confirm | `{ sessionId }` |
| `tool.ask.reply` | 回复 ask 提问 | `{ toolCallId, action: 'accept' \| 'cancel', answers? }` |
| `tool.confirm.reply` | 回复工具确认 | `{ toolCallId, ok: boolean, remember?: 'session' \| 'global' }` |
| `automation.run` | 手动触发自动化 | `{ automationId }` |
| `voice.start` | 开始语音识别会话 | `{ modelId? }` |
| `voice.stop` | 结束语音识别 | `{}` |
| `terminal.list` | 列出会话终端 | `{ sessionId? }` |
| `terminal.create` | 创建终端 | `{ sessionId, cwd?, cols?, rows?, title?, interpreter?, creator? }` |
| `terminal.subscribe` | 订阅终端快照 | `{ terminalId, cols?, rows? }` |
| `terminal.input` | 写入终端输入 | `{ terminalId, data }` |
| `terminal.resize` | 调整终端尺寸 | `{ terminalId, cols, rows }` |
| `terminal.close` | 关闭终端 | `{ terminalId }` |
| `ping` | 心跳 | `{}` |
| `insight.diagnose` | 启动链路式 AI 诊断 | `{ requestId, kind: 'cause' \| 'harness' \| 'resource', sessionId?, providerError? }` |
| `insight.diagnose.cancel` | 取消诊断 | `{ requestId }` |

### 3.3 服务端 → 客户端

**任务流（AgentEvent）**

| type | payload |
|---|---|
| `user-message` | `{ content, clientMessageId, timestamp, attachments?, runId? }` |
| `assistant-text` | `{ text }` |
| `assistant-thinking` | `{ text }` |
| `tool-call-start` | `{ toolName, toolCallId, args }` |
| `tool-call-delta` | `{ toolName, toolCallId, offset, total }` |
| `tool-call-executing` | `{ toolName, toolCallId }` |
| `tool-call-end` | `{ toolName, toolCallId, result }` |
| `ask` | `{ toolCallId, questions }` |
| `ask-timeout` | `{ toolCallId }` |
| `confirm-required` | `{ toolCallId, toolName, question, ruleSuggestion? }` |
| `context-healed` | `{ toolCallId?, repaired? }` |
| `stats-updated` | `{ stats: RunStats }` |
| `error` | `{ message }` |
| `done` | `{ finishReason }` |

**任务元信息**

| type | payload |
|---|---|
| `task.created` | `{ task }` |
| `task.updated` | `{ taskId, task }` |
| `task.deleted` | `{ taskId }` |
| `task.done` | `{ finishReason, finalText }` |
| `task.aborted` | `{ runId }` |
| `tasks.changed` | 任务集合变化 |
| `tasks.reordered` | `{ tasks }` |
| `task-groups.changed` | `{ groups }` |

**会话与文件**

| type | payload |
|---|---|
| `session.subscribed` | 会话状态快照 |
| `session-truncated` | 撤回结果 |
| `session-restored` | 恢复结果 |
| `todo-updated` | `{ sessionId, todos }` |
| `context-updated` | `{ sessionId, files, totalTokens, maxTokens }` |
| `file-created` | `{ sessionId, path }` |
| `file-edited` | `{ sessionId, path, linesChanged? }` |
| `file-deleted` | `{ sessionId, path }` |
| `file-moved` | `{ sessionId, from, to }` |
| `terminal-changed` | `{ sessionId }` |

**终端**

| type | payload |
|---|---|
| `terminal.list` | `{ sessionId, terminals, ptyBackend? }` |
| `terminal.snapshot` | `{ terminalId, data }` |
| `terminal.created` / `terminal.data` / `terminal.closed` / `terminal.exit` | 由 TerminalService emitter 广播 |

**语音**

| type | payload |
|---|---|
| `voice.ready` | 会话就绪 |
| `voice.final` | `{ text }` |
| `voice.stopped` | 会话结束 |
| `voice.error` | `{ error }` |

**自动化 / 子代理 / MCP / 诊断 / 配置**

| type | payload |
|---|---|
| `automation.started` | `{ automationId, runId }` |
| `automation.event` | 运行过程事件 |
| `automation.finished` | `{ automationId, runId, status, finalText? }` |
| `subagent.event` | `{ taskId, parentToolCallId?, event }` |
| `mcp.status` | 服务器连接状态 |
| `resources.changed` | MCP 资源列表变化 |
| `insight.diagnose.event` | 诊断链路事件 |
| `config.changed` | `{ which: 'app' \| 'api' }` |

**回复确认与心跳**

| type | payload |
|---|---|
| `tool.ask.accepted` | `{ toolCallId }` |
| `tool.confirm.accepted` | `{ toolCallId }` |
| `pong` | `{}` |

---

## 四、数据类型定义

### 4.1 消息

```ts
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 本轮流式 assistant 消息的稳定身份（<sessionId>#<turn>） */
  messageId?: string;
  /** 用户消息附件绝对路径（纯路径引用） */
  attachments?: string[];
  /** 工具结果图片绝对路径（base64 不落库，发送时实时读盘编码） */
  images?: string[];
  imagesSentAt?: string;
  /** 前端生成的稳定消息 id（用于乐观消息与历史回放去重） */
  clientMessageId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;  // arguments 为 JSON 字符串
  toolCallId?: string;
  thinking?: string;
  thinkingSignature?: string;
  thinkingMs?: number;
  /** tool 消息的工具名 */
  name?: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  todoSnapshot?: TodoItem[];
  timestamp?: string;
  /** 非空表示已被消息撤回（构建 LLM 上下文时过滤） */
  deletedAt?: string;
  /** 已被压缩摘要替代 */
  compacted?: boolean;
}
```

> 会话文件中 `messages` 即 `AgentMessage[]`；前端历史回放使用同一结构，`TaskMessage` 仅为旧前端视图命名的历史概念，当前代码不再导出该类型。

### 4.2 配置

```ts
export interface AppConfig {
  version: number;
  server: { host: string; port: number; autoPort: boolean; locale?: string };
  daemon: { enabled: boolean };
  logs: { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; retentionDays: number; maxFileMb: number };
  update: { autoCheck: boolean; channel: 'stable' | 'beta'; checkIntervalHours: number };
  agent: {
    defaultModel: string;
    maxTokens: number;
    maxTurns: number;                 // 0 = 不限轮
    workingDirectory: string;
    llmStreamIdleTimeoutMs?: number;
  };
  tools: Record<string, { enabled: boolean; requireConfirmation?: boolean; timeout?: number }>;
  mcpServers: Record<string, unknown>;
  mcp?: { callTimeoutMs?: number; allowSampling?: boolean };
  mcpServer?: {
    enabled: boolean;
    allowedTools: string[];
    responseMode: 'json' | 'sse';
    exposeInternalTools: boolean;
    trackSummary: boolean;
  };
  skills?: Record<string, { enabled?: boolean }>;
  commands?: Record<string, { enabled?: boolean }>;
  security: { authToken: string; bindLocalhostOnly: boolean };
  remote: { enabled: boolean; lanEnabled: boolean; lanPasswordEnabled: boolean; lanIpOverride: string };
  fileHistory?: { enabled: boolean; maxBackupsPerFile: number; transcriptEnabled: boolean; backupRetentionDays: number };
  filesys?: { roots: string[]; cacheMaxBytes: number; cacheMaxEntries: number; cacheMaxFileBytes: number };
  safety?: {
    defaultMode: 'ask' | 'auto' | 'skip';
    confirmTimeoutMinutes: number;
    blockDangerousCommands: boolean;
    cautionPolicy: 'ask' | 'deny';
    rules: { allow: string[]; deny: string[]; ask: string[] };
    protectedPaths: string[];
  };
  context?: Record<string, unknown>;  // 压缩/修剪/自愈/遥测参数，见 src/modules/context/types.ts
  web: { searchProviderId: string };
  voice: { enabled: boolean; providerId: string; localModel: string; language: string };
}

export type ThinkingEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ProviderModelConfig {
  id: string;
  name: string;
  model: string;
  thinking: { enabled: boolean; effort?: ThinkingEffort; label?: string; budgetTokens?: number };
  contextWindow?: string;
  inputTokens?: number;
  outputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  thinkingLevels?: Array<{ level: string; label?: string }>;
}

export interface ProviderServiceConfig {
  id: string;
  name: string;
  type: 'file-storage';
  endpoint: string;
  apiKey: string;
  maxQuota?: number;
  quotaUnit?: 'MB' | 'GB' | 'TB';
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind?: 'model' | 'search' | 'voice';    // 缺省 = model
  format: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini' | 'search' | 'voice';
  searchEngine?: 'zhipu' | 'bocha' | 'tavily';
  voiceEngine?: 'openai-transcriptions';
  voiceModel?: string;
  endpoint: string;
  apiKey: string;
  balanceUrl?: string;
  modelsUrl?: string;
  icon?: string;
  services?: ProviderServiceConfig[];
  models: ProviderModelConfig[];
}

export interface ApiConfig {
  version: number;   // 2 = providers 数组结构（旧版 1 扁平结构自动迁移）
  providers: ProviderConfig[];
}
```

### 4.3 任务 / Todo / 上下文

```ts
export interface TaskItem {
  id: string;
  title: string;
  groupId: string;
  createdAt: string;
  updatedAt: string;
  active?: boolean;
  sessionId?: string;      // task.id 即 sessionId（当前实现同值）
  order?: number;          // 分组内排序权重（小→前）
}

export interface TaskGroup {
  id: string;
  name: string;
  expanded?: boolean;
  taskCount?: number;
  source?: 'folder' | 'manual';  // folder=按工作目录自动创建；manual=手动新建
  dir?: string;                  // tasks/ 下相对目录（支持嵌套布局）
  hidden?: boolean;              // 隐藏分组（subagent 衍生会话）
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
}

export interface ContextFile {
  path: string;
  tokens?: number;
  reason?: 'read' | 'edit' | 'write' | 'grep' | 'glob' | 'delete' | 'move' | 'copy';
  missing?: boolean;       // 运行时磁盘校验后附加：文件已不存在
}
```

### 4.4 Agent / Skill / 自动化 / MCP

```ts
export interface AgentItem {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  builtIn: boolean;
  default?: boolean;
}

export interface AgentDetail extends AgentItem {
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  maxTokens?: number;
}

export interface SkillItem {
  name: string;
  description: string;
  prompt: string;
  sourceFile?: string;
  source: 'user';          // 运行时唯一加载源为 ~/.moss/skills
  enabled: boolean;
  dir?: string;
  icon?: string;
  allowedTools?: string[];
  files?: string[];
}

export interface AutomationItem {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  scheduleType: 'cron' | 'once';
  cron?: string;           // scheduleType='cron'
  runAt?: string;          // scheduleType='once'（ISO，须未来）
  completed?: boolean;     // once 已执行
  cwd: string;             // '__system__' 表示本机全盘访问
  prompt: string;
  agentId?: string;
  enabled: boolean;
  paused: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  taskId?: string;         // 本次运行创建的真实任务 id（即 sessionId）
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'failed' | 'timeout';
  finishReason?: string;
  finalText?: string;
  error?: string;
}

export interface McpServer {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  enabled: boolean;
  transport?: string;
}

export interface McpTool {
  server: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}
```

### 4.5 终端 / 计算机 / 浏览器 / 语音摘要

```ts
export interface TerminalInfo {
  id: string;
  sessionId: string;
  title: string;
  interpreterLabel: string;
  interpreterKind: 'powershell' | 'cmd' | 'bash';
  creator: 'user' | 'ai';
  cwd: string;
  running: boolean;
  exitCode: number | null;
  createdAt: number;                 // ms
  pty: boolean;                      // false = 管道降级
  ptyBackend?: { backend: 'conpty'; buildNumber: number };
  offline?: boolean;                 // 仅剩历史回放（后端已重启）
}

export interface ComputerStatus {
  installed: boolean;
  driverPath: string | null;
  version: string | null;
  connection: 'disconnected' | 'connecting' | 'connected' | 'error' | 'installing';
  toolCount: number;
  screen: { width: number; height: number; scale: number | null } | null;
  paused: boolean;
  config: { maxImageDimension: number; allowForeground: boolean };
  error: string | null;
}

export interface BrowserStatus {
  bridge: { running: boolean; port: number | null; configuredPort: number; tokenConfigured: boolean; error: string | null };
  instances: Array<{
    id: string;
    kind: 'builtin' | 'external';
    browserName: string;
    browserVersion: string;
    extensionId: string;
    extensionVersion: string;
    builtinTag?: string;
    connectedAt: number;
    tabCount: number;
  }>;
  builtin: {
    running: boolean;
    executable: string | null;
    source: 'config' | 'local' | 'chrome-for-testing' | null;
    version: string | null;
    profileDir: string;
    extensionLoaded: boolean;
    extensionId: string | null;
    error: string | null;
  };
  extension: { dir: string; version: string | null; seeded: boolean };
  cft: {
    installed: boolean;
    buildId: string | null;
    executable: string | null;
    downloading: boolean;
    progress: { received: number; total: number; percent: number } | null;
    error: string | null;
  };
  installer: {
    enabled: boolean;
    running: boolean;
    checked: boolean;
    current: string | null;
    browsers: Array<Record<string, unknown>>;
  };
  tabs: Array<{
    tab: string;
    instanceId: string;
    instanceKind: 'builtin' | 'external';
    browserName: string;
    browserVersion: string;
    nativeTabId: number;
    windowId?: number;
    groupId: number | null;
    url: string;
    title: string;
    active: boolean;
    createdAt: number;
  }>;
  currentTab: string | null;
  config: {
    tabGroupTitle: string;
    tabGroupColor: string;
    maxSnapshotNodes: number;
    maxImageDimension: number;
    allowEvaluate: boolean;
    timeoutMs: number;
  };
}

export interface VoiceModelStatus {
  id: string;
  engine: 'zipformer' | 'sensevoice' | 'whisper';
  mode: 'streaming' | 'offline';
  name: string;
  description: string;
  sizeBytes: number;
  languages: string[];
  recommended: boolean;
  state: 'not-installed' | 'downloading' | 'installed' | 'error';
  progress?: number;        // 0..1（仅 downloading）
  installedBytes?: number;
  error?: string;
}
```

### 4.6 WebSocket 消息

```ts
export interface WSMessage {
  type: string;
  sessionId?: string;
  payload?: unknown;
}
```

---

## 五、数据持久化

接口读写的数据落在 `~/.moss/`（项目级作用域为 `<cwd>/.moss/`），完整路径表见 [architecture.md 第八章](./architecture.md#八数据持久化)。核心对应关系：

| 接口域 | 持久化路径 |
|---|---|
| 配置 | `~/.moss/config/config.json`、`api.json` |
| 任务 / 会话 / Todo | `~/.moss/tasks/<groupId>/`、`~/.moss/todo/<sessionId>.json` |
| Agent 注册表 | `~/.moss/agents.json` |
| 自动化 | `~/.moss/automations.json`、`automations-history.json` |
| Skill / Command / 提示词 / 附件 | `~/.moss/skills/`、`commands/`、`agent/prompts/`、`agent/attachments/` |
| 规则 / 钩子 / 记忆 | `~/.moss/{rules,hooks,memory}/`（项目级 `<cwd>/.moss/`） |
| 文件历史 | `~/.moss/file-history/` |
| 浏览器 / 桌面 / 语音 | `~/.moss/browser/`、`~/.moss/computer/`、`~/.moss/models/asr/` |
| 远程访问 | `~/.moss/remote/` |
| 文件索引 | `<cwd>/.moss/file-index/` |
