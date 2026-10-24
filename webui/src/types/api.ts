// UI/src/types/api.ts
// 前后端共享 API 类型定义（前后端对接契约的单一真相源）
// 依据 docs/frontend-backend-api.md 第五章

// ============================================================================
// 基础类型（从旧前端 webui/src/types/index.ts 迁移）
// ============================================================================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  status?: 'generating' | 'executing' | 'done';
}

export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { data: string; mimeType: string } }
  >;
  isError?: boolean;
  /** 工具元数据（后端 terminal 等工具运行时返回，含 command/cwd/exitCode 等） */
  metadata?: {
    command?: string;
    cwd?: string;
    exitCode?: number;
    stdoutLength?: number;
    stderrLength?: number;
    truncated?: boolean;
    timedOut?: boolean;
    /** MCP 工具来源（mcp__server__tool） */
    server?: string;
    tool?: string;
    /** MCP structuredContent（结构化输出，JSON 直显） */
    structuredContent?: Record<string, unknown>;
    /** MCP resource 引用（uri/mimeType/text 完整数据） */
    resources?: Array<{ uri: string; mimeType?: string; text?: string }>;
  };
}

/** 右侧边栏标签页类型 */
export type SidebarTabType =
  | 'start'
  | 'summary'
  | 'terminal'
  | 'agenteam'
  | 'file'
  /** 文件浏览器（列目录 + 点击文件打开预览标签） */
  | 'files'
  /** 该任务的文件变更总览（按文件聚合 + 展开 diff） */
  | 'changes'
  /** 计算机使用面板（cua-driver 实时画面 / 窗口 / 动作时间线） */
  | 'computer';

/** 右侧边栏标签页 */
export interface SidebarTab {
  id: string;
  type: SidebarTabType;
  /** 标题 i18n key（如 'task.taskSummary' / 'terminal.title'）；
   *  type==='file' 时为文件完整名称（不参与 i18n）；type==='files'|'changes' 时为 i18n key */
  title: string;
  /** 仅 terminal 类型：绑定特定 toolCallId（可选，缺省显示当前 session 所有 terminal 调用） */
  toolCallId?: string;
  /** 仅 file 类型：文件绝对路径（预览数据源） */
  filePath?: string;
  /**
   * 仅 file 类型：压缩包内层条目来源（持久化用）。
   * 存在时以 archivePath + innerPath 重新提取内容；filePath 仅为展示占位，不用于取数据。
   */
  archiveEntry?: { archivePath: string; innerPath: string; name: string };
  createdAt: number;
}

export interface TaskMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** 用户消息附带的附件绝对路径（后端结构化字段；老会话缺失时回退解析正文附件块） */
  attachments?: string[];
  /**
   * 前端为这条用户消息生成并随请求下发的稳定 id（后端持久化、历史原样返回）。
   * 本地乐观消息的 id 与它一致，因此「历史回放的同一消息」会被 id 去重，不会渲染两份。
   */
  clientMessageId?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: Array<{ toolCallId: string; result: ToolResult }>;
  timestamp: string;
  /** 是否正在流式生成（整体） */
  streaming?: boolean;
  /** thinking 是否仍在输出（独立于 streaming，用于 thinking 区转圈） */
  thinkingStreaming?: boolean;
  /** 思考耗时（毫秒；完成后由后端持久化提供，刷新/重进会话仍可见） */
  thinkingMs?: number;
  /** 思考开始时刻（ISO；前端本地记录，仅流式期用于实时秒数） */
  thinkingStartedAt?: string;
  /** 思考结束时刻（ISO；前端本地记录，用于后端 thinkingMs 回补前的冻结兜底） */
  thinkingEndedAt?: string;
  /** 该消息内 todo 工具调用完成时的 todos 快照（任务流内卡片按此渲染，避免共享实时状态） */
  todoSnapshot?: TodoItem[];
  /** 是否为错误消息（用于错误卡片渲染） */
  isError?: boolean;
  /** 错误详情（原始 provider 错误文本；错误卡片正文 + 「诊断」弹窗的输入） */
  errorDetail?: string;
  /** 压缩卡片数据（上下文引擎压缩完成时插入消息流；驱动 CompactionCard 渲染） */
  compaction?: CompactionRecord;
  /** 轮数触顶提示卡数据（达到 agent.maxTurns 上限时插入；驱动 MaxTurnsNoticeCard 渲染 + 继续按钮） */
  maxTurnsNotice?: { maxTurns: number };
  /** 输出长度触顶提示卡数据（finishReason==='length' 时插入；驱动 OutputLimitNoticeCard 渲染 + 继续按钮） */
  outputLimitNotice?: { maxTokens?: number };
  /**
   * 服务端权威消息 id：
   * - 历史消息：`h<historyIndex>`（分页合并 / 虚拟列表 key 的稳定标识）
   * - 流式草稿：`<sessionId>#<turn>`（后端 offset 续传协议的 messageId）
   * 用于「刷新后恢复半截回复并接流」时把草稿消息与后续分片精确对齐。
   */
  serverMessageId?: string;
  /** 服务端历史下标（分页游标；仅来自历史接口的消息有） */
  historyIndex?: number;
  /** 上次进程中断遗留的未完成回复（来自 liveDraft.stale）：渲染为「已中断」的静态消息 */
  interrupted?: boolean;
}

/** 会话历史分页元数据（与后端 page 字段对齐） */
export interface HistoryPageMeta {
  total: number;
  oldestIndex: number;
  newestIndex: number;
  hasMoreBefore: boolean;
}

/** 前端维护的分页/加载状态（HistoryPageMeta + 加载态） */
export interface HistoryMeta extends HistoryPageMeta {
  /** 是否正在加载更早的一页（防重复触发） */
  loadingBefore: boolean;
  /** 是否已完成首屏加载（用于骨架屏判定） */
  loaded: boolean;
}

/** 流式草稿（后端 live-draft：刷新后恢复半截回复的数据源） */
export interface LiveDraftPayload {
  sessionId: string;
  runId?: string;
  messageId: string;
  turnIndex: number;
  content: string;
  thinking: string;
  toolCalls: Array<{ id: string; name: string; arguments: string; status?: ToolCall['status'] }>;
  contentLength: number;
  thinkingLength: number;
  /** 首个 thinking 分片时刻（ISO；刷新恢复后据此续算思考已用时） */
  thinkingStartedAt?: string;
  startedAt: string;
  updatedAt: string;
  /** 进程重启后的残留草稿（无活跃 run） */
  stale?: boolean;
}

