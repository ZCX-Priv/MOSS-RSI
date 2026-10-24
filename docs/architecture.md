# MOSS 系统架构

## 一、总体架构

MOSS 是一个基于 **微内核 + 模组化架构** 的 AI Agent 应用，运行在 Bun 运行时上。21 个模组全部由内核静态 import 编排，按固定顺序初始化、反向销毁。

```
┌─────────────────────────────────────────────────────────┐
│                     浏览器 (新 UI)                        │
│  React 19 + shadcn/ui + Tailwind 4 + i18next + idb      │
│  构建: Vite → dist/webui/                                │
└──────────────┬──────────────────────┬───────────────────┘
               │ HTTP REST (/api/*)    │ WebSocket (/ws)
               ▼                      ▼
┌─────────────────────────────────────────────────────────┐
│                   Server 模组 (Bun.serve)                │
│  HTTP 路由 + WS 处理 + 静态资源服务 + /mcp 对外端点        │
│  端口: 7766 (config.json)                                │
└──────────────┬──────────────────────────────────────────┘
               │ ServiceRegistry 依赖注入
               ▼
┌─────────────────────────────────────────────────────────┐
│                     微内核 (Kernel)                       │
│  ConfigService │ EventBus │ ServiceRegistry │ Logger     │
│  静态模块注册表（固定顺序编排生命周期）                    │
└──────────────┬──────────────────────────────────────────┘
               │ 按固定顺序加载（被依赖者在前）
               ▼
┌────────────────┬────────────────┬────────────────┬────────────────┬────────────────┬────────────────┐
│   LLM 模组     │  Server 模组   │  Remote 模组   │  Tools 模组    │   MCP 模组     │ Computer 模组  │
│  (多 Provider) │   (HTTP+WS)    │  (远程访问)    │ (内置工具+Skill│  (双向 MCP)    │  (桌面操作)    │
│                │                │                │  /Command)     │                │                │
└────────────────┴────────────────┴────────────────┴────────────────┴────────────────┴────────────────┘
┌────────────────┬────────────────┬────────────────┬────────────────┬────────────────┬────────────────┐
│ Browser 模组   │ Update 模组    │ Filesys 模组   │ Terminal 模组  │  Safety 模组   │  Rules 模组    │
│ (浏览器控制)   │  (版本检查)    │   (虚拟FS)     │  (持久终端)    │  (权限决策)    │  (用户规则)    │
└────────────────┴────────────────┴────────────────┴────────────────┴────────────────┴────────────────┘
┌────────────────┬────────────────┬────────────────┬────────────────┬────────────────┬────────────────┐
│  Hooks 模组    │ Memory 模组    │  Voice 模组    │ Context 模组   │  Agent 模组    │ agenteam 模组  │
│  (生命周期)    │  (记忆引擎)    │  (语音识别)    │  (上下文引擎)  │  (ReAct 引擎)  │ (Agent 团队)   │
└────────────────┴────────────────┴────────────────┴────────────────┴────────────────┴────────────────┘
┌────────────────┬────────────────┬────────────────┐
│ File-history   │ Daemon 模组    │ Automation 模组│
│   (文件历史)   │  (PID 维护)    │  (定时任务)    │
└────────────────┴────────────────┴────────────────┘
```

## 二、目录结构

