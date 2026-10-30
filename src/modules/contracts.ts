// src/modules/contracts.ts
// 跨模块服务接口契约。
// 各业务模块实现这些接口，通过 ServiceRegistry 注册；其他模块按需 resolve。
// 这样避免模块之间的直接依赖，所有跨模块通信都通过接口契约。

import type {
  UnifiedRequest,
  UnifiedResponse,
  StreamDelta,
} from './llm/types';
import type { Tool, ToolContext, ToolResult, AskOutcome, AskQuestion } from './tools/types';
import type { TodoItem } from './tools/todo/shared/store';
import type {
  FileHistoryEntry,
  TrackRequest,
  ChangeTracker,
  UndoResult,
  NetFileChange,
  WatchChangeRequest,
} from './file-history/types';
export type { FilesysService, TerminalChangeReport } from './filesys/types';
export type { TerminalService, TerminalInfo, TerminalRunResult, InterpreterKind } from './terminal/types';
export type {
  ComputerService,
  ComputerStatus,
  ComputerActivity,
  ComputerWindowInfo,
  ComputerCapture,
  ComputerToolResult,
  ComputerCallOptions,
} from './computer/types';
export type {
  BrowserService,
  BrowserStatus,
  BrowserMode,
  BrowserCdpStatus,
  BrowserInstanceInfo,
  BrowserTabInfo,
  BrowserBuiltinStatus,
  BrowserExtensionStatus,
  BrowserCftStatus,
  BrowserBridgeStatus,
  BrowserSnapshot,
  BrowserScreenshot,
  BrowserPageInfo,
  BrowserConsoleEntry,
  BrowserConsoleResult,
  BrowserToolConfig,
  BrowserInstallerStatus,
  BrowserInstallerBrowser,
  BrowserInstallerState,
} from './browser/types';
import type { PermissionMode, SafetyDecision, SafetyRequest } from './safety/types';
export type { PermissionMode, SafetyDecision, SafetyRequest } from './safety/types';

// ============================================================================
// LLM Router（由 LLM 插件注册，ServiceNames.LLM_ROUTER）
// ============================================================================

export interface LLMRouter {
  /**
   * 发送非流式请求。
   * @param req 统一请求（req.model 为 ModelConfig.id 或 API 模型名）
   * @param signal 中断信号，传入后底层 HTTP 请求可被外部 abort
   */
  complete(req: UnifiedRequest, signal?: AbortSignal): Promise<UnifiedResponse>;

  /**
   * 发送流式请求。
   * @param signal 中断信号，传入后底层 HTTP 请求可被外部 abort
   * @returns 异步迭代器，逐个产出 StreamDelta
   */
  stream(req: UnifiedRequest, signal?: AbortSignal): AsyncIterable<StreamDelta>;
}

// ============================================================================
// Tool Registry（由 Tools 插件注册，ServiceNames.TOOL_REGISTRY）
// ============================================================================