// ============================================================================
// AI 诊断（WebSocket 流式：insight.diagnose / insight.diagnose.event）
// ============================================================================

export type InsightKind = 'cause' | 'harness' | 'resource';

/** 取证/分析步骤（链路中逐条展示「读取了/做了什么」） */
export interface InsightStep {
  id: string;
  /** 步骤类型（前端据此前缀做 i18n：insight.step.<kind>） */
  kind: string;
  /** 已读取/产出的数据摘要（数字为主，语言无关） */
  detail: string;
  status: 'running' | 'done' | 'error';
}

/** 诊断流式事件（与后端 InsightEvent 同构） */
export interface InsightEvent {
  requestId: string;
  kind: InsightKind;
  phase: 'step' | 'thinking' | 'text' | 'done' | 'error';
  step?: InsightStep;
  text?: string;
  message?: string;
}

// ============================================================================
// 资源管理器（GET /api/system-monitor/snapshot）
// ============================================================================

export type MossProcessGroup = 'server' | 'terminal' | 'child' | 'other';

export interface MossProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  cpuPercent: number;
  rssBytes: number;
  isMoss: boolean;
  group: MossProcessGroup;
}

export interface ResourceSnapshot {
  cpu: { usagePercent: number; cores: number; model: string; mossPercent: number };
  memory: { totalBytes: number; usedBytes: number; usedPercent: number; mossBytes: number };
  disk: {
    drive: string;
    totalBytes: number;
    freeBytes: number;
    usedPercent: number;
    categories: Array<{ key: string; bytes: number }>;
  };
  network: {
    interfaces: Array<{
      name: string;
      address?: string;
      rxBytes: number;
      txBytes: number;
      rxRate: number;
      txRate: number;
    }>;
  };
  moss: { pid: number; processes: MossProcessInfo[] };
  sampledAt: string;
}

/** GET /api/session/:id/state（刷新/重连恢复「不丢状态」的契约） */
export interface SessionState {
  sessionId: string;
  /** 后端权威运行态（含 automation / MCP 等外部注册的 run） */
  running: boolean;
  runId?: string;
  totalMessages: number;
  newestIndex: number;
  liveDraft: LiveDraftPayload | null;
  pendingAsks: Array<{
    toolCallId: string;
    sessionId: string;
    questions: AskQuestion[];
  }>;
  pendingConfirms: Array<{
    toolCallId: string;
    sessionId: string;
    question: string;
    ruleSuggestion?: string;
  }>;
  permissionMode?: 'ask' | 'auto' | 'skip';
  lastRunStats?: RunStats;
}

/** WS session.subscribed 回复载荷（与 SessionState 同构的超集） */
export interface SessionSubscribedPayload {
  running: boolean;
  runId?: string;
  totalMessages?: number;
  newestIndex?: number;
  liveDraft?: LiveDraftPayload | null;
}

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// ============================================================================
// 配置类型（与后端 src/core/types.ts 对齐）
// ============================================================================

export interface AppConfig {
  version: number;
  server: { host: string; port: number; autoPort: boolean; locale?: string };
  daemon: { enabled: boolean };
  /** 日志系统配置（级别 / 保留天数 / 单文件大小上限） */
  logs: LogsConfig;
  update: { autoCheck: boolean; channel: 'stable' | 'beta'; checkIntervalHours: number };
  agent: { defaultModel: string; maxTokens: number; maxTurns: number; workingDirectory: string };
  tools: Record<string, { enabled: boolean; requireConfirmation?: boolean; timeout?: number }>;
  mcpServers: Record<string, unknown>;
  /** 对外 MCP Server 暴露配置（/mcp 端点；可选，旧 config 无此段时视为关闭） */
  mcpServer?: {
    enabled: boolean;
    /** 内部工具白名单；仅在 exposeInternalTools 开启时生效（空数组 = 全部启用工具） */
    allowedTools: string[];
    /** POST 响应体模式，默认 'sse'（'json' 为兼容逃生舱，长任务有 60s 上限） */
    responseMode?: 'json' | 'sse';
    /** 是否额外暴露 MOSS 的内部工具（read/glob/terminal…），默认 false */
    exposeInternalTools?: boolean;
    /** moss_task_status 是否附带 LLM 轨迹摘要，默认 true */
    trackSummary?: boolean;
  };
  security: { authToken: string; bindLocalhostOnly: boolean };
  /** 统一权限决策配置（safety 模块；可选，旧 config 无此段时用默认值） */
  safety?: SafetyConfig;
  /** 上下文引擎配置（context 模块；可选，旧 config 无此段时用默认值） */
  context?: ContextEngineConfig;
}

/** 日志级别（与后端 LogLevel 对齐） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** config.logs 段（与后端 Zod schema 对齐） */
export interface LogsConfig {
  level: LogLevel;
  retentionDays: number;
  maxFileMb: number;
}

/** 日志文件元信息（GET /api/logs/files） */
export interface LogFileInfo {
  name: string;
  size: number;
  mtime: number;
}

/** 日志行查询结果（GET /api/logs） */
export interface LogQueryResult {
  lines: string[];
  total: number;
}

/** 权限规则表（与后端 config.safety.rules 对齐） */
export interface SafetyRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

/** config.safety 段（与后端 Zod schema 对齐） */
export interface SafetyConfig {
  defaultMode: PermissionMode;
  confirmTimeoutMinutes: number;
  blockDangerousCommands: boolean;
  cautionPolicy: 'ask' | 'deny';
  rules: SafetyRules;
  protectedPaths: string[];
}

export type ThinkingEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// ============================================================================
// 上下文引擎类型（与后端 src/modules/context/types.ts 对齐）
// ============================================================================

/** config.context.compaction 段 */
export interface CompactionConfig {
  enabled: boolean;
  compactRatio: number;
  tailKeepRatio: number;
  summaryMaxTokens: number;
  minFoldTokens: number;
  /** 'inherit' = 主模型；否则为模型 id */
  summaryModel: string;
}