```
MOSS/
├── webui/                       # 前端（React 19 + shadcn/ui）
│   ├── src/
│   │   ├── api/                 # HTTP + WS 客户端封装
│   │   ├── components/          # UI 组件（pages/layout/overlays/dialogs/shared/ui）
│   │   ├── contexts/            # Theme + I18n Context
│   │   ├── hooks/               # 业务 hooks（useTask/useConfig/...）
│   │   ├── store/               # 全局状态（zustand + IndexedDB 持久化）
│   │   ├── types/               # 前后端共享类型
│   │   ├── i18n/                # 国际化（zh/en）
│   │   └── utils/               # idb 等工具
│   ├── package.json             # 前端独立依赖
│   └── vite.config.ts           # Vite 配置（3000 端口 + /api + /ws 代理）
├── src/
│   ├── main.ts                  # 入口：CLI 解析 + 启动 Kernel
│   ├── core/                    # 微内核
│   │   ├── types.ts             # 服务契约接口
│   │   ├── kernel.ts            # Kernel 启动流程（静态模块注册表）
│   │   ├── config-service.ts    # 配置服务（Zod 校验 + 热重载）
│   │   ├── service-registry.ts  # 服务注册表
│   │   ├── event-bus.ts         # 事件总线（Filter + Action）
│   │   ├── env.ts               # 环境检测
│   │   └── logger.ts            # 日志服务
│   ├── modules/                 # 21 个模组（由内核静态 import 编排）
│   │   ├── llm/                 # LLM 路由 + Provider 实现
│   │   ├── server/              # HTTP + WS 服务
│   │   ├── remote/              # 远程访问（局域网 / cloudflared 隧道 / 请求门卫）
│   │   ├── tools/               # 内置工具 + Skill/Command 注册表
│   │   ├── mcp/                 # MCP 客户端管理 + 对外 MCP Server
│   │   ├── computer/            # cua-driver 桌面操作
│   │   ├── browser/             # 浏览器扩展桥接 / 内置 Chrome / CDP
│   │   ├── update/              # 版本检查
│   │   ├── filesys/             # 虚拟文件系统（roots/缓存/变更事件）
│   │   ├── terminal/            # 持久终端 PTY
│   │   ├── safety/              # 统一权限决策
│   │   ├── rules/               # 用户规则引擎
│   │   ├── hooks/               # 生命周期钩子引擎
│   │   ├── memory/              # 记忆引擎
│   │   ├── voice/               # 语音识别（本地 / 在线 / WASM）
│   │   ├── context/             # 上下文引擎（压缩/自愈/文件索引）
│   │   ├── agent/               # Agent 引擎（ReAct 循环）
│   │   ├── agenteam/            # Agent CRUD + 团队编排
│   │   ├── file-history/        # 文件历史（追踪/快照/回滚）
│   │   ├── daemon/              # PID 文件维护 + 优雅退出
│   │   └── automation/          # 自动化任务（cron/once 调度）
│   └── utils/                   # 通用工具
├── browser-extension/           # Chrome 扩展（MOSS Browser Bridge，Manifest V3）
├── agent/prompts/main/          # Agent 系统提示词（.md）
├── skills/                      # Skill 定义（.md，YAML front-matter，播种到 ~/.moss/skills/）
├── config/                      # 配置模板
│   ├── config.json              # AppConfig 模板
│   └── api.json                 # ApiConfig 模板
├── docs/                        # 前后端对接文档
├── scripts/
│   ├── build.mjs                # 构建（Bun 后端 + Vite 前端）
│   ├── dev.mjs                  # 开发（并行启动后端 + 前端）
│   ├── install-webui.mjs        # 安装前端依赖
│   └── rebrand-icons.mjs        # 图标处理
├── bin/moss.js                  # CLI 入口
├── package.json                 # 根 package.json（后端依赖）
└── tsconfig.json                # TypeScript 配置（exclude: webui）
```

## 三、微内核架构

### 3.1 核心服务

内核提供 4 个核心服务，所有模组通过 `ModuleContext` 注入：

| 服务 | 接口 | 职责 |
|---|---|---|
| `ConfigService` | `src/core/config-service.ts` | 加载/校验/更新 `config.json` + `api.json`，Zod 校验，文件 watcher 热重载 |
| `EventBus` | `src/core/event-bus.ts` | Filter 模式（链式修改数据）+ Action 模式（并行副作用）|
| `ServiceRegistry` | `src/core/service-registry.ts` | 服务注册/解析，按 scope 隔离注销 |
| `Logger` | `src/core/logger.ts` | 分级日志（debug/info/warn/error/fatal），子日志器，文件轮转与保留策略 |