export interface ToolRegistry {
  /** 注册工具 */
  register(tool: Tool): void;
  /** 注销工具 */
  unregister(name: string): void;
  /** 获取工具 */
  get(name: string): Tool | null;
  /** 列出所有工具 */
  list(): Tool[];
  /** 列出所有工具的 schema（供 LLM 注入） */
  listSchemas(): Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    annotations?: Record<string, unknown>;
  }>;
  /** 判断工具是否启用（从 config.tools[name].enabled 读取，缺失默认 true） */
  isEnabled(name: string): boolean;
  /** 执行工具 */
  execute(name: string, params: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ============================================================================
// Context Engine（由 Context 插件注册，ServiceNames.CONTEXT_ENGINE）
// ============================================================================

import type {
  CompactPreview,
  CompactionRecord,
  ContextSessionLike,
  ContextStats,
  HealResult,
  ManualCompactResult,
  PreparedRequest,
  SessionStoreBridge,
} from './context/types';

/** agent 引擎调用 prepareRequest 的输入参数 */
export interface ContextPrepareOptions {
  cwd: string;
  /** 主模型请求名 */
  model: string;
  modelDisplayName: string;
  /** 上下文窗口 token（缺省由引擎从模型配置解析） */
  windowTokens?: number;
}

/** 文件索引服务（上下文引擎子模块；三引擎编排）——结构子集（工具层/路由层用） */
export interface FileIndexServiceLike {
  /** glob 查询（索引 ready 时内存匹配；否则 null 回退遍历） */
  queryFiles(
    cwd: string,
    q: {
      positiveGlobs: readonly unknown[];
      negativeGlobs: readonly unknown[];
      typeGlobs: readonly unknown[] | null;
      includeDirs: boolean;
      sortBy: 'mtime' | 'path';
      offset: number;
      maxResults: number;
    },
  ): Promise<{
    page: Array<{ rel: string; name: string; ext: string; size: number; mtimeMs: number; isDir: boolean; kind: string }>;
    total: number;
    truncated: boolean;
  } | null>;
  /** 文本文件枚举（grep 加速；索引不可用返回 null） */
  listTextFiles(
    cwd: string,
  ): Promise<Array<{ rel: string; name: string; ext: string; size: number; mtimeMs: number; isDir: boolean; kind: string }> | null>;
  /** 影响面文本（edit/write 结果附加；图谱未就绪返回 null） */
  impactHint(cwd: string, relPath: string): Promise<string | null>;
  /** SAG 多跳语义检索 */
  search(cwd: string, query: string, topK?: number): Promise<Array<{
    chunkId: number;
    file: string;
    startLine: number;
    endLine: number;
    summary: string;
    score: number;
    matchedEntities: string[];
  }>>;
  /** 项目概要文本（锚定消息注入用） */
  projectOverview(cwd: string): Promise<string | null>;
}

/**
 * 上下文引擎服务契约（基础设施级：拼接/压缩/自愈/预算/治理/遥测）。
 * agent 模块为调用方：run 循环每轮调用 prepareRequest，工具执行前调用 healToolCall。
 */
export interface ContextEngine {
  /** 每轮 LLM 请求前的统一流水线（env 保障 → 压缩决策 → 视图构建） */
  prepareRequest(session: ContextSessionLike, opts: ContextPrepareOptions): Promise<PreparedRequest>;
  /** 工具调用自愈：参数修复 → 工具名纠正 → schema 校验修正 */
  healToolCall(toolName: string, args: string): HealResult;
  /** agent 模块注入会话存取桥（get/persist；依赖方向 agent → context） */
  bindSessionStore(bridge: SessionStoreBridge): void;
  /** run 开始/结束的 busy 标记（手动压缩仅空闲可用） */
  markBusy(sessionId: string): void;
  markIdle(sessionId: string): void;
  /** engine 每轮流结束后上报 usage（缓存命中采样 + tokPerChar 校准 + 最近一次真实 usage 记录） */
  onTurnUsage(
    sessionId: string,
    usage: { promptTokens: number; cachedTokens: number; completionTokens?: number },
  ): void;
  /** 手动压缩（空闲时；focus 为附加焦点） */
  manualCompact(sessionId: string, focus?: string): Promise<ManualCompactResult>;
  /**
   * 模型自主压缩（运行中可用；context 工具 action=compact 调用）。
   * 与 manualCompact 复用同一压缩流程，但跳过 busy 检查，并以重入锁防并发。
   */
  compactNow(sessionId: string, focus?: string): Promise<ManualCompactResult>;
  /** 手动压缩预览（确认框数据） */
  previewCompact(sessionId: string): CompactPreview | null;
  /** 会话上下文统计（token 构成/缓存命中/压缩状态/系统分段） */
  getStats(sessionId: string): ContextStats | null;
  /** 压缩历史 */
  getCompactions(sessionId: string): CompactionRecord[];
  /** 文件索引服务访问器（三引擎；默认关闭时方法安全降级） */
  getFileIndex(): FileIndexServiceLike;
  /**
   * 确认「本轮请求已成功送达」→ 把本轮内联发送过图片的消息标记为已发送（落盘）。
   * 之后这些图片在发送视图中降级为占位符（避免历史 base64 每轮重发撑爆请求体）。
   */
  confirmImagesSent(sessionId: string): void;
  /** 请求失败/中断 → 放弃本轮图片「已发送」标记（下次仍会重新发送该图片）。 */
  discardImagesSent(sessionId: string): void;
}

// ============================================================================
// Agent Engine（由 Agent 插件注册，ServiceNames.AGENT_ENGINE）
// ============================================================================

export interface AgentEngine {
  /**
   * 启动一轮任务（ReAct 循环）。
   * 流式事件通过 onEvent 回调推送。
   * @returns 最终的 assistant 消息
   */
  run(input: AgentRunInput): Promise<AgentRunResult>;

  /**
   * 创建真实任务（侧边栏可见；task.id 即 sessionId）。
   * automation 等后台模块用它把运行挂到真实任务上。
   */
  createTask(title: string, groupId?: string, id?: string): import('./agent/task-store').TaskItem;

  /** 列出全部分组（含隐藏分组，供内部按 id/名查找；HTTP 边界另行过滤） */
  listTaskGroups(): import('./agent/task-store').TaskGroup[];

  /** 会话级权限模式（子代理继承父会话模式 / 刷新恢复徽章用） */
  getPermissionMode?(sessionId: string): PermissionMode | undefined;

  /**
   * 标记会话为 headless（子代理/团队成员等无人交互的会话）。
   * headless 会话的权限确认不再等满默认超时，而是快速失败并给出明确文案。
   */
  markSessionHeadless?(sessionId: string, headless: boolean): void;

  /** 删除分组（清理隐藏分组与衍生会话用） */
  deleteTaskGroup(
    id: string,
    opts?: { moveTasksTo?: string; deleteTasks?: boolean },
  ): boolean;

  /** 创建分组（source='folder' / hidden 的空组由 task-store 自动销毁；dir 支持嵌套目录） */
  createTaskGroup(
    name: string,
    source?: 'folder' | 'manual',
    opts?: { id?: string; dir?: string; hidden?: boolean },
  ): import('./agent/task-store').TaskGroup;

  /**
   * 前端回复 ask 工具的提问（accept=已回答 / cancel=取消）。
   * 必须携带会话 ID：不同会话的 toolCallId 可能重复，按 session+toolCallId 定位避免串话。
   * @returns true 表示匹配到本会话的 pending ask 并已 resolve；false 表示无匹配（可能已超时或不存在）。
   */
  resolveAsk(sessionId: string, toolCallId: string, outcome: AskOutcome): boolean;

  /**
   * 前端回复 confirm 确认。
   * @param remember 「始终允许」级别：session=写会话规则（内存）；global=写 config.safety.rules（持久）
   * @returns true 表示匹配到本会话的 pending confirm 并已 resolve；false 表示无匹配（可能已超时或不存在）。
   */
  resolveConfirm(sessionId: string, toolCallId: string, ok: boolean, remember?: 'session' | 'global'): boolean;

  /**
   * 消息撤回预览（dryRun）：定位目标用户消息，列出将被删除的消息与将被回滚的文件变更。
   * @param sessionId 会话 ID
   * @param messageTimestamp 前端用户消息的 timestamp（定位依据；找不到时回退 content 匹配）
   * @param content 用户消息文本（timestamp 定位失败时的回退依据）
   */
  previewTruncate(
    sessionId: string,
    messageTimestamp: string,
    content: string,
  ): TruncatePreview | null;

  /**
   * 执行消息撤回（截断）：软删除目标用户消息及其后全部消息，
   * 并联动 file-history 回滚该区间内 AI 产生的文件变更（回滚前自动备份，支持 redo）。
   * 成功后向该 session 推送 session-truncated WS 事件。
   * @param options.rollbackFiles 是否联动 file-history 回滚文件变更（默认 true）；传 false 时不回滚（供「重新生成」使用）
   */
  truncateFrom(
    sessionId: string,
    messageTimestamp: string,
    content: string,
    options?: { rollbackFiles?: boolean },
  ): Promise<TruncateResult | null>;

  /**
   * 恢复最近一次消息撤回（redo）：清除软删除标记 + 从回滚备份恢复文件。
   * 成功后向该 session 推送 session-restored WS 事件。
   */
  restoreTruncate(sessionId: string): Promise<TruncateRestoreResult | null>;

  /**
   * 会话历史分页视图（含服务端绝对 index，供前端做稳定 id 与游标分页）。
   * @param opts.limit 返回条数（缺省 = 全量，保持旧调用方兼容）
   * @param opts.before 返回 index < before 的区间（上滑加载更早）
   * @param opts.after 返回 index > after 的区间（断线/完成后的尾部补齐）
   */
  getHistoryPage?(
    sessionId: string,
    opts?: { limit?: number; before?: number; after?: number },
  ): {
    messages: Array<AgentMessage & { index: number }>;
    total: number;
    oldestIndex: number;
    newestIndex: number;
    hasMoreBefore: boolean;
  };

  /** 进行中的流式草稿（刷新/重连后恢复半截回复 + 续接 offset） */
  getLiveDraft?(sessionId: string): import('./agent/live-draft').LiveDraft | null;

  /**
   * 历史智能检索（BM25）：检索「本对话原始上下文」或「跨 session 全量历史」。
   * 原始消息始终保存在 session JSON 中；压缩折叠只是从发送视图移除，检索仍可命中。
   * @param input.scope 'current'=仅 sessionId 指定会话；'all'=全部会话
   * @param input.includeCompacted 是否纳入已压缩（compacted）消息（默认 true）
   */
  searchMessages(input: HistorySearchInput): HistorySearchResult[];
}

/** 历史检索输入 */
export interface HistorySearchInput {
  query: string;
  scope: 'current' | 'all';
  /** scope='current' 时的目标会话 */
  sessionId?: string;
  /** 返回条数上限（默认 10，最大 50） */
  topK?: number;
  /** 是否包含已压缩（compacted）消息（默认 true） */
  includeCompacted?: boolean;
  /** 是否包含工具结果消息（默认 false，通常噪声较大） */
  includeTool?: boolean;
}

/** 历史检索命中项 */
export interface HistorySearchResult {
  sessionId: string;
  /** 消息在该会话全量数组中的下标 */
  index: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 命中片段（截断展示） */
  snippet: string;
  /** BM25 得分（降序） */
  score: number;
  /** 该消息是否已被压缩折叠（原文仍在，仅不在发送视图） */
  compacted: boolean;
  timestamp?: string;
}

export interface AgentRunInput {
  sessionId: string;
  /** 用户最新输入文本 */
  userMessage: string;
  /** 本轮用户消息的附件绝对路径（纯路径引用；随用户消息持久化并由前端渲染卡片） */
  attachments?: string[];
  /** 模型名（可选，默认从配置） */
  model?: string;
  /** Agent 配置 ID（可选；指定后按该 Agent 的 systemPrompt/model/tools/maxTurns/maxTokens/maxTokens 执行） */
  agentId?: string;
  /**
   * 权限模式（前端 PermissionModeSelector 会话级传递）：
   * 'ask'=手动审批 / 'auto'=自动审批（L2 放行 L3 确认） / 'skip'=完全访问（仅查禁用）
   */
  permissionMode?: PermissionMode;
  /** 工作目录 */
  cwd: string;
  /** 流式事件回调 */
  onEvent: (event: AgentEvent) => void;
  /** 中断信号 */
  signal?: AbortSignal;
  /** 运行实例 ID（前端生成，用于隔离不同 run 的事件） */
  runId?: string;
  /**
   * 前端为这条用户消息生成的稳定 id（随用户消息持久化，历史接口原样返回）。
   * 用途：前端「乐观写入的用户消息」与「服务端持久化副本」使用同一身份，
   * 尾部补齐/分页合并时按 id 天然去重，不会出现同一条消息渲染两份。
   */
  clientMessageId?: string;
  /** 引导消息队列（引导模式下，工具调用完成后检查并中止当前 run） */
  guideMessages?: GuidanceMessage[];
}

/**
 * 单次运行（run）级统计（每次用户发送消息后重置，跨轮累加）。
 * 前端中控台指标栏数据源：
 * - turns/steps：LLM 调用轮数 / 工具调用步数
 * - llmMs/toolMs：LLM 流式调用总耗时 / 工具执行总耗时
 * - ttftCount+ttftMsTotal：首 token 延迟样本（平均 = total/count）
 * - decodeMs：Σ(轮耗时−轮TTFT)，tok/s = outputTokens/decodeMs
 * - cachedTokens/inputTokens：缓存命中率 = cached/input（token 加权）
 */
export interface RunStats {
  runId?: string;
  turns: number;
  /** 本次 run 的轮数（每次 run 重置；与 turns 的会话级累计口径区分，供 X/N 进度显示） */
  runTurns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftCount: number;
  ttftMsTotal: number;
  decodeMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * 流式事件携带的续传信息（offset 协议）：
 * - messageId：本轮流式 assistant 消息的稳定 id（`<sessionId>#<msgSeq>`，
 *   msgSeq 为会话级单调序号，每 turn 消耗一个），
 *   逐轮唯一 → 每个 messageId 拥有独立的 offset 空间，前端据此判断「是否同一轮」。
 * - offset：该分片在其所属字段（content / thinking / 工具 arguments）中的起始字符下标。
 * - total：该分片结束后的累计长度（前端自检用）。
 * 前端 applyDelta 依据 offset 做「去重（重复投递）+ 续接（刷新/重连后接流）」。
 */
export interface StreamChunkMeta {
  messageId?: string;
  offset?: number;
  total?: number;
}

export type AgentEvent =
  /**
   * 用户消息已持久化（引擎统一发出，覆盖 WebUI / IM / MCP / 自动化等全部入口）。
   * 外部 run 没有前端乐观副本，必须靠该事件把用户消息实时同步到已订阅该会话的客户端；
   * clientMessageId 与历史副本同身份，尾部补齐时按 id 原位归并，不会重复渲染。
   */
  | {
    type: 'user-message';
    sessionId: string;
    content: string;
    /** 用户消息持久化时间（与 session.messages 中的副本一致，前端据此排序） */
    timestamp: string;
    /** 附件绝对路径（与 task.stream 的 attachments 语义对齐） */
    attachments?: string[];
    /** 用户消息的稳定身份（随消息持久化、历史接口原样返回） */
    clientMessageId: string;
    runId?: string;
  }
  | ({ type: 'assistant-text'; sessionId: string; text: string; runId?: string } & StreamChunkMeta)
  | ({ type: 'assistant-thinking'; sessionId: string; text: string; runId?: string } & StreamChunkMeta)
  | ({ type: 'tool-call-start'; sessionId: string; toolName: string; toolCallId: string; args: unknown; runId?: string } & StreamChunkMeta)
  | ({ type: 'tool-call-delta'; sessionId: string; toolCallId: string; argumentsDelta: string; runId?: string } & StreamChunkMeta)
  | ({ type: 'tool-call-executing'; sessionId: string; toolName: string; toolCallId: string; runId?: string } & StreamChunkMeta)
  | ({ type: 'tool-call-end'; sessionId: string; toolName: string; toolCallId: string; result: ToolResult; runId?: string } & StreamChunkMeta)
  | { type: 'ask'; sessionId: string; toolCallId: string; questions: AskQuestion[]; runId?: string }
  | { type: 'ask-timeout'; sessionId: string; toolCallId: string; runId?: string }
  | { type: 'confirm-required'; sessionId: string; toolCallId: string; toolName: string; question: string; details?: unknown; runId?: string; ruleSuggestion?: string }
  | { type: 'confirm-cancel'; sessionId: string; toolCallId: string; runId?: string }
  | { type: 'skill-mode'; sessionId: string; action: 'enter' | 'switch' | 'exit' | 'error'; name?: string; icon?: string; message?: string; runId?: string }
  | { type: 'stats-updated'; sessionId: string; stats: RunStats; runId?: string }
  | { type: 'error'; sessionId: string; message: string; runId?: string; providerError?: string; messageId?: string }
  | { type: 'done'; sessionId: string; finishReason: string; runId?: string };

export interface AgentRunResult {
  sessionId: string;
  /** max_turns = 达到工具调用最大轮数上限（agent.maxTurns） */
  finishReason: 'stop' | 'length' | 'error' | 'aborted' | 'max_turns';
  finalText: string;
  /** 完整的会话历史（含本轮） */
  history: AgentMessage[];
  /** 引导中止标记：工具调用完成后检测到引导消息，需自动启动新 run */
  guideInterrupt?: boolean;
  /** 引导消息内容（引导中止时携带，供 WsHandler 启动新 run） */
  guideMessage?: string;
  /** 引导消息附带的附件绝对路径（与 guideMessage 配对，供新 run 记录到用户消息） */
  guideAttachments?: string[];
}

/** 引导消息（引导模式下运行期间插入的用户消息） */
export interface GuidanceMessage {
  /** 用户输入文本 */
  message: string;
  /** 附件绝对路径（纯路径引用；透传到新 run 的用户消息上） */
  attachments?: string[];
  /** 前端为这条消息生成的稳定 id（续跑的 run 持久化时写入，保证与本地乐观副本同身份） */
  clientMessageId?: string;
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * 本轮流式 assistant 消息的稳定身份（`<sessionId>#<turn>`，逐轮唯一）。
   * 落盘时从 liveDraft 写入；前端历史回放据此把「服务端正式消息」与「本地流式草稿」
   * 对齐为同一实体（同 id 原位 patch 而非删旧插新），消除回复结束时的重挂载闪烁。
   */
  messageId?: string;
  /** 用户消息附带的附件绝对路径（role=user；纯路径引用，供前端渲染附件卡片） */
  attachments?: string[];
  /**
   * 工具结果附带的图片绝对路径（role=tool；纯路径引用，base64 不落库）。
   * 发送请求时由 view-builder 实时读盘编码为多模态内容。
   */
  images?: string[];
  /**
   * 该消息附带的图片「已发送过」的时间（ISO 8601；role=user 的 attachments 与 role=tool 的 images 共用）。
   * 图片只在首次进入请求视图的那一轮以 base64 发送；此后构建视图时不再读盘内联，
   * 改为占位符（附原始路径，模型可随时用 read 工具重新查看）。
   * 目的：避免历史图片 base64 每轮重发导致请求体字节数无界增长（HTTP 413）。
   */
  imagesSentAt?: string;
  /**
   * 前端为该用户消息生成的稳定 id（role=user；前端随消息下发，后端持久化并原样返回）。
   * 前端据此把「乐观写入的本地消息」与「历史回放的同一条消息」视为同一实体，避免重复渲染。
   */
  clientMessageId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    /** JSON 字符串（与 UnifiedToolCall.function.arguments 对齐） */
    arguments: string;
  }>;
  toolCallId?: string;
  thinking?: string;
  /**
   * 思考签名（Anthropic thinking block 的 signature；流式 signature_delta 采集）。
   * 回传给 Anthropic 时须与 thinking 一同原样携带；其他 provider 不使用。
   */
  thinkingSignature?: string;
  /**
   * 本轮流式思考耗时（毫秒）：首个 thinking 分片到首个非思考内容分片之间的时长。
   * 落盘用于前端刷新/重进会话后展示「已完成思考 · Ns」。
   */
  thinkingMs?: number;
  /** 工具名（role=tool 时，部分 provider 用 name 区分工具来源） */
  name?: string;
  /** 工具结果是否为错误（role=tool 时；持久化用于前端刷新恢复错误样式） */
  isError?: boolean;
  /** 工具结果元信息（role=tool 时；如 command/cwd/exitCode/structuredContent/resources） */
  metadata?: Record<string, unknown>;
  /** 该 assistant 消息内 todo 工具调用完成时的 todos 快照（用于前端按调用时刻渲染） */
  todoSnapshot?: TodoItem[];
  /** 消息创建时间（ISO 8601；旧数据可能缺失）。消息撤回的时间区间定位依据 */
  timestamp?: string;
  /** 软删除时间（ISO 8601）。非空表示已被消息撤回截断，构建 LLM 上下文时过滤 */
  deletedAt?: string;
  /**
   * 压缩折叠标记：该消息已被压缩摘要替代（发送视图排除）。
   * 上下文引擎物理折叠时写入；原始上下文仍保存在 session JSON 中供检索。
   */
  compacted?: boolean;
}

/** 消息撤回（截断）预览结果 */
export interface TruncatePreview {
  /** 将被删除的消息（含目标用户消息及其后全部） */
  messagesToRemove: Array<{ index: number; role: string; content: string; timestamp?: string }>;
  /** 将被回滚的文件变更（来自 file-history transcript 时间区间） */
  fileChanges: Array<{ absPath: string; operation: string; toolName: string; timestamp: string }>;
  /** 文件回滚被跳过的原因（诚实降级：不再静默跳过，前端如实提示） */
  rollbackSkippedReason?: 'no-file-history' | 'no-timestamp';
}

/** 消息撤回（截断）执行结果 */
export interface TruncateResult {
  /** 被软删除的消息数 */
  removedCount: number;
  /** 成功回滚的文件数 */
  rolledBackFiles: number;
  /** 回滚失败的条目 */
  rollbackFailed: Array<{ absPath: string; error: string }>;
  /** 截断起点时间戳（前端据此删除本地消息） */
  truncatedBeforeTimestamp: string;
  /** 是否回滚了文件变更 */
  fileRollbackPerformed: boolean;
  /** 文件回滚被跳过的原因（诚实降级：不再静默跳过，前端如实提示） */
  rollbackSkippedReason?: 'no-file-history' | 'no-timestamp' | 'skipped-by-caller';
}

/** 消息撤回恢复（redo）结果 */
export interface TruncateRestoreResult {
  /** 恢复的消息数 */
  restoredCount: number;
  /** 成功恢复的文件数 */
  restoredFiles: number;
  /** 恢复失败的条目 */
  restoreFailed: Array<{ absPath: string; error: string }>;
}

// ============================================================================
// MCP Manager（由 MCP 插件注册，ServiceNames.MCP_MANAGER）
// ============================================================================

/** MCP 工具注解（从 MCP 服务器透传） */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface MCPManager {
  /** 列出所有已定义 MCP 服务器（含未连接与禁用） */
  listServers(): Array<{
    name: string;
    status: 'connected' | 'disconnected' | 'error';
    toolCount: number;
    enabled: boolean;
    transport?: string;
  }>;
  /** 列出指定服务器的工具（仅已连接且启用的服务器；透传 annotations/title） */
  listTools(serverName?: string): Array<{
    server: string;
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: McpToolAnnotations;
  }>;
  /** 查询某服务器定义的启用状态（未定义返回 null） */
  isServerEnabled(serverName: string): boolean | null;
  /** 查询某 MCP 工具的注解（server 未连接或工具不存在返回 null） */
  getToolAnnotations(serverName: string, toolName: string): McpToolAnnotations | null;
  /** 调用 MCP 工具（structured 输出与 resource 完整保留；opts 控制超时/中断/elicitation） */
  callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    opts?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      /** elicitation 桥：MCP 服务器向用户请求输入（缺省时 decline） */
      elicit?: (req: {
        message: string;
        requestedSchema?: Record<string, unknown>;
      }) => Promise<
        | { action: 'accept'; content: Record<string, string | number | boolean> }
        | { action: 'decline' }
        | { action: 'cancel' }
      >;
    },
  ): Promise<{
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
      | { type: 'resource'; uri: string; mimeType?: string; text?: string; blob?: string }
    >;
    isError?: boolean;
    /** MCP structured output（2025-06-18 规范），存在时优先于 text 解析 */
    structured?: unknown;
  }>;
  /** 启动/重启指定服务器 */
  connect(serverName: string): Promise<void>;
  /** 断开指定服务器 */
  disconnect(serverName: string): Promise<void>;
  /** 重载所有服务器（配置变更后） */
  reloadAll(): Promise<void>;
  /** 新建服务器定义（写 ~/.moss/mcps/<name>.json 并尝试连接） */
  createServer(name: string, def: unknown): Promise<void>;
  /** 更新服务器定义（写回文件，目录 watch 自动 reload） */
  updateServer(name: string, def: unknown): Promise<void>;
  /** 删除服务器定义（先断开，再删 ~/.moss/mcps/<name>.json） */
  deleteServer(name: string): Promise<void>;
}

