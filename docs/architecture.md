# MOSS 系统架构

## 一、总体架构

MOSS 是一个基于 **微内核 + 模组化架构** 的 AI Agent 应用，运行在 Bun 运行时上。

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
│  HTTP 路由 + WS 处理 + 静态资源服务                       │
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
┌────────────────┬────────────────┬────────────────┬────────────────┐
│   LLM 模组     │  Server 模组   │  Tools 模组    │   MCP 模组     │
│  (多 Provider  │   (HTTP+WS)    │ (内置工具+Skill│  (外部工具)    │
│     路由)      │                │ /Command/Spec) │                │
└────────────────┴────────────────┴────────────────┴────────────────┘
┌────────────────┬────────────────┬────────────────┬────────────────┐
│ agenteam 模组  │ Update 模组    │ Filesys 模组   │ Safety 模组    │
│ (Agent CRUD)   │  (版本检查)    │   (虚拟FS)     │  (权限决策)    │
└────────────────┴────────────────┴────────────────┴────────────────┘
┌────────────────┬────────────────┬────────────────┬────────────────┐
│  Rules 模组    │  Hooks 模组    │ Memory 模组    │ Context 模组   │
│  (用户规则)    │  (生命周期钩子) │  (记忆引擎)    │  (上下文引擎)  │
└────────────────┴────────────────┴────────────────┴────────────────┘
┌────────────────┬────────────────┬────────────────┬────────────────┐
│  Agent 模组    │ File-history   │ Daemon 模组    │ Automation 模组│
│  (ReAct 引擎)  │   (文件历史)   │  (PID 维护)    │  (定时任务)    │
└────────────────┴────────────────┴────────────────┴────────────────┘
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
│   ├── modules/                 # 模组（由内核静态 import 编排）
│   │   ├── llm/                 # LLM 路由 + Provider 实现
│   │   ├── server/              # HTTP + WS 服务
│   │   ├── tools/               # 内置工具 + Skill/Command/Spec 注册表
│   │   ├── mcp/                 # MCP 客户端管理
│   │   ├── agenteam/            # Agent 注册表（CRUD）
│   │   ├── update/              # 版本检查
│   │   ├── filesys/             # 虚拟文件系统（roots/缓存/变更事件）
│   │   ├── safety/              # 统一权限决策
│   │   ├── rules/               # 用户规则引擎
│   │   ├── hooks/               # 生命周期钩子引擎
│   │   ├── memory/              # 记忆引擎
│   │   ├── context/             # 上下文引擎（压缩/自愈/文件索引）
│   │   ├── agent/               # Agent 引擎（ReAct 循环）
│   │   ├── file-history/        # 文件历史（追踪/快照/回滚）
│   │   ├── daemon/              # PID 文件维护 + 优雅退出
│   │   └── automation/          # 自动化任务（cron/once 调度）
│   └── utils/                   # 通用工具
├── agent/prompts/main/          # Agent 系统提示词（.md）
├── skills/                      # Skill 定义（.md，YAML front-matter，播种到 ~/.moss/skills/）
├── config/                      # 配置模板
│   ├── config.json              # AppConfig 模板
│   └── api.json                 # ApiConfig 模板
├── docs/                        # 前后端对接文档
├── scripts/
│   ├── build.mjs                # 构建（Bun 后端 + Vite 前端）
│   └── dev.mjs                  # 开发（并行启动后端 + 前端）
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

**加载流程**（`src/core/kernel.ts`）：
1. 静态 import 全部 16 个模组工厂，按 `MODULE_FACTORIES` 数组固定顺序实例化
2. 固定顺序满足依赖关系（被依赖者在前；server 前移保证端口秒级就绪，tools/mcp 慢加载不阻塞）
3. 按序 `initialize()`（单模块超时 30s，失败记日志并继续），反向序 `destroy()`（超时 10s）
4. 每个模组以自身名字为 scope 注册服务，销毁时 `unregisterScope` + `offAll` 自动回收

新增模组：在 `src/modules/` 下创建目录实现 `Module` 接口，并在 `kernel.ts` 的 `MODULE_FACTORIES` 中按依赖位置插入。

### 3.3 标准服务名

由各模组注册到 `ServiceRegistry`，定义在 `src/core/types.ts` `ServiceNames`：

| 服务名 | 注册者 | 接口契约 |
|---|---|---|
| `llm.router` | LLM 模组 | `LLMRouter`（complete/stream/listProviders/resolveProviderForModel）|
| `tool.registry` | Tools 模组 | `ToolRegistry`（register/get/list/listSchemas/execute）|
| `skill.registry` | Tools 模组 | `SkillRegistry`（register/list/get/reloadBySourceFile）|
| `command.registry` | Tools 模组 | `CommandRegistry`（自定义斜杠命令注册表）|
| `mcp.manager` | MCP 模组 | `MCPManager`（listServers/listTools/callTool/connect/disconnect）|
| `agent.engine` | Agent 模组 | `AgentEngine`（run/resolveAsk）|
| `server.instance` | Server 模组 | `ServerInstance`（addRoute/broadcastWS/sendToSession/onWSMessage）|
| `agenteam.registry` | agenteam 模组 | `AgentRegistry`（list/get/create/update/delete/setDefault）|
| `automation.service` | Automation 模组 | `AutomationService`（list/create/update/delete/trigger/pause/resume/history）|
| `file.history` | File-history 模组 | `FileHistoryService`（Track Edit + Snapshot + undo）|
| `file.sys` | Filesys 模组 | `FilesysService`（统一文件 IO / 读缓存 / roots / 变更事件）|
| `safety.service` | Safety 模组 | `SafetyService`（统一权限决策 + 会话规则 + 规则建议）|
| `context.engine` | Context 模组 | `ContextEngine`（拼接/压缩/自愈/预算/治理/遥测）|
| `rules.engine` | Rules 模组 | `RulesEngine`（用户规则存储/加载/条件注入）|
| `hooks.engine` | Hooks 模组 | `HooksEngine`（生命周期事件钩子执行）|
| `memory.engine` | Memory 模组 | `MemoryEngine`（记忆宫殿存储/检索/蒸馏）|
| `kernel.logger` | Kernel | `LogService`（文件枚举/查询过滤/清理/级别调整）|
| `kernel.modules` | Kernel | `{ getList(): Array<{ name, state }> }`（模块状态，供 health 路由）|