/** config.context.toolPruning 段 */
export interface ToolPruningConfig {
  enabled: boolean;
  thresholdChars: number;
  keepHeadChars: number;
  keepTailChars: number;
}

/** config.context.healer 段 */
export interface HealerConfig {
  enabled: boolean;
  toolNameFuzzy: boolean;
  schemaFix: boolean;
}

/** config.context 段 */
export interface ContextEngineConfig {
  compaction: CompactionConfig;
  toolPruning: ToolPruningConfig;
  healer: HealerConfig;
  telemetry: { enabled: boolean };
  /** 文件索引模块（三引擎；可选，旧 config 无此段时视为全关） */
  fileIndex?: FileIndexConfig;
  /** 用户规则引擎（可选，旧 config 无此段时用默认值） */
  rules?: RulesEngineConfig;
  /** 生命周期钩子引擎（可选，旧 config 无此段时用默认值） */
  hooks?: HooksEngineConfig;
  /** 记忆引擎（可选，旧 config 无此段时用默认值） */
  memory?: MemoryEngineConfig;
  /** 单次 LLM 请求体字节上限（可选；旧 config 无此字段时后端按默认 8 MiB） */
  maxRequestBytes?: number;
}

/** config.context.rules 段（规则引擎） */
export interface RulesEngineConfig {
  enabled: boolean;
  maxAlwaysTokens: number;
  maxInjectPerSession: number;
}

/** config.context.hooks 段（钩子引擎） */
export interface HooksEngineConfig {
  enabled: boolean;
  defaultTimeout: number;
}

/** config.context.memory 段（记忆引擎） */
export interface MemoryEngineConfig {
  enabled: boolean;
  distillModel: string;
  distillMinMessages: number;
  recallTopK: number;
  recallTokenBudget: number;
  l1ImportanceThreshold: number;
  l1MaxEntries: number;
}

// ============================================================================
// 规则引擎类型（与后端 src/modules/rules/types.ts 对齐）
// ============================================================================

export type RuleScope = 'global' | 'project';

/** 单条规则（GET/POST /api/rules） */
export interface RuleItem {
  id: string;
  name: string;
  description: string;
  content: string;
  /** glob 模式列表；空 = always 规则 */
  paths: string[];
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
  scope: RuleScope;
}

/** 规则列表响应 */
export interface RulesListResult {
  project: RuleItem[];
  global: RuleItem[];
  dirs: { global: string; project: string };
}

/** 规则写入 body */
export interface RuleUpsertBody {
  name: string;
  description?: string;
  content: string;
  paths?: string[];
  scope?: RuleScope;
  enabled?: boolean;
  priority?: number;
}

// ============================================================================
// 钩子引擎类型（与后端 src/modules/hooks/types.ts 对齐）
// ============================================================================

export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SessionEnd';

export type HookType = 'terminal' | 'module';

/** 单个钩子定义 */
export interface HookItem {
  id: string;
  name: string;
  event: HookEvent;
  matcher: string | null;
  type: HookType;
  command: string;
  modulePath: string;
  timeout: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  scope: RuleScope;
}

/** 钩子列表响应 */
export interface HooksListResult {
  project: HookItem[];
  global: HookItem[];
  events: HookEvent[];
  scripts: { project: string[]; global: string[] };
}

/** 钩子写入 body */
export interface HookUpsertBody {
  name: string;
  event: HookEvent;
  matcher?: string | null;
  type: HookType;
  command?: string;
  modulePath?: string;
  timeout?: number;
  enabled?: boolean;
  scope?: RuleScope;
}

/** 钩子测试触发结果 */
export interface HookTestResult {
  ok: boolean;
  decision: 'allow' | 'deny' | null;
  reason?: string;
  durationMs: number;
  error?: string;
  stdout?: string;
}

/** 钩子执行历史条目 */
export interface HookHistoryEntry {
  hookId: string;
  hookName: string;
  event: HookEvent;
  at: string;
  durationMs: number;
  ok: boolean;
  decision: 'allow' | 'deny' | null;
  error?: string;
  stdout?: string;
}

// ============================================================================
// 记忆引擎类型（与后端 src/modules/memory/types.ts 对齐）
// ============================================================================

export type MemoryHall = 'decision' | 'event' | 'discovery' | 'preference' | 'suggestion';

/** 单条记忆 */
export interface MemoryItem {
  id: string;
  wing: string;
  room: string;
  hall: MemoryHall;
  verbatim: string;
  insight: string;
  source: { sessionId?: string; taskId?: string; at: string };
  tags: string[];
  importance: number;
  pinned: boolean;
  accessCount: number;
  lastAccessedAt?: string;
  createdAt: string;
  updatedAt: string;
  scope: RuleScope;
}

/** 宫殿树 */
export interface MemoryPalaceTree {
  wings: Array<{
    wing: string;
    scope: RuleScope;
    rooms: Array<{
      room: string;
      count: number;
      halls: Array<{ hall: MemoryHall; count: number }>;
    }>;
    total: number;
  }>;
}

/** 记忆写入 body */
export interface MemoryUpsertBody {
  wing?: string;
  room: string;
  hall: MemoryHall;
  verbatim?: string;
  insight: string;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
}

/** 手动蒸馏结果 */
export interface MemoryDistillResult {
  created: number;
  merged: number;
  skipped: boolean;
  reason?: string;
}

/** 文件索引配置（config.context.fileIndex） */
export interface FileIndexConfig {
  indexing: { enabled: boolean };
  graph: { enabled: boolean };
  sag: {
    enabled: boolean;
    llmModel: string;
    llmMaxChunks: number;
  };
  ignore: string[];
}

/** 文件索引引擎状态（GET /api/context/file-index/status） */
export interface FileIndexStatus {
  projectRoot: string;
  indexing: FileIndexEngineStatusBase & { fileCount: number; dirCount: number };
  graph: FileIndexEngineStatusBase & { fileCount: number; symbolCount: number; edgeCount: number };
  sag: FileIndexEngineStatusBase & {
    chunkCount: number;
    eventCount: number;
    entityCount: number;
    llmExtracted: number;
    llmBudget: number;
  };
}