// ============================================================================
// Server Instance（由 Server 插件注册，ServiceNames.SERVER_INSTANCE）
// ============================================================================

export interface ServerInstanceLike {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  broadcastWS(message: unknown): void;
  sendToSession(sessionId: string, message: unknown): void;
  /** 外部 run（MCP 派发 / 自动化）转发 agent 事件到 session 订阅者（高频类型自动合帧） */
  sendAgentEvent(sessionId: string, event: AgentEvent): void;
  /** 注册外部发起的活跃 run（automation 等不经 task.stream 的运行）：
   *  session.subscribe/task.switch 的 running 判定包含该 session；task.abort 可中断 */
  registerExternalRun(sessionId: string, controller: AbortController): void;
  /** 注销外部活跃 run（仅当注册的 controller 仍是当前活跃 run 时移除，防误删用户新 run） */
  unregisterExternalRun(sessionId: string, controller: AbortController): void;
  /**
   * 该会话是否仍有任务在跑（权威运行态）。
   * 覆盖 task.stream 与 registerExternalRun 注册的全部 run（automation / MCP 等），
   * 供任务列表与状态快照接口给出「刷新后不丢」的运行态。
   */
  isSessionRunning?(sessionId: string): boolean;
}

// ============================================================================
// File History Service（由 file-history 模块注册，ServiceNames.FILE_HISTORY）
// 三层文件历史架构：Track（统一变更追踪）+ Snapshot（每轮快照）+ JSONL 持久化
// ============================================================================