### 3.2 模组系统

模组由内核静态 import 编排（`src/core/kernel.ts` 的 `MODULE_FACTORIES` 固定顺序注册表），无清单文件：

| 类型 | 目录 | 上下文 | 权限 |
|---|---|---|---|
| **模组 (Module)** | `src/modules/*/` | `ModuleContext`（完整能力）| 可注册服务（scope 隔离，销毁时自动注销）|

**21 个模组加载顺序**：

```
llm → server → remote → tools → mcp → computer → browser → update → filesys →
terminal → safety → rules → hooks → memory → voice → context → agent →
agenteam → file-history → daemon → automation
```

**加载流程**（`src/core/kernel.ts`）：
1. 静态 import 全部 21 个模组工厂，按 `MODULE_FACTORIES` 数组固定顺序实例化
2. 固定顺序满足依赖关系：
   - `llm` / `server` / `update` 无依赖；`server` 前移到第 2 位，其路由 handler 均为请求时 `tryResolve`，health/静态页可秒级就绪
   - `remote → server`：注入请求门卫、注册 `/api/remote/*` 路由、提供热重绑句柄（门卫未注入时 server 零开销直通，不阻塞端口可用）
   - `tools` / `mcp` 加载与连接较慢（工具动态 import / MCP 子进程握手），排在 server 之后不阻塞端口
   - `filesys` 无服务依赖（agent 构造时订阅其事件总线，须先于 agent 注册）
   - `terminal → filesys`；`safety` 无服务依赖（先于 agent）；`rules` / `hooks` / `memory` / `voice` 无服务依赖（voice 的 sherpa-onnx 异步预热，不阻塞启动）
   - `context → llm`（压缩摘要调用 LLMRouter，须先于 agent）
   - `agent → llm, tools, filesys, safety, context, rules, hooks, memory`
   - `agenteam → agent`（编排服务复用 AgentEngine）
   - `file-history → tools, filesys`；`daemon → server`；`automation → agent, server`
3. 按序 `initialize()`（单模块超时 30s，失败记日志并继续），反向序 `destroy()`（超时 10s）
4. 每个模组以自身名字为 scope 注册服务，销毁时 `unregisterScope` + `offAll` 自动回收

`KernelStartOptions.disabledModules` 可为轻量入口跳过模组（如 `moss mcp` 跳过 server/remote/daemon/automation/update，避免与常驻实例抢端口）。

新增模组：在 `src/modules/` 下创建目录实现 `Module` 接口，并在 `kernel.ts` 的 `MODULE_FACTORIES` 中按依赖位置插入。

### 3.3 标准服务名

由各模组注册到 `ServiceRegistry`，定义在 `src/core/types.ts` `ServiceNames`：