interface FileIndexEngineStatusBase {
  enabled: boolean;
  state: 'disabled' | 'scanning' | 'ready' | 'error';
  progress: { phase: string; percent: number } | null;
  storeBytes: number;
  error: string | null;
}

// ============================================================================
// 远程控制（/api/remote/*）
// ============================================================================

/** cloudflared 隧道阶段 */
export type RemoteTunnelPhase = 'idle' | 'downloading' | 'starting' | 'registering' | 'ready' | 'error';

/** 隧道运行状态 */
export interface RemoteTunnelState {
  phase: RemoteTunnelPhase;
  detail: string;
  startedAt: number | null;
}

/** GET /api/remote/status 响应（不含密码明文） */
export interface RemoteStatus {
  enabled: boolean;
  port: number;
  lanEnabled: boolean;
  lanPasswordEnabled: boolean;
  lanIp: string | null;
  lanUrl: string | null;
  lanCandidates: string[];
  lanIpOverride: string;
  tunnel: RemoteTunnelState;
  tunnelUrl: string | null;
  publicPasswordCustomized: boolean;
}

/** GET /api/remote/passwords 响应（密码明文视图） */
export interface RemotePasswords {
  lan: string | null;
  public: string | null;
  lanPasswordEnabled: boolean;
  publicCustomized: boolean;
}

/** POST /api/remote/enable|disable 响应 */
export interface RemoteToggleResult {
  rebound: boolean;
  enabled: boolean;
  hostname?: string;
}

/** 压缩历史记录（session.compactions 元素 / GET /api/context/:id/compactions） */
export interface CompactionRecord {
  id: string;
  at: string;
  trigger: 'auto' | 'manual';
  beforeTokens: number;
  afterTokens: number;
  compactedCount: number;
  /** 物理折叠的消息条数（新实现 = compactedCount；旧记录仅标记未折叠时缺省） */
  foldedMessageCount?: number;
  summary: string;
  boundaryTimestamp?: string;
  summaryModel: string;
  durationMs: number;
}

/** token 构成分解 */
export interface ContextBreakdown {
  system: number;
  env: number;
  summary: number;
  history: number;
  /** paths 规则注入消息（active-rules 锚定）；旧后端无此字段时为 0 */
  rules?: number;
  /** 记忆召回消息（memory-l1 锚定 + memory-recall 临时）；旧后端无此字段时为 0 */
  memory?: number;
  total: number;
}

/** 缓存命中样本 */
export interface CacheHitSample {
  at: string;
  promptTokens: number;
  cachedTokens: number;
  hitRate: number;
}

/** 系统上下文分段（「系统」标签页折叠栏数据） */
export interface SystemSection {
  id: string;
  title: string;
  tokens: number;
  content: string;
  defaultOpen?: boolean;
}

/** GET /api/context/:sessionId/stats 响应 */
export interface ContextStats {
  sessionId: string;
  /** 当前会话模型（模型与配置摘要行数据源） */
  model: { id: string; name: string };
  breakdown: ContextBreakdown;
  windowTokens: number;
  usedPercent: number;
  /** 最近一次请求的真实 usage（LLM 上报；无样本为 null；实时指标栏数据源） */
  lastUsage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
  } | null;
  compaction: {
    enabled: boolean;
    compactRatio: number;
    compactedMessages: number;
    activeSummaryTokens: number;
    lastCompaction?: CompactionRecord;
  };
  cacheHits: CacheHitSample[];
  avgHitRate: number | null;
  systemSections: SystemSection[];
}

/** GET /api/context/:sessionId/compact-preview 响应（确认框数据） */
export interface CompactPreview {
  sessionId: string;
  compactableCount: number;
  compactableTokens: number;
  tailKeepCount: number;
  estimatedAfterTokens: number;
}

/** POST /api/context/:sessionId/compact 响应 */
export interface ManualCompactResult {
  ok: boolean;
  compaction?: CompactionRecord;
  error?: string;
}

/** 模型 thinking 配置：effort 为预设档或自定义字符串 */
export interface ModelThinking {
  enabled: boolean;
  /** 思考强度：预设档（low/medium/high 等）或自定义值 */
  effort?: string;
  /** 自定义等级显示名（预设档无此字段） */
  label?: string;
  budgetTokens?: number;
}

export interface ApiConfig {
  version: number;
  providers: ProviderItem[];
}

// ============================================================================
// MCP 类型（迁移）
// ============================================================================

export interface McpServer {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  /** 服务器定义（stdio=command+args+env；http/sse=url+headers） */
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 启停（config.mcpServers[name].enabled，缺省 true） */
  enabled?: boolean;
  /** 最近一次错误信息（status=error 时） */
  lastError?: string;
}

export interface McpTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** MCP 工具注解（readOnlyHint/destructiveHint 等，驱动确认与展示） */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

// ============================================================================
// 任务 / Todo / 上下文（见文档 3.2.1 / 3.2.9 / 3.2.10）
// ============================================================================

export interface TaskItem {
  id: string;
  title: string;
  groupId: string;
  createdAt: string;
  updatedAt: string;
  active?: boolean;
  /** 关联的 sessionId（task.id 即 sessionId，简化模型） */
  sessionId?: string;
  /** 分组内排序权重（小→前）；缺失视为最后 */
  order?: number;
  /** 后端权威运行态（GET /api/tasks 附带）：刷新后首屏即可显示「运行中」 */
  running?: boolean;
}

export interface TaskGroup {
  id: string;
  name: string;
  expanded?: boolean;
  taskCount?: number;
  /** 分组来源：folder = 按工作目录自动创建（空时后端自动销毁）；manual = 手动新建（允许空状态） */
  source?: 'folder' | 'manual';
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'low' | 'medium' | 'high';
  sessionId?: string;
}

export interface ContextFile {
  path: string;
  tokens?: number;
  reason?: 'read' | 'edit' | 'write' | 'grep' | 'glob' | 'delete' | 'move' | 'copy';
  /** 后端存在性校验标记：文件已被删除/移走（HTTP 恢复与 WS 推送时计算） */
  missing?: boolean;
}