export interface FileHistoryService {
  /**
   * 统一变更追踪入口（tracker 对象模式）：变更前调用（terminal 为事后回填调用）。
   * 内部按 toolName 分发：write/edit/delete 做改前备份（文件不存在记 create 收据）；
   * move/copy 构造无备份收据；terminal 按 terminalBefore 缓存内容回填备份。
   * @returns ChangeTracker：变更后调 tracker.commit(after) 登记历史条目；
   *          变更失败不调 commit 即丢弃（孤儿备份由 retention 回收）。
   *          enabled=false 时返回 no-op tracker。
   */
  track(req: TrackRequest): Promise<ChangeTracker>;

  /** 校验本会话是否 read 过该文件（read-before-mutate 约束） */
  isRead(sessionId: string, absPath: string): boolean;

  /** 标记文件已被 read（read 工具调用时注册，传入内容 sha） */
  markRead(sessionId: string, absPath: string, sha: string): void;

  /** Layer 2：创建快照（每轮 LLM 响应后异步调用）。当前实现为 no-op，预留扩展点。 */
  createSnapshot(sessionId: string): Promise<void>;

  /** 撤销最近 N 次文件变更（默认 1 次）。先恢复成功再移除条目，失败条目保留可重试。 */
  undo(sessionId: string, steps?: number): Promise<UndoResult>;

