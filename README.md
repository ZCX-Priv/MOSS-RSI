<div align="center">

<img src="webui/public/MOSS.png" width="150" alt="MOSS Logo" />

# MOSS

**微内核 · 模块化 · 可扩展的 AI Agent 操作系统**

[![Version: 1.1.0](https://img.shields.io/badge/Version-1.1.0-brightgreen.svg)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun%20%3E%3D%201.1.0-orange.svg)](https://bun.sh)
[![UI: React 19](https://img.shields.io/badge/UI-React%2019-61dafb.svg)](https://react.dev)
[![Language: TypeScript](https://img.shields.io/badge/Language-TypeScript-3178c6.svg)](https://www.typescriptlang.org)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP-5e5ce6.svg)](https://modelcontextprotocol.io)

</div>

---

> [!WARNING]
> 尚未完全建造完成，后续破坏性变更较多，请勿用于生产环境！

---

## 简介

MOSS 是一个基于**微内核 + 模组化架构**的本地 AI Agent 应用，运行于 [Bun](https://bun.sh) 运行时之上。它以浏览器 Web UI 作为交互界面，以本地常驻服务作为核心载体，将 LLM 推理、工具执行、上下文管理、持久终端、浏览器/桌面操作、语音输入与任务调度整合为一套完整、可扩展的 Agent 运行环境，并支持局域网与公网隧道远程访问。

内核仅提供配置、事件、服务注册与日志四项基础能力，其余一切功能——从 Agent 引擎、LLM 路由到 HTTP 服务与定时任务——均以模组形式挂载，模组之间通过服务契约（`ServiceRegistry`）与事件总线（`EventBus`）解耦协作。模组由内核静态注册表按固定顺序加载（被依赖者在前），正向初始化、反向销毁。这种架构使 MOSS 既保持核心的精简稳定，又允许通过 Skill 在不触碰内核的情况下持续扩展能力边界。

## 核心特性

- **微内核架构** —— ConfigService / EventBus / ServiceRegistry / Logger 四大核心服务，21 个模组由内核静态注册表按固定顺序加载（被依赖者在前），正向初始化、反向销毁
- **ReAct Agent 引擎** —— 流式文本与思维链输出、多轮工具调用循环、任务引导/中断、上下文自动压缩与裁剪、工具结果智能折叠
- **多 LLM Provider 路由** —— 内置 openai-chat / openai-responses / anthropic / gemini 等接口格式，支持 DeepSeek、Anthropic、OpenAI、Gemini、Qwen、GLM、Kimi 等主流模型，按模型自动解析路由，支持 thinking 推理输出
- **MCP 双向支持** —— 作为客户端接入任意 Model Context Protocol 外部工具服务器；同时通过 `/mcp` 端点与 `moss mcp`（stdio）向外部 Agent 暴露 MOSS 工具
- **内置工具集** —— 19 个可配置内置工具（read / write / edit / delete / move / copy / glob / grep / terminal / todo / ask / web / skill / mcp / memory / context / automation / browser / computer）+ `use_command` 斜杠命令执行，写操作与命令执行可配置逐次确认
- **Skills 与自定义命令** —— 以 Markdown + YAML front-matter 定义的可复用技能与斜杠命令，支持用户自定义与热重载
- **子代理（Subagent）** —— `agent` 工具委派一次性子代理：内置 explorer / planner / coder / reviewer 模板、独立隐藏会话、嵌套深度保护与实时过程卡片
- **持久终端** —— 原生 PTY 会话：人类经 WebSocket 操作，Agent 经 terminal 工具操作，二者共用同一批终端
- **浏览器控制** —— Chrome 扩展桥接（CDP）、内置 Chrome、AI 标签页归组与页面操作
- **桌面操作** —— 集成 cua-driver：后台窗口观察、UIA、截图与输入
- **语音输入** —— 本地 sherpa-onnx（zipformer / SenseVoice / Whisper）、在线服务商与浏览器 WASM 本地推理
- **远程访问** —— 局域网直连 + cloudflared 公网隧道，8 位密码鉴权与请求门卫
- **记忆 / 规则 / 钩子** —— 四层记忆栈（L0-L3）BM25 检索与异步蒸馏；用户规则条件注入；生命周期钩子引擎
- **上下文工程** —— 拼接、压缩、自愈、预算校准、文件索引与遥测
- **文件历史** —— 编辑追踪、快照、撤回与恢复
- **自动化任务** —— 基于 cron 表达式与一次性定时（once）的调度，附带完整运行历史与暂停/恢复控制
- **现代 Web UI** —— React 19 + shadcn/ui + Tailwind 4，中英双语（i18next），PWA 离线可用，主题/字号/密度可调
- **安全默认** —— 默认仅绑定 127.0.0.1，支持 Bearer Token 鉴权，敏感工具独立确认开关

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                     浏览器 (Web UI)                      │
│      React 19 + shadcn/ui + Tailwind 4 + i18next        │
└──────────────┬──────────────────────┬───────────────────┘
               │ HTTP REST (/api/*)    │ WebSocket (/ws)
               ▼                      ▼
┌─────────────────────────────────────────────────────────┐
│                Server 模组 (Bun.serve :7766)             │
│         HTTP 路由 + WS 处理 + 静态资源服务                │
└──────────────┬──────────────────────────────────────────┘
               │ ServiceRegistry 依赖注入
               ▼
┌─────────────────────────────────────────────────────────┐
│                    微内核 (Kernel)                       │
│  ConfigService │ EventBus │ ServiceRegistry │ Logger     │
│        静态模块注册表（固定顺序编排生命周期）              │
└──────────────┬──────────────────────────────────────────┘
               │ 按固定顺序加载（被依赖者在前）
               ▼
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│  LLM 模组    │ Server 模组  │ Remote 模组  │ Tools 模组   │  MCP 模组    │Computer 模组 │
│ (多Provider) │  (HTTP+WS)   │ (远程访问)   │(工具+Skill)  │ (双向 MCP)   │ (桌面操作)   │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│ Browser 模组 │ Update 模组  │ Filesys 模组 │Terminal 模组 │ Safety 模组  │ Rules 模组   │
│ (浏览器控制) │ (版本检查)   │  (虚拟FS)    │ (持久终端)   │ (权限决策)   │ (用户规则)   │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│ Hooks 模组   │ Memory 模组  │ Voice 模组   │Context 模组  │ Agent 模组   │Subagent模组  │
│ (生命周期)   │ (记忆引擎)   │ (语音识别)   │(上下文引擎)  │(ReAct 引擎)  │ (子代理委派) │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
┌──────────────┬──────────────┬──────────────┐
│File-history  │ Daemon 模组  │Automation模组│
│ (文件历史)   │ (PID 维护)   │ (定时任务)   │
└──────────────┴──────────────┴──────────────┘
```

**模组一览（21 个，按内核加载顺序）：**

| 模组 | 职责 | 注册的标准服务 |
|---|---|---|
| `llm` | 多 Provider 路由与流式调用 | `llm.router` |
| `server` | HTTP + WebSocket 服务 | `server.instance` |
| `remote` | 远程访问：局域网直连 / cloudflared 隧道 / 请求门卫 | `remote.service` |
| `tools` | 内置工具 + Skill/Command 注册表 | `tool.registry`、`skill.registry`、`command.registry` |
| `mcp` | MCP 客户端管理 + 对外 MCP Server 暴露 | `mcp.manager`、`mcp.task.registry` |
| `computer` | 集成 cua-driver：后台桌面观察/操作（窗口、UIA、截图、输入） | `computer.service` |
| `browser` | 浏览器扩展桥接 / 内置 Chrome / AI 标签页 / CDP 操作 | `browser.service` |
| `update` | npm registry 版本检查 | — |
| `filesys` | 虚拟文件系统：roots 权限 / 读缓存 / 变更事件 | `file.sys` |
| `terminal` | 持久终端 PTY 会话管理 + 输出缓冲 + 状态 | `terminal.service` |
| `safety` | 统一权限决策 + 会话规则 | `safety.service` |
| `rules` | 用户规则引擎（存储 / 加载 / 条件注入） | `rules.engine` |
| `hooks` | 生命周期钩子引擎 | `hooks.engine` |
| `memory` | 记忆引擎（存储 / 检索 / 蒸馏） | `memory.engine` |
| `voice` | 语音识别（本地 sherpa-onnx / 在线服务商 / WASM） | `voice.service` |
| `context` | 上下文引擎（拼接 / 压缩 / 自愈 / 遥测 / 文件索引） | `context.engine` |
| `agent` | ReAct 循环、会话与任务管理、事件流 | `agent.engine` |
| `subagent` | Agent 注册表 + 一次性子代理运行 | `agent.registry`、`subagent.runner` |
| `file-history` | 文件历史（编辑追踪 / 快照 / 回滚） | `file.history` |
| `daemon` | 运行时 PID 文件维护 + 优雅退出 | — |
| `automation` | cron / once 定时任务调度 | `automation.service` |

内核自身另注册 `kernel.config`、`kernel.logger`、`kernel.modules` 三个基础服务。

## 快速开始

### 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| [Bun](https://bun.sh) | >= 1.1.0 | 后端运行时与测试 |
| [Node.js](https://nodejs.org) + npm | >= 18 | 前端依赖管理与开发工具链 |

### 安装

```bash
# 克隆仓库
git clone <repository-url>
cd MOSS-OS

# 安装后端依赖
npm install

# 安装前端依赖
cd webui
npm install
cd ..
```

> 浏览器扩展、语音模型与 cua-driver 均为按需启用：扩展可经 Web UI「设置 → 浏览器」打开扩展目录后手动加载；语音模型在设置中下载到 `~/.moss/models/asr/`；桌面操作在首次使用时由 computer 模组探测/安装驱动程序。

### 首次配置

MOSS 首次启动会自动在 `~/.moss/config/` 下生成配置模板（`api.json` 模板中 `providers` 为空数组）。编辑 `~/.moss/config/api.json`，按以下结构添加至少一个 Provider 并填入 API Key：

```json
{
  "version": 2,
  "providers": [
    {
      "id": "provider_0001",
      "name": "DeepSeek",
      "format": "openai-chat",
      "endpoint": "https://api.deepseek.com",
      "apiKey": "<你的 API Key>",
      "models": [
        {
          "id": "model_0001",
          "name": "DeepSeek Chat",
          "model": "deepseek-chat",
          "thinking": { "enabled": false }
        },
        {
          "id": "model_0002",
          "name": "DeepSeek Reasoner",
          "model": "deepseek-reasoner",
          "thinking": { "enabled": true, "effort": "high" }
        }
      ]
    }
  ]
}
```

其中 `models` 为对象数组，每个模型含 `id`（内部唯一标识）、`name`（显示名）、`model`（发送给 API 的模型名）与模型级 `thinking` 配置。

配置保存后无需重启，内核监听文件变更并自动热重载。

### 启动

```bash
# 前台运行（推荐首次使用，日志直接输出）
npm run start

# 或以守护进程方式后台运行
npm run start:daemon
```

启动后访问 **http://127.0.0.1:7766** 即可使用 Web UI。

## CLI 命令

```bash
moss start [--foreground]   # 启动服务（--foreground 前台运行，默认守护进程）
moss stop                   # 停止守护进程
moss status                 # 查看运行状态
moss restart                # 重启服务
moss mcp                    # 以 stdio 方式运行 MCP Server（供 Claude Desktop / Cursor 等调用）
moss update                 # 更新版本
moss version                # 查看当前版本
```

等价的 npm scripts 亦可使用：`npm run start / stop / status / restart / update / version`。

## 配置

所有配置与用户数据位于 `~/.moss/`：

| 文件 | 职责 |
|---|---|
| `~/.moss/config/config.json` | 应用配置：服务端口、守护进程、Agent 参数、工具开关、安全策略、远程访问、语音等 |
| `~/.moss/config/api.json` | 模型配置：Provider 列表、API Key、模型与 thinking 参数 |

**AppConfig 配置段：**

| 配置段 | 职责 |
|---|---|
| `server` | host / port / autoPort / locale |
| `daemon` | 是否以守护进程方式运行 |
| `logs` | 日志级别、保留天数、单文件大小 |
| `update` | 自动检查、channel（stable/beta）、检查间隔 |
| `agent` | 默认模型、maxTokens、maxTurns（0 = 不限轮）、工作目录、SSE 空闲超时 |
| `tools` | 各内置工具开关与确认策略（由工具目录下 `tool.json` 自动生成 schema） |
| `mcpServers` / `mcp` / `mcpServer` | 外部 MCP 服务器、客户端选项、对外 MCP Server 暴露 |
| `skills` / `commands` | Skill 与自定义斜杠命令的启停 |
| `security` | `authToken`、`bindLocalhostOnly` |
| `remote` | 远程访问总开关、局域网开关、密码开关、IP 覆盖 |
| `fileHistory` | 文件历史备份数量、保留天数、转录开关 |
| `filesys` | 授权 roots、读缓存上限、终端命令快照检测 |
| `safety` | 默认权限模式、确认超时、危险命令拦截、规则与保护路径 |
| `context` | 上下文压缩/修剪/自愈/遥测参数 |
| `web` | 默认联网搜索服务商 |
| `voice` | 语音输入开关、服务商、本地模型、语言 |

**支持的 Provider 接口格式：**

| format | 示例 endpoint | thinking 支持 |
|---|---|---|
| `openai-chat` | `https://api.openai.com/v1` | 否 |
| `openai-responses` | `https://api.openai.com/v1` | 是（effort） |
| `anthropic` | `https://api.anthropic.com/v1` | 是（effort + budgetTokens） |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | 是（budgetTokens） |

常用配置项（`config.json`）示例：

```json
{
  "server": { "host": "127.0.0.1", "port": 7766 },
  "agent": { "defaultModel": "deepseek-chat", "maxTokens": 8192 },
  "security": { "authToken": "", "bindLocalhostOnly": true },
  "remote": { "enabled": false, "lanEnabled": true },
  "voice": { "enabled": false, "language": "auto" }
}
```

- `security.authToken`：非空时所有 HTTP 请求需携带 `Authorization: Bearer <token>`
- `tools.*.requireConfirmation`：为 `write` / `delete` / `terminal` 等敏感工具启用逐次确认
- `remote.enabled`：开启后主服务绑定 `0.0.0.0` 并启用请求门卫（详见 [架构文档](docs/architecture.md)）
- 配置文件变更后 300ms 防抖自动重载，无需重启服务

## 技术栈

| 层 | 技术 |
|---|---|
| 后端运行时 | Bun + TypeScript |
| 内核 | 自研微内核（Zod 配置校验、fs.watch 热重载、静态注册表固定顺序加载） |
| LLM 接入 | openai-chat / openai-responses / anthropic / gemini 格式，流式 SSE |
| 工具协议 | Model Context Protocol (MCP) SDK（客户端 + 服务端） |
| 终端 | 原生 PTY + @xterm/headless（服务端）/ @xterm/xterm（前端） |
| 浏览器 | Chrome DevTools Protocol、Chrome for Testing、Manifest V3 扩展 |
| 桌面操作 | cua-driver（窗口 / UIA / 截图 / 输入） |
| 语音 | sherpa-onnx（本地）、在线 ASR 服务商、WebAssembly 浏览器推理 |
| 前端框架 | React 19 + React Router 7 |
| UI 组件 | shadcn/ui + Radix UI + Tailwind CSS 4 + Lucide Icons |
| 状态与数据 | Zustand + idb（IndexedDB） |
| 可视化 | Three.js / React Three Fiber、Mermaid、Shiki、KaTeX |
| 构建工具 | Vite 8（前端）、bun build（后端单文件打包） |
| 国际化 | i18next（中文 / English） |

## 项目结构

```
MOSS/
├── webui/                       # 前端（React 19 + shadcn/ui）
│   └── src/
│       ├── api/                 # HTTP + WS 客户端封装
│       ├── components/          # UI 组件
│       ├── hooks/               # 业务 hooks
│       ├── store/               # 全局状态
│       ├── i18n/                # 国际化（zh/en）
│       └── types/               # 前后端共享类型
├── src/
│   ├── main.ts                  # 入口：CLI 解析 + 启动 Kernel
│   ├── cli/                     # CLI 命令实现
│   ├── core/                    # 微内核（kernel/config/event-bus/...）
│   ├── modules/                 # 21 个模组（agent/subagent/automation/browser/
│   │                            #   computer/context/daemon/file-history/filesys/
│   │                            #   hooks/llm/mcp/memory/remote/rules/safety/
│   │                            #   server/terminal/tools/update/voice）
│   └── utils/                   # 通用工具
├── browser-extension/           # Chrome 扩展（MOSS Browser Bridge，Manifest V3）
├── agent/prompts/main/          # Agent 系统提示词（.md）
├── skills/                      # Skill 定义（.md + YAML front-matter，首次启动播种到 ~/.moss/skills/）
├── config/                      # 配置模板
├── docs/                        # 架构与 API 文档
├── scripts/                     # 构建/开发脚本（build/dev/install-webui/rebrand-icons）
└── bin/moss.js                  # CLI 入口
```

## 开发指南

### 开发模式

```bash
npm run dev
```

并行启动：

- 后端：`bun run --watch src/main.ts start --foreground --log-level debug`，监听 **7766** 端口，文件改动自动重启
- 前端：Vite dev server，监听 **3000** 端口，`/api` 与 `/ws` 自动代理到后端

访问 http://localhost:3000 进行开发调试，`Ctrl+C` 优雅退出全部子进程。

### 构建与测试

```bash
npm run build          # 构建后端（dist/server.js）+ 前端（dist/webui/）
npm run build:ui       # 仅构建前端
npm run build:backend  # 仅构建后端
npm run test           # 运行测试（bun test，当前 41 个单元测试）
npm run test:watch     # 监听模式测试
npm run typecheck      # TypeScript 类型检查（tsc --noEmit）
```

## 扩展体系

MOSS 提供两种扩展方式：

| 类型 | 位置 | 清单 | 上下文 | 权限 |
|---|---|---|---|---|
| **模组 (Module)** | `src/modules/*/` | —（内核静态 import 编排） | `ModuleContext` | 可注册受保护服务 |
| **Skill** | `~/.moss/skills/`（唯一加载源；包内 `skills/` 仅首次启动播种） | YAML front-matter | 工具调用 | Agent 按需加载执行 |

模组由内核静态注册表按固定顺序加载（被依赖者在前），新增模组需修改 `src/core/kernel.ts` 的 `MODULE_FACTORIES` 注册表。

## 文档

- [系统架构详述](docs/architecture.md) —— 微内核、模组系统、Agent 工作流、远程访问、数据持久化
- [前后端 API 对接](docs/frontend-backend-api.md) —— REST 接口与 WebSocket 协议细节

## License

本项目基于 [MIT License](LICENSE) 开源。