/** 目录条目（GET /api/filesystem/list；文件浏览器列表项） */
export interface DirectoryEntry {
  name: string;
  /** 条目绝对路径 */
  path: string;
  kind: 'directory' | 'file';
  /** 小写扩展名（无扩展名为空串） */
  ext: string;
  /** 文件字节数（目录恒为 0） */
  size: number;
  /** 文件修改时间（ms；目录恒为 0） */
  mtimeMs: number;
}

/** 目录列表响应（GET /api/filesystem/list） */
export interface DirectoryListing {
  /** 实际解析后的绝对目录路径 */
  path: string;
  /** 导航根目录绝对路径（不可上溯越过它；未传 root 时为该次解析结果） */
  root: string;
  /** 上级目录绝对路径（到达 root 或文件系统根为 null） */
  parent: string | null;
  entries: DirectoryEntry[];
  /** 条目数超过后端上限被截断 */
  truncated?: boolean;
  /** 平台路径分隔符（Windows '\\'，POSIX '/'）：前端据此生成地址栏/相对路径展示 */
  sep: '\\' | '/';
}

/** 驱动器/卷条目类型（前端据此选择文案） */
export type DriveKind = 'drive' | 'root' | 'volume' | 'storage' | 'home';

/** 驱动器/卷信息（GET /api/filesystem/drives；「本机」视图） */
export interface DriveInfo {
  /** 展示 token：Windows 盘符 'C'；其余平台为卷名/挂载点/主目录路径 */
  letter: string;
  /** 条目类型：drive=Windows 盘符；root=文件系统根；volume=挂载卷；storage=Android 存储；home=主目录 */
  kind: DriveKind;
  /** 驱动器/卷根绝对路径（'C:\' / '/' / '/Volumes/X' / '/storage/emulated/0'） */
  path: string;
  /** 总字节数（0 = 未知，隐藏用量条） */
  totalBytes: number;
  /** 可用字节数（0 = 未知） */
  freeBytes: number;
}

/** 驱动器列表响应（GET /api/filesystem/drives） */
export interface DriveListing {
  drives: DriveInfo[];
}

/** 文件历史条目（GET /api/file-history/:sessionId；与后端 file-history/types.ts 对齐） */
export interface FileHistoryEntry {
  id: string;
  sessionId: string;
  absPath: string;
  toolCallId: string;
  toolName: 'write' | 'edit' | 'delete' | 'rollback' | 'move' | 'copy' | 'terminal' | 'shell';
  timestamp: string;
  operation: 'create' | 'overwrite' | 'edit' | 'delete' | 'move' | 'terminal-change' | 'shell-change';
  hashBefore: string | null;
  hashAfter: string | null;
  backupPath: string | null;
  bytesBefore: number;
  bytesAfter: number;
  /** unified diff 文本（仅 overwrite/edit 存在） */
  diff?: string;
  /** 是否为目录操作 */
  isDirectory?: boolean;
  /** move 操作的目标路径 */
  destPath?: string;
  /** 消息撤回回滚标记（存在即已回滚，不计入「生效中」变更） */
  rolledBackAt?: string;
  /** 仅 R 条目（toolName='rollback'）：指向被回滚的原始条目 id */
  rollbackOf?: string;
}

// ============================================================================
// 模型管理（见文档 3.2.2）
// ============================================================================

/** 服务商思考强度等级（等级库条目；预设档 id 固定 off/low/medium/high） */
export interface ThinkingLevelItem {
  id: string;
  /** 显示名，如 "极致" / "关闭" */
  label: string;
  /** API 参数值：'off'/'low'/'medium'/'high'/自定义（如 'xhigh'） */
  effort: string;
}

/** 服务商附加服务（当前仅文件存储） */
export interface ProviderServiceItem {
  id: string;
  name: string;
  type: 'file-storage';
  endpoint: string;
  apiKey: string;
  /** 最大限额数值 */
  maxQuota?: number;
  /** 限额单位 */
  quotaUnit?: 'MB' | 'GB' | 'TB';
}

/** 服务商配置（与后端 ProviderConfig 对齐）：持有 API 格式/地址/Key 及自定义查询地址 */
export interface ProviderItem {
  /** 内部唯一 id（如 "provider_1734..."） */
  id: string;
  /** 显示名，如 "OpenAI" */
  name: string;
  /** 服务商类型：model（缺省）= 模型服务商；search = 搜索服务商；voice = 语音服务商 */
  kind?: 'model' | 'search' | 'voice';
  format: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini' | 'search' | 'voice';
  /** 搜索引擎类型（kind='search' 时存在）：zhipu / bocha / tavily */
  searchEngine?: 'zhipu' | 'bocha' | 'tavily';
  /** 语音引擎类型（kind='voice' 时存在）：openai-transcriptions（OpenAI 兼容整段转写） */
  voiceEngine?: 'openai-transcriptions';
  /** 语音模型名（kind='voice' 时使用，如 whisper-1） */
  voiceModel?: string;
  endpoint: string;
  apiKey: string;
  /** 自定义余额查询地址（OpenAI 兼容 subscription 接口完整 URL；空 = 不提供余额查询） */
  balanceUrl?: string;
  /** 自定义模型列表获取地址（空 = 按 API 格式自动推断） */
  modelsUrl?: string;
  /** 品牌图标 key（@lobehub/icons 的 provider key；空 = 默认 Server 图标） */
  icon?: string;
  /** 附加服务（文件存储等） */
  services?: ProviderServiceItem[];
  models: ProviderModelItem[];
}

/** 本地语音引擎类别（均由 sherpa-onnx 承载不同模型架构） */
export type VoiceLocalEngine = 'zipformer' | 'sensevoice' | 'whisper';

/** 语音能力总览（GET /api/voice/status） */
export interface VoiceStatus {
  /** 后端 voice 模块是否存在 */
  available?: boolean;
  /** 总开关（默认关闭；关闭时输入框麦克风按钮隐藏） */
  enabled: boolean;
  /** 运行时是否可用（sherpa-onnx 原生模块已加载） */
  runtimeAvailable: boolean;
  runtimeVersion?: string;
  /** 运行平台标识：`${process.platform}-${process.arch}`（安卓/Termux 记为 android-<arch>） */
  platform: string;
  /** 该平台是否存在本地推理预编译原生库 */
  platformSupported: boolean;
  /** 运行时加载失败原因（runtimeAvailable=false 时） */
  runtimeError?: string;
  /** 当前默认本地模型 id */
  defaultModel: string;
  /** 已安装模型 id 列表 */
  installed: string[];
  /** 当前语音服务商 id（空串 = 内置本地引擎） */
  providerId: string;
}