  /** 列出某会话的文件历史（前端 UI 用；含已回滚标记条目） */
  listHistory(sessionId: string): FileHistoryEntry[];

  /**
   * 实时文件监控登记一次外部变更：before 自动写入内容寻址备份，
   * 与最近条目按 hash/时间窗口去重后写 transcript。
   */
  recordWatchChange(req: WatchChangeRequest): void;

  /** 按文件聚合的净差异（「文件变更」面板主视图数据源） */
  listNetChanges(sessionId: string): NetFileChange[];

  /** 本会话活跃条目涉及的路径去重列表（终端快照预读/监控补全用） */
  listTrackedPaths(sessionId: string): string[];

  /**
   * 回滚时间区间内的全部文件变更（消息撤回联动，标记制）。
   * Phase 1 全量 redo 备份（不动文件）；Phase 2 逆序恢复，成功才追加
   * toolName='rollback' 的 R 条目（含 rollbackOf 反向引用）并给原始条目打
   * rolledBackAt 标记（不物理删除，redo 后清除标记，支持无限次撤回/恢复循环）。
   * @returns rollback entry id 列表（供 redoRollback）
   */
  rollbackRange(sessionId: string, fromTs: string, toTs: string): Promise<{
    rollbackIds: string[];
    failed: Array<{ absPath: string; error: string }>;
  }>;