| 服务名 | 注册者 | 接口契约 |
|---|---|---|
| `llm.router` | LLM 模组 | `LLMRouter`（complete/stream/listProviders/resolveProviderForModel）|
| `server.instance` | Server 模组 | `ServerInstance`（addRoute/broadcastWS/sendToSession/onWSMessage/rebind）|
| `remote.service` | Remote 模组 | `RemoteService`（状态快照/开关/局域网/隧道/密码）|
| `tool.registry` | Tools 模组 | `ToolRegistry`（register/get/list/listSchemas/execute）|
| `skill.registry` | Tools 模组 | `SkillRegistry`（register/list/get/reloadBySourceFile）|
| `command.registry` | Tools 模组 | `CommandRegistry`（自定义斜杠命令注册表）|
| `mcp.manager` | MCP 模组 | `MCPManager`（listServers/listTools/callTool/connect/disconnect）|
| `mcp.task.registry` | MCP 模组 | 对外派发任务注册表（进度/轨迹/结果状态）|
| `computer.service` | Computer 模组 | `ComputerService`（连接/调用/截图/活动/暂停/安装）|
| `browser.service` | Browser 模组 | `BrowserService`（扩展桥接/内置 Chrome/AI 标签页/CDP 页面操作）|
| `file.sys` | Filesys 模组 | `FilesysService`（统一文件 IO / 读缓存 / roots / 变更事件）|
| `terminal.service` | Terminal 模组 | `TerminalService`（PTY 会话/输入/输出快照/状态）|
| `safety.service` | Safety 模组 | `SafetyService`（统一权限决策 + 会话规则 + 规则建议）|
| `rules.engine` | Rules 模组 | `RulesEngine`（用户规则存储/加载/条件注入）|
| `hooks.engine` | Hooks 模组 | `HooksEngine`（生命周期事件钩子执行）|
| `memory.engine` | Memory 模组 | `MemoryEngine`（记忆宫殿存储/检索/蒸馏）|
| `voice.service` | Voice 模组 | `VoiceService`（状态/模型安装/识别会话）|
| `context.engine` | Context 模组 | `ContextEngine`（拼接/压缩/自愈/预算/治理/遥测）|
| `agent.engine` | Agent 模组 | `AgentEngine`（run/resolveAsk/resolveConfirm）|
| `agenteam.registry` | agenteam 模组 | `AgentRegistry`（list/get/create/update/delete/setDefault）|
| `agenteam.orchestrator` | agenteam 模组 | `TeamOrchestrator`（团队生命周期/DAG 调度/质量门禁/临时 subagent）|
| `file.history` | File-history 模组 | `FileHistoryService`（Track Edit + Snapshot + undo/restore）|
| `automation.service` | Automation 模组 | `AutomationService`（list/create/update/delete/trigger/pause/resume/history）|
| `kernel.config` | Kernel | `ConfigService`（运行时读取 config.json / api.json）|
| `kernel.logger` | Kernel | `LogService`（文件枚举/查询过滤/清理/级别调整）|
| `kernel.modules` | Kernel | `{ getList(): Array<{ name, state }> }`（模块状态，供 health 路由）|

## 四、前后端交互

### 4.1 通信通道

| 通道 | 用途 | 协议 |
|---|---|---|
| **HTTP REST** | 配置、Provider、会话、任务、Agent 团队、MCP、Skills/Commands、自动化、文件系统、终端、浏览器/桌面、日志、上下文、规则/钩子/记忆、语音、远程访问 | `/api/*`，JSON |
| **WebSocket** | 流式任务（assistant-text/thinking/tool-call 实时推送）、ask/confirm 回复、todo/上下文更新、任务元信息、终端、语音、自动化、AI 诊断 | `/ws`，JSON 帧 |
| **MCP over HTTP** | 对外暴露 MOSS 工具（`mcpServer.enabled` 时） | `/mcp` |
| **MCP over stdio** | `moss mcp`，供 Claude Desktop / Cursor 等外部客户端 | stdio |

### 4.2 鉴权

- 配置项：`config.security.authToken`（空字符串表示无需鉴权）
- 客户端：HTTP 头 `Authorization: Bearer <token>`，WS 同源信任不强制
- 服务端：`HttpRouter.checkAuth()` 校验，空 token 放行所有请求
- 前端：`localStorage['moss-token']` 存储，`api/http.ts` 自动注入
- 远程访问开启时：`RemoteGuard` 在 HTTP/WS/静态资源/`/mcp` 前统一拦截非本机请求，局域网与公网密码各自独立 cookie

### 4.3 静态资源服务

`src/modules/server/static-assets.ts`：
- 根目录：`<packageRoot>/dist/webui/`
- SPA fallback：非 `/api/` 非 `/ws` 的未匹配路径返回 `index.html`
- MIME 映射：`.html/.js/.mjs/.css/.json/.png/.jpg/.svg/.ico/.woff/.woff2/.ttf` 等
- 缓存：`.html` 不缓存，其他 `public, max-age=86400`

### 4.4 开发模式