/** 语音模型（内置目录项 + 本地安装状态；GET /api/voice/models） */
export interface VoiceModelStatus {
  id: string;
  engine: VoiceLocalEngine;
  mode: 'streaming' | 'offline';
  name: string;
  description: string;
  sizeBytes: number;
  languages: string[];
  recommended: boolean;
  state: 'not-installed' | 'downloading' | 'installed' | 'error';
  progress?: number;
  installedBytes?: number;
  error?: string;
}

/** 服务商下的模型：名称 + 模型 id + 模型级高级配置 */
export interface ProviderModelItem {
  /** 内部唯一 id（如 "model_1734..."） */
  id: string;
  /** 显示名，如 "GPT-4o" */
  name: string;
  /** 发送给 API 的模型名，如 "gpt-4o" */
  model: string;
  /** 上下文窗口档位（旧格式，如 '200k'）；读取时 inputTokens 优先 */
  contextWindow?: string;
  /** 输入窗口 token 数（context 引擎压缩预算） */
  inputTokens?: number;
  /** 输出窗口 token 数（请求 max_tokens 默认值） */
  outputTokens?: number;
  /** 模型温度 0-2 */
  temperature?: number;
  /** Top P 0-1 */
  topP?: number;
  /** Top K 0-100；0 表示不发送 */
  topK?: number;
  thinking: ModelThinking;
  /** 思考强度等级库（模型级，有序：位置越靠后档位越高；undefined = 默认库 [off,low,medium,high]） */
  thinkingLevels?: ThinkingLevelItem[];
}

/** 远程模型列表项（POST /api/providers/:id/models/fetch 归一化结果） */
export interface RemoteModelItem {
  id: string;
  name?: string;
}

/** 余额查询结果（POST /api/providers/:id/balance） */
export interface ProviderBalanceResult {
  success: boolean;
  totalUsd?: number;
  usedUsd?: number;
  balanceUsd?: number;
  error?: string;
}

// ============================================================================
// Agent 管理（见文档 3.2.3）
// ============================================================================

export interface AgentItem {
  id: string;
  name: string;
  description?: string;
  /** 图标标识（前端映射 LucideIcon） */
  icon?: string;
  builtIn: boolean;
  default?: boolean;
}

export interface AgentDetail extends AgentItem {
  systemPrompt?: string;
  model?: string;
  /** 启用的工具白名单 */
  tools?: string[];
  maxTurns?: number;
  maxTokens?: number;
}

// ============================================================================
// agenteam 编排（GET/POST /api/agenteams）
// ============================================================================

/** 团队任务状态 */
export type TeamTaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 质量门禁任务类型 */
export type TeamTaskKind =
  | 'requirements'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'
  | 'work';

export interface ReviewFinding {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'blocker';
  file?: string;
  line?: number;
  problem: string;
  requiredFix: string;
  resolved?: boolean;
}

export interface AcceptanceResult {
  criterion: string;
  status: 'passed' | 'failed';
  evidence?: string;
}

/** 团队任务（DAG 节点） */
export interface TeamTask {
  id: string;
  profileSeedId?: string;
  subject: string;
  description?: string;
  status: TeamTaskStatus;
  assignee?: string;
  dependencies: string[];
  output?: string;
  attempt?: number;
  kind?: TeamTaskKind;
  round?: number;
  verdict?: 'pass' | 'needs_revision' | 'reject';
  findings?: ReviewFinding[];
  objective?: string;
  acceptance?: string[];
  acceptanceResults?: AcceptanceResult[];
  createdAt: number;
  updatedAt: number;
}

/** 团队成员 */
export interface TeamMember {
  id: string;
  name: string;
  role?: string;
  agentId?: string;
  inlinePrompt?: string;
  /** 专属持久会话 id（=侧边栏任务 id；点击跳转任务页查看完整对话） */
  sessionId: string;
  taskId?: string;
  executionPrompt?: string;
  joinedAt: number;
  status: 'idle' | 'working' | 'removed';
}

/** 团队消息 */
export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  ts: number;
}

/** 团队阶段 */
export type TeamPhase = 'staged' | 'running' | 'completed' | 'failed' | 'halted';

/** 团队详情 */
export interface Agenteam {
  id: string;
  name: string;
  description?: string;
  profile?: {
    name: string;
    description?: string;
    protocol?: string;
    taskPlanning?: 'captain' | 'seed';
  };
  /** 队长（= 创建团队的主会话）session id */
  captainSessionId: string;
  cwd: string;
  permissionMode?: string;
  createdAt: number;
  members: TeamMember[];
  tasks: TeamTask[];
  taskSeq: number;
  phase: TeamPhase;
  planReviewState?: 'awaiting_review' | 'awaiting_feedback';
  approvedAt?: number;
  halted?: boolean;
  haltedAt?: number;
  escalated?: boolean;
  summary?: string;
}

/** 团队列表摘要 */
export interface AgenteamSummary {
  id: string;
  name: string;
  description?: string;
  phase: TeamPhase;
  planReviewState?: 'awaiting_review' | 'awaiting_feedback';
  memberCount: number;
  taskTotal: number;
  taskCompleted: number;
  createdAt: number;
  updatedAt: number;
}

/** 团队模板 */
export interface AgenteamProfile {
  name: string;
  description?: string;
  protocol?: string;
  executionPrompt?: string;
  members: Array<{ name: string; role?: string; agentId?: string; inlinePrompt?: string; executionPrompt?: string }>;
  tasks: Array<{ seedId: string; subject: string; description?: string; kind?: TeamTaskKind; dependencies?: string[]; assignee?: string }>;
  taskPlanning: 'captain' | 'seed';
  reviewPolicy?: {
    requirementsMinRounds?: number;
    requirementsMaxRounds?: number;
    codeMaxRounds?: number;
    maxRepairAttempts?: number;
  };
  builtIn?: boolean;
}