## 四、前后端交互

### 4.1 通信通道

| 通道 | 用途 | 协议 |
|---|---|---|
| **HTTP REST** | 配置读写、会话管理、MCP 管理、Agent/Automation CRUD、Skills/Specs 查询 | `/api/*`，JSON |
| **WebSocket** | 流式任务（assistant-text/thinking/tool-call 实时推送）、ask 回复、todo 更新、automation 运行通知 | `/ws`，JSON 帧 |

### 4.2 鉴权

- 配置项：`config.security.authToken`（空字符串表示无需鉴权）
- 客户端：HTTP 头 `Authorization: Bearer <token>`，WS 不强制（同源信任）
- 服务端：`HttpRouter.checkAuth()` 校验，空 token 放行所有请求
- 前端：`localStorage['moss-token']` 存储，`api/http.ts` 自动注入

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
  "agent": { "defaultModel": "deepseek-chat", "maxTokens": 8192, "maxTurns": 0, "workingDirectory": "" },
  "tools": {
    "read": { "enabled": true },
    "write": { "enabled": true, "requireConfirmation": true },
    "edit": { "enabled": true, "requireConfirmation": false },
    "terminal": { "enabled": true, "timeout": 30000, "requireConfirmation": true },
    "skill": { "enabled": true },
    "mcp": { "enabled": true }
    // ...其他工具
  },
  "mcpServers": {},
  "security": { "authToken": "", "bindLocalhostOnly": true }
}
```

其中 `maxTurns: 0` 表示不限制轮数；`logs` 段控制日志级别/保留天数/单文件大小（旧版 `daemon.logLevel` 字段加载时自动迁移到 `logs.level`）。

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
用户消息
   │
   ▼
AgentEngine.run({ sessionId, userMessage, cwd, onEvent })
   │
   ├── 1. context 引擎构建系统提示词与请求视图（降级 fallback：静态提示 + 纯函数视图构建）
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
       │       ├── tool_call → 累积 id/name/args
       │       ├── finish → 记录 finishReason
       │       └── error → onEvent('error')
       ├── 7. 记录 assistant message（含 toolCalls）
       ├── 8. 无 tool_calls → 结束循环
       ├── 9. 有 tool_calls → 逐个执行:
       │   ├── onEvent('tool-call-start')
       │   ├── 参数自愈（context 引擎：JSON 修复/工具名纠正/schema 修正）
       │   ├── 内置工具: ToolRegistry.execute(ctx)
       │   │   └── ctx.askUser() → onEvent('ask') → 等待前端回复
       │   ├── MCP 工具: mcpManager.callTool(server, tool, args)
       │   ├── onEvent('tool-call-end')
       │   └── 记录 tool message 到 session
       └── 10. 继续下一轮
   │
   ▼
onEvent('done', finishReason)
返回 { sessionId, finishReason, finalText, history }
```

## 七、数据持久化

所有用户数据存储在 `~/.moss/`：

| 路径 | 用途 | 格式 |
|---|---|---|
| `~/.moss/config/config.json` | AppConfig | JSON |
| `~/.moss/config/api.json` | ApiConfig（v2 providers 结构） | JSON |
| `~/.moss/moss.pid` | 守护进程 PID | JSON |
| `~/.moss/logs/` | 日志文件（按保留策略轮转清理） | 文本 |
| `~/.moss/tasks/<groupId>/` | 任务分组目录（task.json 为任务元信息） | JSON |
| `~/.moss/tasks/<groupId>/<sessionId>.json` | 会话历史（每会话一文件） | JSON |
| `~/.moss/todo/<sessionId>.json` | 会话级 Todo 列表（每会话一文件） | JSON |
| `~/.moss/agenteam.json` | 自定义 Agent 列表（旧 agents.json 自动迁移） | JSON |
| `~/.moss/automations.json` | 自动化任务 | JSON |
| `~/.moss/automations-history.json` | 自动化运行历史 | JSON |
| `~/.moss/skills/` | 用户自定义 Skill（唯一运行时加载源；包内 skills/ 首次启动播种） | .md（YAML front-matter + body）|
| `~/.moss/agent/prompts/main/` | 用户自定义系统提示词 | .md |

## 八、相关文档

- [前后端 API 对接](./frontend-backend-api.md) —— REST 接口与 WebSocket 协议细节