| 模式 | 前端 | 后端 | 通信 |
|---|---|---|---|
| **开发** | `cd webui && npx vite`（3000 端口）| `bun run --watch src/main.ts start --foreground`（7766 端口）| Vite 代理 `/api` + `/ws` → 7766 |
| **生产** | `dist/webui/` 静态文件 | `dist/server.js` 单文件 | 同源直连 7766 |

## 五、配置系统

### 5.1 AppConfig（`~/.moss/config/config.json`）

```json
{
  "version": 1,
  "server": { "host": "127.0.0.1", "port": 7766, "autoPort": false, "locale": "zh" },
  "daemon": { "enabled": true },
  "logs": { "level": "info", "retentionDays": 14, "maxFileMb": 10 },
  "update": { "autoCheck": true, "channel": "stable", "checkIntervalHours": 24 },
  "agent": {
    "defaultModel": "deepseek-chat",
    "maxTokens": 8192,
    "maxTurns": 0,
    "workingDirectory": "",
    "llmStreamIdleTimeoutMs": 900000
  },
  "security": { "authToken": "", "bindLocalhostOnly": true },
  "remote": { "enabled": false, "lanEnabled": true, "lanPasswordEnabled": true, "lanIpOverride": "" },
  "filesys": { "roots": [], "cacheMaxBytes": 67108864, "cacheMaxEntries": 2048, "cacheMaxFileBytes": 4194304 },
  "safety": {
    "defaultMode": "ask",
    "confirmTimeoutMinutes": 5,
    "blockDangerousCommands": true,
    "cautionPolicy": "ask",
    "protectedPaths": ["~/.ssh", "~/.gnupg", "~/.aws"]
  },
  "web": { "searchProviderId": "" },
  "voice": { "enabled": false, "providerId": "", "localModel": "", "language": "auto" },
  "tools": {
    "read": { "enabled": true },
    "write": { "enabled": true, "requireConfirmation": true },
    "edit": { "enabled": true, "requireConfirmation": false },
    "terminal": { "enabled": true, "timeout": 30000, "requireConfirmation": true },
    "skill": { "enabled": true },
    "mcp": { "enabled": true }
  },
  "mcpServers": {}
}
```

说明：

- `agent.maxTurns: 0` 表示不限制轮数；`logs` 段控制日志级别/保留天数/单文件大小（旧版 `daemon.logLevel` 加载时自动迁移到 `logs.level`）。
- `tools` 段 schema 由 `src/modules/tools/manifest.ts` 扫描各工具目录的 `tool.json` 自动生成，新增工具无需手工改 `config-service.ts`。
- 其余可选段：`mcp`（客户端调用超时 / sampling）、`mcpServer`（对外 MCP Server）、`skills` / `commands`（启停）、`fileHistory`、`context`（压缩/修剪/自愈/遥测），内层字段均有默认值，旧配置缺段自动补全。

### 5.2 ApiConfig（`~/.moss/config/api.json`）

```json
{
  "version": 2,
  "providers": [
    {
      "id": "provider_0001",
      "name": "DeepSeek",
      "format": "openai-chat",
      "endpoint": "https://api.deepseek.com",
      "apiKey": "",
      "models": [
        { "id": "model_0001", "name": "DeepSeek Chat", "model": "deepseek-chat", "thinking": { "enabled": false } },
        { "id": "model_0002", "name": "DeepSeek Reasoner", "model": "deepseek-reasoner", "thinking": { "enabled": true, "effort": "high" } }
      ]
    },
    {
      "id": "provider_0002",
      "name": "Anthropic",
      "format": "anthropic",
      "endpoint": "https://api.anthropic.com/v1",
      "apiKey": "",
      "models": [
        { "id": "model_0003", "name": "Claude Sonnet 4.5", "model": "claude-sonnet-4-5", "thinking": { "enabled": true, "effort": "high", "budgetTokens": 4096 } }
      ]
    }
    // openai-responses, gemini, qwen, glm, kimi...
  ]
}
```