/** 创建团队请求体 */
export interface CreateAgenteamInput {
  name: string;
  description?: string;
  cwd: string;
  permissionMode?: 'ask' | 'auto' | 'skip';
  /** 队长会话（主 agent 即队长）：必填，服务端校验会话存在 */
  captainSessionId: string;
  members: Array<{ name: string; role?: string; agentId?: string; inlinePrompt?: string }>;
  tasks: Array<{
    subject: string;
    description?: string;
    kind?: TeamTaskKind;
    dependencies?: string[];
    assignee?: string;
    /** kind=review 必填 */
    reviewedTaskId?: string;
    /** kind=repair 必填 */
    sourceTaskId?: string;
  }>;
  approval?: boolean;
}

/** 临时 subagent 运行结果 */
export interface SubagentRunOutput {
  sessionId: string;
  taskId: string;
  finishReason: string;
  result: string;
}

// ============================================================================
// 工具（GET /api/tools，PATCH /api/tools/:name）
// ============================================================================

export interface ToolItem {
  name: string;
  description: string;
  icon?: string;
  /** 来源：内置或用户自定义 */
  source: 'builtin' | 'custom';
  /** 是否启用（从 config.tools[name].enabled 读取） */
  enabled: boolean;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    requireConfirmation?: boolean;
  };
  /** 工具来源目录绝对路径（热重载定位用） */
  sourceDir?: string;
  /** 可编辑参数字段定义（来自 tool.json config 段，排除 enabled/requireConfirmation） */
  configFields?: Array<{
    key: string;
    type: 'boolean' | 'integer' | 'string';
    default: unknown;
    min?: number;
    max?: number;
  }>;
  /** 当前生效配置值（defaults 与 config.json 覆盖值合并） */
  configValues?: Record<string, unknown>;
}

// ============================================================================
// Skills 查询（见文档 3.2.5）
// ============================================================================

export interface SkillItem {
  name: string;
  description: string;
  source: 'user';
  /** skill 正文（GET /api/skills 列表实际返回；一次性注入渲染用） */
  prompt?: string;
  /** 启停（config.skills[name].enabled，缺省 true） */
  enabled?: boolean;
  /** Lucide 图标名（kebab-case） */
  icon?: string;
  /** 切入模式欢迎语 */
  greet?: string;
  /** 激活时建议允许的工具列表 */
  allowedTools?: string[];
  /** 目录式 skill 的附属文件清单（references/scripts/assets 相对路径） */
  files?: string[];
  /** 目录式 skill 根目录 */
  dir?: string;
}

export interface SkillDetail extends SkillItem {
  prompt: string;
  sourceFile?: string;
  /** 自定义 svg 图标内容（icon 以 .svg 结尾时后端返回） */
  iconSvg?: string;
}

/** 自定义斜杠命令（~/.moss/commands/<name>.md；一次性注入的提示词模板） */
export interface CommandItem {
  /** 命令名（= 文件名去扩展名） */
  name: string;
  description: string;
  /** prompt 模板（可含 $ARGUMENTS 占位符） */
  prompt: string;
  /** 启停（config.commands[name].enabled，缺省 true） */
  enabled?: boolean;
  /** 参数提示（菜单展示，如 "[issue-number]"） */
  argumentHint?: string;
  /** Lucide 图标名（kebab-case） */
  icon?: string;
}

/** 创建/更新自定义斜杠命令的请求体（POST /api/commands、PUT /api/commands/:name） */
export interface CommandUpsertBody {
  name?: string;
  description?: string;
  prompt: string;
  argumentHint?: string;
  icon?: string;
}

// ============================================================================
// 自动化任务（见文档 3.2.7）
// ============================================================================