  /**
   * 恢复一次回滚（redo）：按 rollbackOf 配对——单条 R 恢复成功则移除该 R
   * 并清除对应原始条目的 rolledBackAt 标记；失败的 R 保留（可重试）。
   */
  redoRollback(sessionId: string, rollbackIds: string[]): Promise<{
    failed: Array<{ absPath: string; error: string }>;
  }>;

  /** 恢复到指定历史条目（前端 UI 用，撤销该条目对应的变更；拒绝已回滚/R 条目） */
  restore(sessionId: string, entryId: string): Promise<UndoResult>;

  /** 清理会话资源（会话结束时调用，清空内存 ledger） */
  clearSession(sessionId: string): void;

  /** 获取回收站目录路径（供 delete 工具 trash 模式调用 moveToTrash） */
  getTrashDir(): string;
}

// ============================================================================
// Safety Service（由 safety 模块注册，ServiceNames.SAFETY）
// 统一权限决策入口：所有工具（builtin/custom/MCP/mcp）执行前必须经过 evaluate。
// ============================================================================

export interface SafetyService {
  /** 全局默认权限模式（config.safety.defaultMode） */
  getDefaultMode(): PermissionMode;
  /** 确认超时（分钟；0=永不超时） */
  getConfirmTimeoutMinutes(): number;
  /** 统一权限决策（allow=放行 / ask=需用户确认 / deny=拒绝） */
  evaluate(req: SafetyRequest): SafetyDecision;
  /** 添加会话级规则（「始终允许(会话)」；内存存储，刷新失效） */
  addSessionRule(sessionId: string, list: 'allow' | 'deny' | 'ask', rule: string): void;
  /** 清理会话规则（会话删除时调用） */
  clearSessionRules(sessionId: string): void;
  /** 添加全局持久规则（「始终允许(全局)」→ config.safety.rules + 广播 config:changed） */
  addGlobalRule(list: 'allow' | 'deny' | 'ask', rule: string): Promise<boolean>;
  /** 生成「始终允许」规则建议（terminal 智能前缀 / MCP 全名 / 工具名） */
  generateRuleSuggestion(toolName: string, params: unknown): string;
}