`providers` 为数组，每个 Provider 含内部唯一 `id`、显示名 `name`、接口格式与模型列表；`models` 为对象数组（`id`/`name`/`model`/模型级 `thinking`）。旧版 version 1 扁平结构（含 `defaultProvider`）加载时自动迁移。

### 5.3 支持的 Provider 格式

| format | endpoint 示例 | thinking 支持 |
|---|---|---|
| `openai-chat` | `https://api.openai.com/v1` | 否 |
| `openai-responses` | `https://api.openai.com/v1` | 是（effort）|
| `anthropic` | `https://api.anthropic.com/v1` | 是（effort + budgetTokens）|
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | 是（budgetTokens）|

### 5.4 配置热重载

`ConfigService` 启动 `fs.watch` 监听 `config.json` + `api.json`：
- 文件变更 → 300ms 防抖 → 重新读取 + Zod 校验 → 广播 `config:changed` 事件
- 通知所有 `onChange` 订阅者（前端可通过 WS 推送或重新拉取）

## 六、Agent 引擎工作流

```
用户消息（task.stream / task.guide）
   │
   ▼
AgentEngine.run({ sessionId, userMessage, cwd, onEvent })
   │
   ├── 1. context 引擎构建系统提示词与请求视图（rules 注入 / memory 召回；
   │      降级 fallback：静态提示 + 纯函数视图构建）
   ├── 2. 获取/创建 session（SessionStore，防抖批量刷盘）
   ├── 3. 添加 user message
   ├── 4. 收集工具（ToolRegistry + MCP tools，前缀 mcp__server__tool）
   │
   └── ReAct 循环（maxTurns=0 表示不限轮）:
       ├── 5. context 引擎流水线（env 保障 → 压缩决策 → 缓存对齐视图）
       ├── 6. 转 UnifiedMessage，调 llm.stream(req, provider)
       │   └── 流式 delta:
       │       ├── text → onEvent('assistant-text')
       │       ├── thinking → onEvent('assistant-thinking')
       │       ├── tool_call → 累积 id/name/args（tool-call-delta）
       │       ├── finish → 记录 finishReason
       │       └── error → onEvent('error')
       ├── 7. 记录 assistant message（含 toolCalls）
       ├── 8. 无 tool_calls → 结束循环
       ├── 9. 有 tool_calls → 逐个执行:
       │   ├── onEvent('tool-call-start')
       │   ├── safety 统一权限决策（ask / auto / skip；敏感工具逐次确认）
       │   ├── 参数自愈（context 引擎：JSON 修复/工具名纠正/schema 修正）
       │   ├── 内置工具: ToolRegistry.execute(ctx)
       │   │   ├── ctx.askUser() → onEvent('ask') → 等待前端回复
       │   │   └── 确认请求 → onEvent('confirm-required') → 等待前端回复
       │   ├── MCP 工具: mcpManager.callTool(server, tool, args)
       │   ├── onEvent('tool-call-end')；file-history 记录编辑 / undo 快照
       │   └── 记录 tool message 到 session
       └── 10. 继续下一轮
   │
   ▼
onEvent('done', finishReason)
返回 { sessionId, finishReason, finalText, history }
```

- `task.guide`：任务运行中追加引导消息；`task.abort`：中断当前 run。
- `ask` / `confirm-required` 按 `sessionId + toolCallId` 唯一键管理，避免并发任务串答。
- 生命周期钩子（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd）经 hooks 引擎 fail-open 执行。

## 七、远程访问与安全

### 7.1 绑定地址

`computeBindHost()`（`src/modules/server/index.ts`）按优先级决定监听地址：

1. 开发模式且未开启远程 → 强制 `127.0.0.1`
2. `remote.enabled = true` → `0.0.0.0`（局域网可达）
3. `security.bindLocalhostOnly = true` → `127.0.0.1`
4. 否则使用 `server.host`

`remote.enabled` 变更时 server 以同端口热重绑（`rebind`），失败回滚原 hostname。