export interface AutomationItem {
  id: string;
  title: string;
  description?: string;
  /** lucide 图标名（kebab-case，如 'calendar-clock'；缺省回退首字母） */
  icon?: string;
  /** 调度类型：cron=周期循环；once=指定时间执行一次 */
  scheduleType: 'cron' | 'once';
  /** scheduleType='cron' 时的 5 字段 cron 表达式 */
  cron?: string;
  /** scheduleType='once' 时的执行时间（ISO 字符串） */
  runAt?: string;
  /** once 任务被调度器执行后标记 true（保留在列表，改 runAt 后重新启用） */
  completed?: boolean;
  /** 执行工作目录（绝对路径） */
  cwd: string;
  /** 触发时发送给 agent 的消息 */
  prompt: string;
  agentId?: string;
  enabled: boolean;
  paused: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

export interface AutomationDetail extends AutomationItem {
  history?: AutomationRun[];
}

export interface AutomationRun {
  id: string;
  automationId: string;
  /** 本次运行创建的真实任务 id（点击跳转 /task/:taskId） */
  taskId?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'failed' | 'timeout';
  finishReason?: string;
  finalText?: string;
  error?: string;
}

// ============================================================================
// WebSocket 消息类型（迁移 + 新增）
// ============================================================================

export interface WSMessage {
  type: string;
  sessionId?: string;
  taskId?: string;
  payload?: unknown;
}

/** 单次运行（run）级统计（与后端 contracts RunStats 对齐；每次发送消息后重置） */
export interface RunStats {
  runId?: string;
  turns: number;
  /** 本次 run 的轮数（每次 run 重置；X/N 进度显示用） */
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

export type AgentEvent =
  | { type: 'assistant-text'; sessionId: string; text: string; runId?: string }
  | { type: 'assistant-thinking'; sessionId: string; text: string; runId?: string }
  | { type: 'tool-call-start'; sessionId: string; toolName: string; toolCallId: string; args: unknown; runId?: string }
  | { type: 'tool-call-delta'; sessionId: string; toolCallId: string; argumentsDelta: string; runId?: string }
  | { type: 'tool-call-executing'; sessionId: string; toolName: string; toolCallId: string; runId?: string }
  | { type: 'tool-call-end'; sessionId: string; toolName: string; toolCallId: string; result: ToolResult; runId?: string }
  | { type: 'ask'; sessionId: string; toolCallId: string; questions: AskQuestion[]; runId?: string }
  | { type: 'ask-timeout'; sessionId: string; toolCallId: string; runId?: string }
  | { type: 'confirm-required'; sessionId: string; toolCallId: string; toolName: string; question: string; details?: unknown; runId?: string }
  | { type: 'stats-updated'; sessionId: string; stats: RunStats; runId?: string }
  | { type: 'error'; sessionId: string; message: string; runId?: string }
  | { type: 'done'; sessionId: string; finishReason: string; runId?: string };

/** ask 回答类型 */
export type AskAnswerType = 'text' | 'single' | 'multi' | 'boolean' | 'form';

/** ask 工具候选项 */
export interface AskOption {
  value: string;
  label: string;
  /** 选项补充说明（可选，前端渲染为次行小字） */
  description?: string;
}

/** ask 工具单个问题（归一化后的最小单元） */
export interface AskQuestion {
  id: string;
  question: string;
  answerType?: AskAnswerType;
  options?: AskOption[];
  defaultAnswer?: string;
  formSchema?: Record<string, unknown>;
  /** agent 侧题面附件绝对路径 */
  attachments?: string[];
}

/** ask 工具用户回答（结构化） */
export interface AskAnswer {
  selectedValues?: string[];
  selectedLabels?: string[];
  editedLabels?: Record<string, string>;
  otherText?: string;
  text?: string;
  /** form 模式（elicitation）：字段名 → 值 */
  form?: Record<string, string | number | boolean>;
  /** 用户侧附件绝对路径（粘贴/选择的文件） */
  attachments?: string[];
}

/** ask 工具结局 */
export interface AskOutcome {
  action: 'accept' | 'cancel';
  /** 逐题回答（answers[i] 与 questions[i] 按下标对齐） */
  answers?: AskAnswer[];
}

/** 工具发起的、待用户回复的提问 */
export interface PendingAsk {
  toolCallId: string;
  sessionId: string;
  /** 该次 ask 调用携带的问题列表（≥1 题） */
  questions: AskQuestion[];
  /** 收到时间，用于排序 */
  createdAt: number;
}

/** 工具发起的、待用户确认的请求（requireConfirmation 工具执行前触发） */
export interface PendingConfirm {
  toolCallId: string;
  sessionId: string;
  /** 发起确认的工具名（如 terminal/write/delete/undo） */
  toolName: string;
  /** 确认提示文案 */
  question: string;
  /** 工具调用参数（供前端展示具体将执行什么） */
  details?: unknown;
  /** 「始终允许」规则建议（safety 模块生成，如 "terminal(git commit *)"；卡片展示+remember 回复） */
  ruleSuggestion?: string;
  /** 收到时间，用于排序 */
  createdAt: number;
}

// ============================================================================
// 文件系统（前端文件夹选择器 + 附件）
// ============================================================================

/** 常用位置类型（前端据此选图标 + i18n 文案） */
export type SuggestPathKind =
  | 'home'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'pictures'
  | 'music'
  | 'videos'
  | 'cwd';

/** suggest-paths 单项 */
export interface SuggestPath {
  path: string;
  label: string;
  kind: SuggestPathKind;
}

// ============================================================================
// 持久终端（与后端 src/modules/terminal/types.ts 对齐）
// ============================================================================

/** 持久终端信息 */
export interface TerminalInfo {
  id: string;
  sessionId: string;
  title: string;
  /** 解释器展示名（PowerShell / CMD / Git Bash …） */
  interpreterLabel: string;
  /** 解释器类型 */
  interpreterKind: InterpreterKind;
  /** 创建者：'ai' = agent 经 terminal 工具创建（标题带 [AI] 前缀）；'user' = 人类创建 */
  creator: 'user' | 'ai';
  cwd: string;
  running: boolean;
  exitCode: number | null;
  createdAt: number;
  /** 是否原生 PTY（false = 管道降级） */
  pty: boolean;
  /** Windows ConPTY 兼容信息（xterm windowsPty；随 terminal.created 单帧下发） */
  ptyBackend?: { backend: 'conpty'; buildNumber: number };
  /** 仅剩历史（后端进程已重启，终端本体不存在）：只读回放，不可输入 */
  offline?: boolean;
}

/** 终端解释器类型（terminal 工具/WS create 使用） */
export type InterpreterKind = 'powershell' | 'cmd' | 'bash';

/** 本机可用解释器类型（GET /api/terminal/interpreters；「新建终端」菜单数据源） */
export interface InterpreterOption {
  kind: InterpreterKind;
  label: string;
  /** 本机实测是否可用 */
  available: boolean;
  /** 是否为系统默认解释器 */
  isDefault: boolean;
}

/** # 文件提及菜单搜索结果（GET /api/filesystem/search-files） */
export interface SearchedFile {
  /** 文件绝对路径 */
  path: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 所在目录绝对路径 */
  dir: string;
  /** 小写扩展名（无扩展名为空串） */
  ext: string;
}

/** 附件条目（POST /api/filesystem/resolve-paths 与 save-attachment 的返回元素） */
export interface PickedFile {
  /** 文件绝对路径（附件以路径引用，文件留在原位） */
  path: string;
  name: string;
  size: number;
}

// ============================================================================
// 执行权限模式
// ============================================================================

/** 任务执行权限模式（对齐 PermissionModeSelector 现有 UI：3 种；与后端 safety/types 对齐） */
export type PermissionMode = 'ask' | 'auto' | 'skip';

// ============================================================================
// Computer（cua-driver）面板
// ============================================================================

export type ComputerConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'installing';

export interface ComputerScreenInfo {
  width: number;
  height: number;
  scale: number | null;
}

export interface ComputerStatus {
  installed: boolean;
  driverPath: string | null;
  version: string | null;
  connection: ComputerConnectionState;
  toolCount: number;
  screen: ComputerScreenInfo | null;
  paused: boolean;
  config: {
    maxImageDimension: number;
    allowForeground: boolean;
  };
  error: string | null;
  activities: ComputerActivity[];
}

export interface ComputerWindowInfo {
  window_id: number;
  pid: number;
  app_name?: string;
  title?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  is_on_screen?: boolean;
  z_index?: number | null;
}

export interface ComputerActivity {
  id: string;
  ts: number;
  sessionId?: string;
  action: string;
  tool: string;
  target: string;
  summary: string;
  effect?: string;
  verified?: boolean;
  screenshotPath?: string;
  isError?: boolean;
  durationMs?: number;
}