### 7.2 鉴权分层

| 层 | 机制 |
|---|---|
| API | `security.authToken` → `Authorization: Bearer <token>`（空值放行） |
| 局域网 | `remote.lanPasswordEnabled` 时要求 8 位数字密码，cookie 按 `lan` scope |
| 公网隧道 | cloudflared quick tunnel + 独立 8 位数字密码，cookie 按 `public` scope |
| 请求门卫 | `RemoteGuard` 覆盖 HTTP / WS / 静态资源 / `/mcp`，本机请求零开销直通 |

密码与隧道状态持久化在 `~/.moss/remote/`；MOSS 重启后按持久化标记自动恢复隧道。远程管理接口为 `/api/remote/*`（status / enable / disable / lan / lan/password / lan-ip / tunnel/start / tunnel/stop / tunnel/password / passwords）。

## 八、数据持久化

所有用户数据存储在 `~/.moss/`（`env.dataDir`）；规则/记忆/钩子/文件索引另支持项目级作用域 `<cwd>/.moss/`。

| 路径 | 用途 | 格式 |
|---|---|---|
| `~/.moss/config/config.json` | AppConfig | JSON |
| `~/.moss/config/api.json` | ApiConfig（v2 providers 结构） | JSON |
| `~/.moss/moss.pid` | 守护进程 PID | JSON |
| `~/.moss/logs/` | 日志文件（按保留策略轮转清理） | 文本 |
| `~/.moss/tasks/<groupId>/` | 任务分组目录（task.json 为任务元信息，根索引 task-store v4） | JSON |
| `~/.moss/tasks/<groupId>/<sessionId>.json` | 会话历史（每会话一文件） | JSON |
| `~/.moss/todo/<sessionId>.json` | 会话级 Todo 列表 | JSON |
| `~/.moss/agenteam.json` | 自定义 Agent 注册表（旧 `agents.json` 自动迁移） | JSON |
| `~/.moss/agenteam/` | Agent 团队运行时数据（旧 `agent-teams/` 自动迁移） | JSON/目录 |
| `~/.moss/agenteam-profiles.json` | 团队模板（旧 `agent-team-profiles.json` 自动迁移） | JSON |
| `~/.moss/automations.json` | 自动化任务 | JSON |
| `~/.moss/automations-history.json` | 自动化运行历史 | JSON |
| `~/.moss/skills/` | 用户自定义 Skill（唯一运行时加载源；包内 `skills/` 首次启动播种） | .md（YAML front-matter + body） |
| `~/.moss/commands/` | 自定义斜杠命令 | .md |
| `~/.moss/agent/prompts/` | 用户自定义系统提示词（`main/` 等） | .md |
| `~/.moss/agent/attachments/` | 粘贴附件落盘 | 二进制 |
| `~/.moss/memory/` | 记忆宫殿存储（全局作用域） | JSON |
| `~/.moss/rules/` | 用户规则（全局作用域） | JSON |
| `~/.moss/hooks/` | 生命周期钩子（全局作用域） | JSON |
| `~/.moss/file-history/` | 文件历史快照 / 转录（JSONL） | JSON/JSONL |
| `~/.moss/browser/` | 内置 Chrome profile / 扩展与桥接状态 | 目录 |
| `~/.moss/computer/` | cua-driver 截图落盘 | 图片 |
| `~/.moss/models/asr/` | 语音模型（sherpa-onnx） | 模型文件 |
| `~/.moss/remote/` | 远程访问密码与隧道状态 | JSON |
| `<cwd>/.moss/rules/`、`<cwd>/.moss/memory/`、`<cwd>/.moss/hooks/` | 项目级规则 / 记忆 / 钩子 | JSON |
| `<cwd>/.moss/file-index/` | 项目级文件索引（index-list + 索引数据） | JSON/目录 |

## 九、相关文档

- [前后端 API 对接](./frontend-backend-api.md) —— REST 接口与 WebSocket 协议细节
