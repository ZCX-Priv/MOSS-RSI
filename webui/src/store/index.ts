// UI/src/store/index.ts
// 全局状态：Zustand。迁移自 webui/src/store/index.ts 并扩展新切片。
// 切片：会话/消息/输入/生成态/模型/Agent/任务/任务分组/Todo/Context/
//       自动化/插件/Skills/MCP/配置/WS/面板。

import { create } from 'zustand';
import { idbSet } from '../utils/idb';
import { normalizeShortcut } from '../utils/shortcut';
import type {
  AppConfig,
  ApiConfig,
  TaskMessage,
  PendingAsk,
  PendingConfirm,
  Session,
  McpServer,
  McpTool,
  TaskItem,
  TaskGroup,
  TodoItem,
  ContextFile,
  ProviderItem,
  AgentItem,
  AutomationItem,
  AutomationRun,
  SkillItem,
  ToolItem,
  CommandItem,
  SidebarTab,
  SidebarTabType,
  PermissionMode,
  RunStats,
  ContextStats,
  HistoryMeta,
  TerminalInfo,
} from '../types/api';
import { DEFAULT_RENDER_SETTINGS, isValidRenderSettings, type RenderSettings } from '../render/core/types';
import { fileNameOf } from '../render/file/detector';
import { DEFAULT_ANIMATION_SETTINGS, isValidAnimationSettings, type AnimationSettings } from '../types/animation';
import { diag } from '../lib/diag';

// ============================================================================
// State
// ============================================================================

/** 专家团/Subagent 成员事件计数条目（agenteam.member.event 广播聚合；key=taskId） */
export interface AgenteamEventEntry {
  /** 团队 id（临时 subagent 为 null） */
  teamId: string | null;
  /** 成员名（subagent 场景 = 模板 agentId） */
  memberName: string;
  /** 累计事件条数 */
  count: number;
  /** 最近一条事件到达时间（ms） */
  lastAt: number;
}

/** 排队消息（每会话至多一条；多次发送会被合并到同一条，用换行 + 分隔符分隔） */
export interface QueuedMessage {
  id: string;
  content: string;
  timestamp: string;
  /** 附件绝对路径（出队发送时透传） */
  attachments?: string[];
}

/** 多条排队消息合并时的分隔符（换行 + 分隔线，保证可读且便于区分来源） */
const QUEUE_MERGE_SEPARATOR = '\n\n---\n\n';

/** 合并两批附件路径（去重、保序；空则返回空对象以便展开） */
function mergeAttachments(a?: string[], b?: string[]): { attachments?: string[] } {
  const uniq = Array.from(new Set([...(a ?? []), ...(b ?? [])]));
  return uniq.length > 0 ? { attachments: uniq } : {};
}

/** 清理不在 dirs 中的「最近使用」别名；无需变更时返回原对象引用（避免多余写盘） */
function pruneAliases(aliases: Record<string, string>, dirs: string[]): Record<string, string> {
  const keep = new Set(dirs);
  const out: Record<string, string> = {};
  let changed = false;
  for (const [k, v] of Object.entries(aliases)) {
    if (keep.has(k)) out[k] = v;
    else changed = true;
  }
  return changed ? out : aliases;
}

/** 消息时间戳（ms）；非法/缺失视为 0（排在最早，稳定排序下保持相对位置） */
function tsOf(m: TaskMessage): number {
  const t = Date.parse(m.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 归一为「时间升序」：把消息顺序从「到达顺序」改为「消息时间顺序」。
 *
 * 背景（倒序根因）：历史合并过去一律按到达顺序拼接（catchup `[...base, ...rest]`、
 * tail `[...resolved, ...localOnly]`、prepend `[...rest, ...base]`）。当「较新的消息先到、
 * 较早的历史后到」时（如刷新时半截草稿先 addMessage、随后 catchUpTail 才拉回更早历史），
 * 数组会变成「新在前、旧在后」→ 整段倒序。此处以时间升序作为**单一事实来源**统一归一。
 *
 * 时间相同则用服务端绝对下标（historyIndex）兜底，再相同则保持原相对顺序（sort 稳定）。
 */
function orderChronologically(list: TaskMessage[]): TaskMessage[] {
  return [...list].sort((a, b) => {
    const d = tsOf(a) - tsOf(b);
    if (d !== 0) return d;
    const ha = a.historyIndex ?? Number.MAX_SAFE_INTEGER;
    const hb = b.historyIndex ?? Number.MAX_SAFE_INTEGER;
    return ha - hb;
  });
}

/**
 * 思考计时打点：随 thinkingStreaming 的「开始/结束」翻转补齐本地时刻。
 * - 开始（true）：首个 thinking 分片时记录 thinkingStartedAt（实时秒数基准）
 * - 结束（true→false）：记录 thinkingEndedAt（后端 thinkingMs 回补前的冻结兜底）
 * 已存在则不改写（一次思考一段计时）。
 */
function stampThinkingTiming(
  m: TaskMessage,
  nextThinkingStreaming: boolean,
): Partial<TaskMessage> {
  if (nextThinkingStreaming) {
    return m.thinkingStartedAt ? {} : { thinkingStartedAt: new Date().toISOString() };
  }
  if (m.thinkingStreaming && !m.thinkingEndedAt) {
    return { thinkingEndedAt: new Date().toISOString() };
  }
  return {};
}

/** 分组任务加载态（按需加载 + 组内分页）：groupId → { loaded, loading, hasMore, total } */
export interface GroupTasksMeta {
  /** 该分组第 1 页是否已加载（空组也会标记为已加载，避免重复请求） */
  loaded: boolean;
  /** 是否正在请求该分组任务 */
  loading: boolean;
  /** 组内是否还有未加载的任务页 */
  hasMore: boolean;
  /** 该分组任务总数（服务端权威，用于 hasMore 判定） */
  total: number;
}

interface UIState {
  // --- 会话 / 消息 ---
  activeSessionId: string | null;
  sessions: Session[];
  messagesBySession: Record<string, TaskMessage[]>;
  /**
   * 历史分页元数据（按 sessionId 索引）：游标 = 服务端「过滤软删除后的消息下标」。
   * 上滑加载更早用 oldestIndex 作 before，断线/完成后补齐用 newestIndex 作 after。
   */
  historyMetaBySession: Record<string, HistoryMeta | undefined>;
  /** 是否正在生成（按 sessionId 索引；缺省视为 false）。写入只能来自权威信号（见 setRunning 注释） */
  generatingBySession: Record<string, boolean>;
  /** 最近一轮运行是否出错（按 sessionId 索引；缺省视为 false，新流开始自动清除） */
  errorBySession: Record<string, boolean>;
  /** 工具发起的、等待用户回复的提问列表 */
  pendingAsks: PendingAsk[];

  /** 工具发起的、等待用户确认的请求列表 */
  pendingConfirms: PendingConfirm[];

  /** 消息撤回备份（redo 用）：sessionId → 被删消息快照与截断起点 */
  truncateBackups: Record<string, {
    /** 截断起点时间戳（恢复定位用） */
    messageTimestamp: string;
    /** 被删除的前端消息（按原顺序） */
    messages: TaskMessage[];
  } | undefined>;

  // --- 输入 / 工作目录 ---
  input: string;
  workingDirectory: string;
  /** 最近成功使用的目录（绝对路径），最多 5 条，新条目置顶 */
  recentDirectories: string[];
  /** 最近使用目录的自定义显示名（path → alias；仅影响列表显示） */
  recentDirectoryAliases: Record<string, string>;

  // --- 服务商（模型挂在服务商下；currentModel 为模型 id） ---
  providers: ProviderItem[];
  currentModel: string;

  // --- Agent ---
  agents: AgentItem[];
  currentAgent: string;

  // --- 任务 + 分组 ---
  tasks: TaskItem[];
  taskGroups: TaskGroup[];
  activeTaskId: string | null;
  /** 任务分组（文件夹）展开/收起状态：groupId → expanded（缺省视为展开）。
   *  仅持久化「被用户改动过」的分组项，未出现的分组运行时回退 true。 */
  taskGroupExpanded: Record<string, boolean>;
  /** 分组任务加载态（按需加载 + 组内分页）：groupId → { loaded, loading, hasMore, total } */
  groupTasksMeta: Record<string, GroupTasksMeta | undefined>;

  // --- Todo / Context（按 sessionId 索引） ---
  todosBySession: Record<string, TodoItem[]>;
  contextBySession: Record<
    string,
    { files: ContextFile[]; totalTokens: number; maxTokens: number }
  >;
  /** 上下文引擎统计（token 构成/缓存命中/压缩状态/系统分段；context-stats-updated 事件维护） */
  contextStatsBySession: Record<string, ContextStats | undefined>;
  /** LLM 文件读取信号（每次 WS context-updated，即真实 read/grep/glob 调用，递增；历史恢复不触发） */
  contextFileReadSeqBySession: Record<string, number>;

  // --- 自动化 ---
  automations: AutomationItem[];
  automationHistory: Record<string, AutomationRun[]>;
  /** 新建/编辑自动化任务表单：是否打开 */
  automationFormOpen: boolean;
  /** 编辑模式的任务 id（null = 新建） */
  automationFormEditingId: string | null;
  /** 表单打开序号（每次 open 递增；作为 Dialog key 强制重挂载，保证表单状态独立不继承上次输入） */
  automationFormSeq: number;

  // --- Skills / Commands ---
  skills: SkillItem[];
  /** 自定义斜杠命令（~/.moss/commands/<name>.md；/ 菜单与设置页数据源） */
  commands: CommandItem[];

  // --- 工具（完整列表，含 enabled/source，供工具管理 UI） ---
  tools: ToolItem[];

  // --- 配置 ---
  appConfig: AppConfig | null;
  apiConfig: ApiConfig | null;

  // --- MCP ---
  mcpServers: McpServer[];
  mcpTools: McpTool[];

  // --- 运行统计（会话级；stats-updated 事件维护，run 级口径每次发送重置） ---
  runStatsBySession: Record<string, RunStats | undefined>;

  // --- 专家团/Subagent 成员事件计数（agenteam.member.event 广播维护；key=taskId；内存态） ---
  agenteamEvents: Record<string, AgenteamEventEntry>;

  // --- 中控岛展开状态（会话级；默认折叠，undefined 视为折叠） ---
  hubActiveModuleBySession: Record<string, string | null | undefined>;

  // --- 工具图标映射（toolName → icon 字符串，由 /api/tools 拉取） ---
  toolIconMap: Record<string, string>;

  // --- WS ---
  wsStatus: 'connecting' | 'open' | 'closed' | 'error';
  /** 当前重连尝试次数（>0 表示处于重连中，状态条显示「正在重连（第 N 次）」） */
  wsReconnectAttempt: number;
  /** 下一次重连的预计时间戳（ms；null = 无待执行的退避重连） */
  wsNextRetryAt: number | null;
  /** 连接恢复计数：每次「断开后重新连上」+1（状态条短暂提示「已恢复」） */
  wsRestoredSeq: number;
  /** 会话状态恢复中（订阅 + 拉快照 + 恢复草稿，状态条显示「正在恢复会话状态」） */
  wsRestoringBySession: Record<string, boolean | undefined>;
  /** 尾部同步中（catchUpTail 拉取服务端正式消息，状态胶囊显示「正在同步最新消息」） */
  syncingBySession: Record<string, boolean | undefined>;

  // --- 发送快捷键（归一化格式：'enter' / 'mod+enter' / 任意自定义组合） ---
  sendShortcut: string;

  // --- 跟进行为（任务进行中发送消息时的处理方式） ---
  followUpBehavior: 'queue' | 'guide';
  /** 排队消息队列（sessionId → 待发送消息；合并语义：每会话至多一条，多条用分隔符合并） */
  messageQueueBySession: Record<string, QueuedMessage[]>;
  /**
   * 输入框回填通道（「编辑队列消息」用）：TaskInput 监听 seq 变化把 text 写入编辑框。
   * seq 自增，保证「同一文本二次回填」也能触发一次消费。
   */
  composerInjection: { text: string; attachments?: string[]; seq: number } | null;

  // --- 外观设置（IndexedDB 持久化） ---
  /** 主题色（预设 ID 或自定义 oklch/hex 字符串） */
  accentColor: string;
  /** 字号 */
  fontSize: 'small' | 'medium' | 'large';
  /** 界面密度 */
  uiDensity: 'compact' | 'standard' | 'comfortable';
  /** 圆角大小 */
  cornerRadius: 'small' | 'standard' | 'large';
  /**
   * 右侧面板宽度占整窗宽度的比例（0~1）。
   * 三档预设见 RIGHT_PANEL_PRESETS；拖拽调宽直接改写该比例（精确百分比）。
   */
  rightPanelRatio: number;
  /** 右侧面板宽度是否由「手动拖拽」产生（true → 设置项显示「自定义」；选中预设后复位） */
  rightPanelCustom: boolean;

  // --- 执行权限模式（permissionMode=全局默认；permissionModeBySession=会话级覆盖） ---
  permissionMode: PermissionMode;
  /** 会话级权限模式覆盖（sessionId → mode；sendMessage 取当前会话值，缺省回退全局） */
  permissionModeBySession: Record<string, PermissionMode | undefined>;

  // --- 右侧边栏标签页（会话级，IndexedDB 持久化） ---
  /** taskId → 标签集合与活跃标签（各会话独立；'' key = 空白页，无记录时回退默认「开始」） */
  sidebarTabsBySession: Record<string, SessionSidebarTabs | undefined>;
  /**
   * 持久终端元数据（会话级内存态；终端本体在后端进程内存，刷新后由 terminal.list 复原）。
   * 值为 { list, activeId }。
   */
  terminalsBySession: Record<string, { list: TerminalInfo[]; activeId?: string } | undefined>;
  /**
   * 终端 PTY 后端兼容信息（Windows ConPTY；随 terminal.list 同帧下发）。
   * xterm 的 `windowsPty` 启发式依赖 buildNumber 才能生效（用于修正 ConPTY
   * 回显/reflow 的重复错乱）；非 Windows 或未知为 null。
   */
  terminalPtyBackend: { backend: 'conpty'; buildNumber: number } | null;
  /** 右侧面板展开态（会话级内存态：各会话独立互不影响，重挂载不重置；'' key = 空白页） */
  rightPanelOpenBySession: Record<string, boolean | undefined>;
  /**
   * 文件预览弹层路径（内存态；仅移动端从「非侧边栏」入口触发时使用）。
   * null = 关闭。桌面端统一走右侧边栏标签，不使用该弹层。
   */
  filePreviewDialogPath: string | null;

  // --- 渲染设置（render 模块，IndexedDB 持久化） ---
  renderSettings: RenderSettings;
  /** 动画设置（总开关+分开关；IndexedDB 持久化） */
  animationSettings: AnimationSettings;
  /** 系统是否开启"减弱动态效果"（matchMedia 实时监听；true 时强制停用全部动画） */
  prefersReducedMotion: boolean;
}

/** 从 IndexedDB 预填充后写入 store 的持久化状态（各字段可选，值非法时忽略） */
export interface PersistedState {
  workingDirectory?: string;
  recentDirectories?: string[];
  sendShortcut?: string;
  followUpBehavior?: 'queue' | 'guide';
  accentColor?: string;
  fontSize?: 'small' | 'medium' | 'large';
  uiDensity?: 'compact' | 'standard' | 'comfortable';
  cornerRadius?: 'small' | 'standard' | 'large';
  rightPanelRatio?: number;
  /** 右侧面板是否为「手动拖拽」产生的宽度（true → 设置项显示「自定义」） */
  rightPanelCustom?: boolean;
  permissionMode?: PermissionMode;
  /** 右侧边栏标签页（会话级持久化；不持久化 '' 键） */
  sidebarTabsBySession?: Record<string, SessionSidebarTabs>;
  renderSettings?: RenderSettings;
  animationSettings?: AnimationSettings;
  /** 排队消息队列（sessionId → 待发送消息）：刷新后不丢，按序继续投递 */
  messageQueues?: Record<string, QueuedMessage[]>;
  /** 最近使用目录的自定义显示名（path → alias） */
  recentDirectoryAliases?: Record<string, string>;
  /** 任务分组展开/收起（groupId → expanded；仅存被改动过的项） */
  taskGroupExpanded?: Record<string, boolean>;
}

// ============================================================================
// Actions
// ============================================================================

interface UIActions {
  // 会话
  setActiveSession: (id: string | null) => void;
  setSessions: (s: Session[]) => void;
  addSession: (s: Session) => void;
  removeSession: (id: string) => void;

  // 消息
  setMessages: (sessionId: string, messages: TaskMessage[]) => void;
  addMessage: (sessionId: string, message: TaskMessage) => void;
  /**
   * 历史分页合并（按消息 id 归并）：
   * - 'tail'：权威替换（首屏 / 截断后重载），同时重置分页元数据
   * - 'prepend'：向前并入更早的一页（保持已有消息）
   * - 'catchup'：尾部增量补齐（并入后追加），本地与服务端同 id 的消息原位 patch
   *   （流式草稿 → 正式内容，key 不漂移零重挂载）；dropStreaming 时移除服务端未确认的草稿
   *   （dropStreamingIds 给定时**只**移除这些 id —— 由调用方传入「拉取前仍在流式的快照集合」，
   *   避免把拉取期间新一轮产生的流式消息一并丢掉）
   */
  mergeHistory: (
    sessionId: string,
    messages: TaskMessage[],
    mode: 'tail' | 'prepend' | 'catchup',
    page?: { total: number; oldestIndex: number; newestIndex: number; hasMoreBefore: boolean },
    opts?: { dropStreaming?: boolean; dropStreamingIds?: string[] },
  ) => void;
  /** 仅更新分页元数据（加载态 / 游标推进，不动消息） */
  patchHistoryMeta: (sessionId: string, patch: Partial<HistoryMeta>) => void;
  /** 清空分页元数据（截断/恢复后需重新按 tail 加载） */
  resetHistory: (sessionId: string) => void;
  /** 移除本地流式消息（服务端以正式历史消息重新给出时调用，避免重复渲染） */
  dropStreamingMessages: (sessionId: string) => void;
  updateMessage: (sessionId: string, messageId: string, patch: Partial<TaskMessage>) => void;
  appendToMessage: (
    sessionId: string,
    messageId: string,
    field: 'content' | 'thinking',
    text: string,
  ) => void;
  /** 合并 appendToMessage + updateMessage(thinkingStreaming) 为单次 set，降低高频流式更新的渲染压力 */
  appendTextAndMarkThinking: (
    sessionId: string,
    messageId: string,
    field: 'content' | 'thinking',
    text: string,
    thinkingStreaming: boolean,
  ) => void;
  clearMessages: (sessionId: string) => void;

  // 生成态
  /** 写入权威运行态（历史拉取永不写 false；只由状态快照/WS 完成事件/本地发送-中断写） */
  setGenerating: (sessionId: string, v: boolean) => void;
  /** 标记/清除 session 的错误态（新流开始时由 setGenerating 自动清除） */
  setTaskError: (sessionId: string, v: boolean) => void;
  /** 将指定 session 中所有 streaming 的消息标记为已完成 */
  finalizeStreamingMessages: (sessionId: string) => void;

  // 输入 / 工作目录
  setInput: (input: string) => void;
  setWorkingDirectory: (cwd: string) => void;
  addRecentDirectory: (dir: string) => void;
  /** 从「最近使用」移除一条（并清理其别名） */
  removeRecentDirectory: (dir: string) => void;
  /** 设置/清空某条「最近使用」的自定义显示名（空串 = 清除别名） */
  renameRecentDirectory: (dir: string, alias: string) => void;
  /** 修改某条「最近使用」的目标路径（保留其在列表中的位置与别名） */
  updateRecentDirectoryPath: (oldPath: string, newPath: string) => void;

  // 服务商
  setProviders: (providers: ProviderItem[]) => void;
  setCurrentModel: (m: string) => void;

  // Agent
  setAgents: (a: AgentItem[]) => void;
  setCurrentAgent: (id: string) => void;

  // 任务 + 分组
  setTasks: (tasks: TaskItem[]) => void;
  setTaskGroups: (groups: TaskGroup[]) => void;
  addTask: (task: TaskItem) => void;
  touchTask: (id: string) => void;
  updateTask: (id: string, patch: Partial<TaskItem>) => void;
  removeTask: (id: string) => void;
  setActiveTaskId: (id: string | null) => void;
  addTaskGroup: (group: TaskGroup) => void;
  updateTaskGroup: (id: string, patch: Partial<TaskGroup>) => void;
  removeTaskGroup: (id: string) => void;
  /** 设置某分组的展开/收起并持久化到 IndexedDB（groupId → expanded 全量落盘） */
  setTaskGroupExpanded: (groupId: string, expanded: boolean) => void;
  /** 局部更新某分组任务加载态（发起请求前置 loading 等） */
  patchGroupTasksMeta: (groupId: string, patch: Partial<GroupTasksMeta>) => void;
  /**
   * 写入某分组的一页任务：mode='replace' 覆盖该组切片（首屏）；mode='append' 续载（按 id 去重）。
   * 只影响该分组，其它分组任务原样保留。
   */
  setGroupTasks: (
    groupId: string,
    tasks: TaskItem[],
    meta: Partial<GroupTasksMeta>,
    mode: 'replace' | 'append',
  ) => void;
  /** 清空全部任务与分组加载态（首载 / 兜底重载前调用） */
  resetGroupTasks: () => void;
  /**
   * 全量任务快照（WS tasks.changed / tasks.reordered、PUT reorder 响应、无参 GET /api/tasks）：
   * 物化全部任务，并把当前所有分组标记为「已加载、无更多」（折叠分组由 Radix 卸载内容，不占 DOM）。
   */
  applyFullTaskSnapshot: (tasks: TaskItem[]) => void;

  // Todo / Context
  setTodos: (sessionId: string, todos: TodoItem[]) => void;
  setContext: (
    sessionId: string,
    ctx: { files: ContextFile[]; totalTokens: number; maxTokens: number },
  ) => void;
  /** 更新会话上下文引擎统计（stats API / context-stats-updated 事件） */
  setContextStats: (sessionId: string, stats: ContextStats) => void;
  /** 递增会话的 LLM 文件读取信号（仅 WS context-updated 真实读取时调用） */
  bumpContextFileReadSeq: (sessionId: string) => void;

  // 自动化
  setAutomations: (a: AutomationItem[]) => void;
  addAutomation: (a: AutomationItem) => void;
  updateAutomation: (id: string, patch: Partial<AutomationItem>) => void;
  removeAutomation: (id: string) => void;
  setAutomationHistory: (id: string, history: AutomationRun[]) => void;
  addAutomationRun: (id: string, run: AutomationRun) => void;
  updateAutomationRun: (id: string, runId: string, patch: Partial<AutomationRun>) => void;
  openAutomationForm: (editingId?: string) => void;
  closeAutomationForm: () => void;

  // Skills / Commands
  setSkills: (s: SkillItem[]) => void;
  setCommands: (c: CommandItem[]) => void;

  // 工具
  setTools: (t: ToolItem[]) => void;
  updateTool: (name: string, patch: Partial<ToolItem>) => void;

  // 配置
  setAppConfig: (c: AppConfig | null) => void;
  setApiConfig: (c: ApiConfig | null) => void;

  // MCP
  setMcpServers: (s: McpServer[]) => void;
  setMcpTools: (t: McpTool[]) => void;

  // 运行统计（stats-updated 事件；sendMessage 时清空旧 run 数据）
  setRunStats: (sessionId: string, stats: RunStats | undefined) => void;

  // 专家团/Subagent 成员事件计数（agenteam.member.event 广播；上限 100 条按 lastAt 淘汰）
  bumpAgenteamEvent: (taskId: string, teamId: string | null, memberName: string) => void;

  // 中控岛展开模块（null=折叠；moduleId=展开并激活）
  setHubActiveModule: (sessionId: string, moduleId: string | null) => void;

  // 工具图标映射
  setToolIconMap: (map: Record<string, string>) => void;

  // PendingAsk
  addPendingAsk: (ask: PendingAsk) => void;
  removePendingAsk: (sessionId: string, toolCallId: string) => void;
  clearPendingAsks: () => void;
  /** 仅清除指定 session 的 pendingAsks */
  clearPendingAsksBySession: (sessionId: string) => void;

  // 消息撤回备份
  setTruncateBackup: (sessionId: string, backup: { messageTimestamp: string; messages: TaskMessage[] } | undefined) => void;

  // PendingConfirm
  addPendingConfirm: (confirm: PendingConfirm) => void;
  removePendingConfirm: (sessionId: string, toolCallId: string) => void;
  clearPendingConfirmsBySession: (sessionId: string) => void;

  // WS
  setWsStatus: (s: UIState['wsStatus']) => void;
  /** 连接状态详情（含重连次数与下次重试时间），状态条数据源 */
  setWsConnection: (info: { status: UIState['wsStatus']; attempt: number; nextRetryAt: number | null }) => void;
  /** 连接恢复计数 +1（断开后重新连上；状态条短暂提示「已恢复」） */
  bumpWsRestored: () => void;
  /** 会话状态恢复中标记 */
  setWsRestoring: (sessionId: string, v: boolean) => void;
  /** 尾部同步中标记（catchUpTail 拉取服务端正式消息） */
  setSyncing: (sessionId: string, v: boolean) => void;

  // 发送快捷键
  setSendShortcut: (v: UIState['sendShortcut']) => void;

  // 跟进行为
  setFollowUpBehavior: (v: UIState['followUpBehavior']) => void;
  /** 入队（合并语义）：该会话已有队列项则合并到同一条，否则新建 */
  addToMessageQueue: (sessionId: string, message: QueuedMessage) => void;
  /** 移出并返回某条队列消息（供「编辑回填」使用）；不存在返回 null */
  takeFromMessageQueue: (sessionId: string, messageId: string) => QueuedMessage | null;
  removeFromMessageQueue: (sessionId: string, messageId: string) => void;
  clearMessageQueue: (sessionId: string) => void;
  /** 把文本回填到消息发送框（「编辑」队列消息用；seq 自增触发一次消费） */
  injectComposer: (text: string, attachments?: string[]) => void;
  /** 消费后清空回填通道 */
  clearComposerInjection: () => void;

  // 外观设置
  setAccentColor: (v: string) => void;
  setFontSize: (v: UIState['fontSize']) => void;
  setUiDensity: (v: UIState['uiDensity']) => void;
  setCornerRadius: (v: UIState['cornerRadius']) => void;
  setRightPanelRatio: (v: number, manual?: boolean) => void;

  // 执行权限模式
  setPermissionMode: (v: UIState['permissionMode'], sessionId?: string) => void;

  // 渲染设置（render 模块）
  setRenderSetting: <K extends keyof RenderSettings>(key: K, value: RenderSettings[K]) => void;

  // 动画设置（总开关+分开关；IndexedDB 持久化）与系统减弱动态偏好
  setAnimationSetting: <K extends keyof AnimationSettings>(key: K, value: AnimationSettings[K]) => void;
  setPrefersReducedMotion: (v: boolean) => void;

  // 模型菜单"添加服务商"跳转设置页并打开弹窗的信号
  providerDialogRequest: boolean;
  requestProviderDialog: () => void;
  clearProviderDialogRequest: () => void;

  // 移动端服务商页 header 搜索按钮：切换搜索框显隐（seq 计数，避免连续点击不触发）
  providerSearchSeq: number;
  toggleProviderSearch: () => void;

  // 插件库 MCP tab：页面头部/移动端全局 header"添加服务器"按钮 → McpTab 打开弹窗的信号
  mcpDialogRequest: boolean;
  requestMcpDialog: () => void;
  clearMcpDialogRequest: () => void;

  // 插件库 MCP tab：移动端全局 header 刷新按钮（seq 计数，避免连续点击不触发）
  mcpRefreshSeq: number;
  requestMcpRefresh: () => void;

  // 插件库技能 tab：页面头部/移动端全局 header"添加技能"按钮 → 技能弹窗打开信号
  skillsDialogRequest: boolean;
  requestSkillsDialog: () => void;
  clearSkillsDialogRequest: () => void;

  // 插件库技能 tab：移动端全局 header 刷新按钮（seq 计数）
  skillsRefreshSeq: number;
  requestSkillsRefresh: () => void;

  // 右侧边栏标签页（全部按会话隔离，首参为 sessionId）
  /** 新建标签页，返回新标签 id；自动设为活跃 */
  addSidebarTab: (sessionId: string, type: SidebarTabType, title: string, toolCallId?: string) => string;
  /** 以文件预览标签打开路径（同一路径已打开则聚焦，不重复建页）；返回标签 id */
  openFileTab: (sessionId: string, path: string) => string;
  /**
   * 以「压缩包内层条目」打开标签页（可持久化：仅记录 archivePath+innerPath，
   * 刷新后由渲染器重新提取内容）；同一 archivePath+innerPath 已打开则聚焦。
   */
  openArchiveEntryTab: (
    sessionId: string,
    entry: { archivePath: string; innerPath: string; name: string },
  ) => string;
  /** 删除标签页；若删的是活跃标签则自动切到最后一个；删空则重建默认「开始」 */
  removeSidebarTab: (sessionId: string, id: string) => void;
  /** 设置活跃标签页 */
  setActiveSidebarTab: (sessionId: string, id: string) => void;
  /** 重命名标签页 */
  renameSidebarTab: (sessionId: string, id: string, title: string) => void;
  /** 拖拽重排标签页顺序 */
  reorderSidebarTabs: (sessionId: string, fromId: string, toId: string) => void;
  /** 重置某会话标签为默认「开始」（新建任务空白页用） */
  resetSidebarTabs: (sessionId: string) => void;
  /** 原地转换某标签的类型/标题（「开始」页点入口 → 原地变身，不新增标签） */
  convertSidebarTab: (sessionId: string, id: string, type: SidebarTabType, title: string) => void;
  /**
   * 聚焦「终端」标签页（AI 新建终端时自动展示）：
   * 已有终端标签则激活；否则把「开始」标签原地转成终端；再否则新增；并展开右侧面板。
   */
  focusTerminalTab: (sessionId: string) => void;

  // 持久终端（按会话隔离；元数据内存态，实际终端在后端进程，刷新由 terminal.list 复原）
  /** 覆盖某会话的终端列表（terminal.list 响应） */
  setTerminalList: (sessionId: string, terminals: TerminalInfo[]) => void;
  /** 新增/更新一个终端（terminal.created 响应/事件） */
  addTerminal: (terminal: TerminalInfo) => void;
  /** 移除一个终端（terminal.closed） */
  removeTerminal: (terminalId: string) => void;
  /** 局部更新终端信息（terminal.exit 等） */
  updateTerminal: (terminalId: string, patch: Partial<TerminalInfo>) => void;
  /** 设置某会话的活跃终端 id */
  setActiveTerminal: (sessionId: string, terminalId: string) => void;
  /** 记录 PTY 后端兼容信息（terminal.list 同帧下发；null = 非 Windows / 未知） */
  setTerminalPtyBackend: (info: { backend: 'conpty'; buildNumber: number } | null) => void;

  // 右侧面板展开态（会话级），内存态不持久化
  setRightPanelOpen: (sessionId: string, v: boolean) => void;
  /** 面板开合状态随对话转移：空白页（''）发送首条消息创建新会话时继承，避免导航重挂载后收起 */
  migrateRightPanelState: (fromSessionId: string, toSessionId: string) => void;

  // 文件预览弹层（移动端非侧边栏入口；桌面端不使用）
  /** 打开文件预览弹层（path 为文件绝对路径） */
  showFilePreviewDialog: (path: string) => void;
  /** 关闭文件预览弹层 */
  hideFilePreviewDialog: () => void;

  // 持久化状态注入（main.tsx 预填充 IndexedDB 后、渲染前调用）
  hydratePersisted: (patch: PersistedState) => void;
}

export type Store = UIState & UIActions;

// ============================================================================
// 工作目录：默认路径 + IndexedDB 持久化
// ============================================================================

/** 系统级（本机）工作目录哨兵：全盘访问（filesys roots 放行，terminal 默认目录为主目录） */
export const SYSTEM_WORKING_DIRECTORY = '__system__';

/** 默认工作目录：本机 System 模式 */
export const DEFAULT_WORKING_DIRECTORY = SYSTEM_WORKING_DIRECTORY;

/** 旧版默认工作目录（C 盘根）：IndexedDB 存量值迁移用 */
export const LEGACY_DEFAULT_WORKING_DIRECTORY = 'C:\\';

// ============================================================================
// 右侧面板宽度：占整窗宽度比例（外观设置「右侧面板」三档预设 + 拖拽微调）
// ============================================================================

/** 三档预设比例（相对整个窗口宽度；窄 < 标准 < 宽，等差约 10.5%） */
export const RIGHT_PANEL_PRESETS = {
  narrow: 0.32,
  standard: 0.425,
  wide: 0.53,
} as const;

/** 拖拽可调范围 = 三档预设的「窄 ~ 宽」区间（不允许拖到比「窄」更窄、比「宽」更宽） */
export const RIGHT_PANEL_RATIO_MIN = RIGHT_PANEL_PRESETS.narrow;
export const RIGHT_PANEL_RATIO_MAX = RIGHT_PANEL_PRESETS.wide;

/**
 * 右侧面板最小像素宽度兜底。因拖拽下限已是 32% 窗宽，该下限仅在窗口宽 < 750px 时才可能生效，
 * 而 < 768px 已走移动端布局（右侧面板为 Sheet），故桌面端实际不会触发。
 */
export const RIGHT_PANEL_MIN_PX = 240;

/** 比例钳制到可拖拽范围 */
export function clampRightPanelRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return RIGHT_PANEL_PRESETS.standard;
  return Math.min(RIGHT_PANEL_RATIO_MAX, Math.max(RIGHT_PANEL_RATIO_MIN, ratio));
}

/** 预设项 → 比例（供设置页 Select 使用） */
export type RightPanelPreset = keyof typeof RIGHT_PANEL_PRESETS;

/** 比例 → 命中哪个预设（误差 < 0.005）；未命中返回 'custom' */
export function rightPanelPresetOf(ratio: number): RightPanelPreset | 'custom' {
  for (const [key, value] of Object.entries(RIGHT_PANEL_PRESETS) as Array<
    [RightPanelPreset, number]
  >) {
    if (Math.abs(ratio - value) < 0.005) return key;
  }
  return 'custom';
}

/** 默认右侧边栏「开始」标签（面板启动器：任务摘要 / 终端 / 专家团） */
function defaultSidebarTab(): SidebarTab {
  return {
    id: 'default-start',
    type: 'start',
    title: 'start.title',
    createdAt: Date.now(),
  };
}

/** 生成标签页唯一 id */
function newTabId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 单个会话的右侧边栏标签状态 */
export interface SessionSidebarTabs {
  tabs: SidebarTab[];
  activeId: string | null;
}

/** 无记录会话的只读回退（仅「开始」）；勿就地修改 */
export const DEFAULT_SIDEBAR_TABS: SidebarTab[] = [defaultSidebarTab()];

/** 生成某会话的默认标签状态（深拷贝默认标签，避免跨会话共享同一 tab 对象引用） */
function defaultSessionTabs(): SessionSidebarTabs {
  return {
    tabs: DEFAULT_SIDEBAR_TABS.map((t) => ({ ...t })),
    activeId: DEFAULT_SIDEBAR_TABS[0].id,
  };
}

/** 持久化按会话标签状态：过滤 '' 键（空白页）与空值，避免新对话复活旧标签 */
function persistSidebarTabs(map: Record<string, SessionSidebarTabs | undefined>): void {
  const clean: Record<string, SessionSidebarTabs> = {};
  for (const [k, v] of Object.entries(map)) if (k && v) clean[k] = v;
  void idbSet('moss-sidebar-tabs-by-session', clean);
}

// ============================================================================
// Store 实现
// ============================================================================

export const useStore = create<Store>((set, get) => ({
  // --- 会话 / 消息 ---
  activeSessionId: null,
  sessions: [],
  messagesBySession: {},
  historyMetaBySession: {},
  generatingBySession: {},
  errorBySession: {},
  pendingAsks: [],
  pendingConfirms: [],
  truncateBackups: {},

  // --- 输入 / 工作目录 ---
  input: '',
  workingDirectory: DEFAULT_WORKING_DIRECTORY,
  recentDirectories: [],
  /** 最近使用目录的自定义显示名（path → alias） */
  recentDirectoryAliases: {},

  // --- 服务商 ---
  providers: [],
  currentModel: '',

  // --- Agent ---
  agents: [],
  currentAgent: '',

  // --- 任务 + 分组 ---
  tasks: [],
  taskGroups: [],
  activeTaskId: null,
  taskGroupExpanded: {},
  groupTasksMeta: {},

  // --- Todo / Context ---
  todosBySession: {},
  contextBySession: {},
  contextStatsBySession: {},
  contextFileReadSeqBySession: {},

  // --- 自动化 ---
  automations: [],
  automationHistory: {},
  automationFormOpen: false,
  automationFormEditingId: null,
  automationFormSeq: 0,

  // --- Skills / Commands ---
  skills: [],
  commands: [],

  // --- 工具 ---
  tools: [],

  // --- 配置 ---
  appConfig: null,
  apiConfig: null,

  // --- MCP ---
  mcpServers: [],
  mcpTools: [],
  runStatsBySession: {},
  agenteamEvents: {},
  hubActiveModuleBySession: {},

  // --- 工具图标映射 ---
  toolIconMap: {},

  // --- WS ---
  wsStatus: 'closed',
  wsReconnectAttempt: 0,
  wsNextRetryAt: null,
  wsRestoredSeq: 0,
  wsRestoringBySession: {},
  syncingBySession: {},

  // --- 发送快捷键 ---
  sendShortcut: 'mod+enter',

  // --- 跟进行为 ---
  followUpBehavior: 'queue',
  messageQueueBySession: {},
  composerInjection: null,

  // --- 外观设置 ---
  accentColor: 'blue',
  fontSize: 'medium',
  uiDensity: 'standard',
  cornerRadius: 'standard',
  rightPanelRatio: RIGHT_PANEL_PRESETS.standard,
  rightPanelCustom: false,

  // --- 执行权限模式 ---
  permissionMode: 'ask',
  permissionModeBySession: {},

  // --- 渲染设置（render 模块，IndexedDB 持久化） ---
  renderSettings: DEFAULT_RENDER_SETTINGS,
  animationSettings: DEFAULT_ANIMATION_SETTINGS,
  prefersReducedMotion: false,

  // 模型菜单"添加服务商"跳转设置页并打开弹窗的信号
  providerDialogRequest: false,
  providerSearchSeq: 0,

  // 插件库 MCP tab：header 按钮信号
  mcpDialogRequest: false,
  mcpRefreshSeq: 0,

  // 插件库技能 tab：header 按钮信号
  skillsDialogRequest: false,
  skillsRefreshSeq: 0,

  // --- 右侧边栏标签页（会话级，IndexedDB 持久化；无记录的会话回退默认「开始」） ---
  sidebarTabsBySession: {},

  // --- 持久终端元数据（会话级；内存态，终端本体在后端进程） ---
  terminalsBySession: {},
  terminalPtyBackend: null,

  // --- 右侧面板展开态（内存态；默认收起） ---
  rightPanelOpenBySession: {},
  filePreviewDialogPath: null,

  // --- Actions: 会话 ---
  setActiveSession: (id) => set({ activeSessionId: id }),
  setSessions: (sessions) => set({ sessions }),
  addSession: (s) => set((state) => ({ sessions: [...state.sessions, s] })),
  removeSession: (id) =>
    set((state) => {
      const { [id]: _omit, ...restMessages } = state.messagesBySession;
      const { [id]: _omitMeta, ...restMeta } = state.historyMetaBySession;
      const { [id]: _omitRestoring, ...restRestoring } = state.wsRestoringBySession;
      const { [id]: _omitSyncing, ...restSyncing } = state.syncingBySession;
      const { [id]: _omitGen, ...restGen } = state.generatingBySession;
      const { [id]: _omitTodos, ...restTodos } = state.todosBySession;
      const { [id]: _omitCtx, ...restCtx } = state.contextBySession;
      const { [id]: _omitReadSeq, ...restReadSeq } = state.contextFileReadSeqBySession;
      const { [id]: _omitPerm, ...restPermModes } = state.permissionModeBySession;
      const { [id]: _omitBackup, ...restBackups } = state.truncateBackups;
      const { [id]: _omitStats, ...restStats } = state.runStatsBySession;
      const { [id]: _omitHub, ...restHub } = state.hubActiveModuleBySession;
      const { [id]: _omitPanel, ...restPanel } = state.rightPanelOpenBySession;
      const { [id]: _omitTabs, ...restTabs } = state.sidebarTabsBySession;
      return {
        sessions: state.sessions.filter((s) => s.id !== id),
        messagesBySession: restMessages,
        historyMetaBySession: restMeta,
        wsRestoringBySession: restRestoring,
        syncingBySession: restSyncing,
        generatingBySession: restGen,
        todosBySession: restTodos,
        contextBySession: restCtx,
        contextFileReadSeqBySession: restReadSeq,
        permissionModeBySession: restPermModes,
        truncateBackups: restBackups,
        runStatsBySession: restStats,
        hubActiveModuleBySession: restHub,
        rightPanelOpenBySession: restPanel,
        sidebarTabsBySession: restTabs,
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
      };
    }),

  // --- Actions: 消息 ---
  setMessages: (sessionId, messages) =>
    set((state) => ({
      messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
    })),
  addMessage: (sessionId, message) =>
    set((state) => {
      const current = state.messagesBySession[sessionId] ?? [];
      // 归一为时间升序：较晚到达的「较早消息」也能落到正确位置（不依赖后续 mergeHistory）
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: orderChronologically([...current, message]),
        },
      };
    }),

  mergeHistory: (sessionId, messages, mode, page, opts) =>
    set((state) => {
      const current = state.messagesBySession[sessionId] ?? [];

      // —— 第零步：id 冲突防御（旧格式脏数据兜底闸门）——
      // 旧版本 messageId `<sessionId>#<turn>` 每 run 从 1 计数，跨 run 已在历史中留下
      // 重复 id。若不做校验直接按 id patch，「新消息内容覆盖旧消息槽位」就是
      // 「MCP 消息错位替换第一条消息」的根因。同 id 但角色不同 / 时间戳大幅倒退 →
      // 判定冲突：该服务端消息改用 dup 后缀 id 走 rest 追加，绝不在旧槽位原位替换。
      const currentById = new Map(current.map((m) => [m.id, m]));
      let dupSeq = 0;
      const resolved = messages.map((m) => {
        const local = currentById.get(m.id);
        if (
          local &&
          (local.role !== m.role ||
            Date.parse(m.timestamp) < Date.parse(local.timestamp) - 60_000)
        ) {
          const renamed: TaskMessage = { ...m, id: `${m.id}#dup${++dupSeq}` };
          diag('merge-id-collision', {
            sessionId,
            id: m.id,
            localRole: local.role,
            incomingRole: m.role,
            localTs: local.timestamp,
            incomingTs: m.timestamp,
          });
          return renamed;
        }
        return m;
      });

      // —— 第一步：同 id 归并（「流式草稿 ↔ 服务端正式副本」同一身份）——
      // 历史路径的 assistant 消息 id = 服务端 messageId（与本地流式草稿同 id）。
      // 本地消息在 incoming 中存在同 id 副本时，以服务端内容原位 patch：
      // 数组槽位与 React key 保持稳定 → 虚拟列表不卸载重挂载、MarkdownBlock
      // memo 冻结生效 → 尾部补齐（done / 重连对齐）零闪烁。
      const incomingById = new Map(resolved.map((m) => [m.id, m]));
      const patchedIds = new Set<string>();
      const base = current.map((m) => {
        const server = incomingById.get(m.id);
        if (!server) return m;
        patchedIds.add(m.id);
        return { ...server, streaming: false, thinkingStreaming: false };
      });
      // 未与本地消息同 id 的部分（更早的历史页 / 服务端新增消息）
      const rest = resolved.filter((m) => !patchedIds.has(m.id));

      let next: TaskMessage[];
      if (mode === 'prepend') {
        next = [...rest, ...base];
      } else if (mode === 'catchup') {
        if (opts?.dropStreaming) {
          // 一轮正常结束：服务端未确认的本地草稿（未命中 patch 且仍 streaming）移除，
          // 防止残留 spinner；已 patch 的消息 streaming 已置 false，天然保留。
          // dropStreamingIds 给定时只丢这些 id（「拉取前仍在流式的快照」）：
          // 拉取期间新一轮已开始流式时，其消息不在快照里 → 被完整保留，避免整轮内容被清空。
          const dropIds = opts.dropStreamingIds ? new Set(opts.dropStreamingIds) : null;
          next = [
            ...base.filter((m) => !(m.streaming && (dropIds ? dropIds.has(m.id) : true))),
            ...rest,
          ];
        } else {
          // 重连对齐：保留本地草稿（若服务端有正式副本则已被 patch 收尾）
          next = [...base, ...rest];
        }
      } else {
        // tail：权威替换（服务端末页为骨架；同 id 已 patch 的本地草稿与服务端正式副本
        // 内容等价，直接采用服务端序列即可）。本地独有的流式草稿（服务端尚未落盘）与
        // 「上次中断的未完成回复」提示消息保底保留，避免打断在途输出 / 丢失真实信息。
        // 另保留**本地乐观 user 消息**：新任务发送后首屏 fetch 可能先于后端持久化到达
        // （返回空/滞后页），不清空会让消息区闪空、用户消息消失（「黑一下」根因）。
        const serverClientIds = new Set(
          resolved.filter((m) => m.clientMessageId).map((m) => m.clientMessageId as string),
        );
        const localOnly = base.filter(
          (m) =>
            !patchedIds.has(m.id) &&
            ((m.streaming || m.interrupted || m.compaction) ||
              (m.role === 'user' &&
                !m.serverMessageId &&
                m.clientMessageId !== undefined &&
                !serverClientIds.has(m.clientMessageId))),
        );
        if (localOnly.length > 0) {
          diag('tail-optimistic-kept', {
            sessionId,
            kept: localOnly.map((m) => m.id),
            serverCount: resolved.length,
          });
        }
        next = [...resolved, ...localOnly];
      }

      // 归一为时间升序（单一事实来源）：三种模式的拼接都可能是「到达顺序」，
      // 这里统一纠正为「消息时间顺序」，根治「最新先到就显示在最前」的整段倒序。
      next = orderChronologically(next);

      const prevMeta = state.historyMetaBySession[sessionId];
      let meta: HistoryMeta;
      if (mode === 'prepend' && !page && prevMeta) {
        meta = {
          ...prevMeta,
          oldestIndex: Math.max(0, prevMeta.oldestIndex - rest.length),
          hasMoreBefore: prevMeta.oldestIndex - rest.length > 0,
          loadingBefore: false,
        };
      } else if (page) {
        meta = {
          total: page.total,
          oldestIndex: mode === 'prepend' && prevMeta ? Math.min(prevMeta.oldestIndex, page.oldestIndex) : page.oldestIndex,
          newestIndex: Math.max(page.newestIndex, mode === 'catchup' ? (prevMeta?.newestIndex ?? -1) : page.newestIndex),
          hasMoreBefore: mode === 'prepend' && prevMeta ? page.hasMoreBefore || prevMeta.hasMoreBefore : page.hasMoreBefore,
          loadingBefore: false,
          loaded: true,
        };
      } else {
        meta = prevMeta ?? {
          total: next.length,
          oldestIndex: 0,
          newestIndex: next.length - 1,
          hasMoreBefore: false,
          loadingBefore: false,
          loaded: true,
        };
      }

      return {
        messagesBySession: { ...state.messagesBySession, [sessionId]: next },
        historyMetaBySession: { ...state.historyMetaBySession, [sessionId]: meta },
      };
    }),

  patchHistoryMeta: (sessionId, patch) =>
    set((state) => {
      const prev = state.historyMetaBySession[sessionId];
      const base: HistoryMeta = prev ?? {
        total: 0,
        oldestIndex: 0,
        newestIndex: -1,
        hasMoreBefore: false,
        loadingBefore: false,
        loaded: false,
      };
      return {
        historyMetaBySession: { ...state.historyMetaBySession, [sessionId]: { ...base, ...patch } },
      };
    }),

  resetHistory: (sessionId) =>
    set((state) => {
      const { [sessionId]: _omit, ...rest } = state.historyMetaBySession;
      return { historyMetaBySession: rest };
    }),

  dropStreamingMessages: (sessionId) =>
    set((state) => {
      const current = state.messagesBySession[sessionId] ?? [];
      const next = current.filter((m) => !m.streaming && m.serverMessageId === undefined);
      if (next.length === current.length) return {};
      return { messagesBySession: { ...state.messagesBySession, [sessionId]: next } };
    }),
  updateMessage: (sessionId, messageId, patch) =>
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) =>
          m.id === messageId
            ? {
                ...m,
                ...patch,
                // thinkingStreaming 显式翻转时补齐思考计时打点（tool-call-start 等路径置 false）
                ...(patch.thinkingStreaming !== undefined
                  ? stampThinkingTiming(m, patch.thinkingStreaming)
                  : {}),
              }
            : m,
        ),
      },
    })),
  appendToMessage: (sessionId, messageId, field, text) =>
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) =>
          m.id === messageId ? { ...m, [field]: (m[field] ?? '') + text } : m,
        ),
      },
    })),
  appendTextAndMarkThinking: (sessionId, messageId, field, text, thinkingStreaming) =>
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) =>
          m.id === messageId
            ? { ...m, [field]: (m[field] ?? '') + text, thinkingStreaming, ...stampThinkingTiming(m, thinkingStreaming) }
            : m,
        ),
      },
    })),
  clearMessages: (sessionId) =>
    set((state) => ({
      messagesBySession: { ...state.messagesBySession, [sessionId]: [] },
    })),

  // --- Actions: 生成态 ---
  setGenerating: (sessionId, v) =>
    set((state) => ({
      generatingBySession: { ...state.generatingBySession, [sessionId]: v },
      // 新流开始自动清除上一轮错误态（发送消息 = 用户已看到错误并重试）
      ...(v ? { errorBySession: { ...state.errorBySession, [sessionId]: false } } : {}),
    })),
  setTaskError: (sessionId, v) =>
    set((state) => ({
      errorBySession: { ...state.errorBySession, [sessionId]: v },
    })),
  finalizeStreamingMessages: (sessionId) =>
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: (state.messagesBySession[sessionId] ?? []).map((m) => {
          // 已 finalize（streaming=false）但 thinkingStreaming 被 rAF 迟到写入复活的消息也需清理
          if (!m.streaming && !m.thinkingStreaming) return m;
          const finalizedToolCalls = m.toolCalls?.map((tc) =>
            tc.status === 'done' ? tc : { ...tc, status: 'done' as const },
          );
          return {
            ...m,
            streaming: false,
            thinkingStreaming: false,
            toolCalls: finalizedToolCalls,
            ...stampThinkingTiming(m, false),
          };
        }),
      },
    })),

  // --- Actions: 输入 / 工作目录 ---
  setInput: (input) => set({ input }),
  setWorkingDirectory: (workingDirectory) => {
    void idbSet('moss-working-directory', workingDirectory);
    set({ workingDirectory });
  },
  addRecentDirectory: (dir) =>
    set((state) => {
      const trimmed = dir.trim();
      if (!trimmed) return state;
      const rest = state.recentDirectories.filter((d) => d !== trimmed);
      const next = [trimmed, ...rest].slice(0, 5);
      // 仅保留仍在列表中的别名（容量上限淘汰的条目一并清理）
      const aliases = pruneAliases(state.recentDirectoryAliases, next);
      void idbSet('moss-recent-directories', next);
      if (aliases !== state.recentDirectoryAliases) void idbSet('moss-recent-dir-aliases', aliases);
      return { recentDirectories: next, recentDirectoryAliases: aliases };
    }),
  removeRecentDirectory: (dir) =>
    set((state) => {
      const next = state.recentDirectories.filter((d) => d !== dir);
      const aliases = pruneAliases(state.recentDirectoryAliases, next);
      void idbSet('moss-recent-directories', next);
      void idbSet('moss-recent-dir-aliases', aliases);
      return { recentDirectories: next, recentDirectoryAliases: aliases };
    }),
  renameRecentDirectory: (dir, alias) =>
    set((state) => {
      const trimmed = alias.trim();
      const aliases = { ...state.recentDirectoryAliases };
      if (trimmed) aliases[dir] = trimmed;
      else delete aliases[dir];
      void idbSet('moss-recent-dir-aliases', aliases);
      return { recentDirectoryAliases: aliases };
    }),
  updateRecentDirectoryPath: (oldPath, newPath) =>
    set((state) => {
      const trimmed = newPath.trim();
      if (!trimmed || oldPath === trimmed) return state;
      // 替换路径：先去重（改成一个已存在的路径时避免出现重复项），再原地替换
      const next = state.recentDirectories
        .filter((d) => d !== trimmed)
        .map((d) => (d === oldPath ? trimmed : d));
      const aliases = { ...state.recentDirectoryAliases };
      const oldAlias = aliases[oldPath];
      delete aliases[oldPath];
      if (oldAlias) aliases[trimmed] = oldAlias;
      void idbSet('moss-recent-directories', next);
      void idbSet('moss-recent-dir-aliases', aliases);
      return { recentDirectories: next, recentDirectoryAliases: aliases };
    }),

  // --- Actions: 服务商 ---
  setProviders: (providers) => set({ providers }),
  setCurrentModel: (currentModel) => set({ currentModel }),

  // --- Actions: Agent ---
  setAgents: (agents) => set({ agents }),
  setCurrentAgent: (currentAgent) => set({ currentAgent }),

  // --- Actions: 任务 + 分组 ---
  setTasks: (tasks) =>
    set((state) => {
      // 列表载荷自带后端权威运行态（running）。此处只「置位」不「清除」：
      // 列表请求可能在「本地已发送、后端尚未注册 run」的窗口内到达，
      // 若允许降位会瞬间熄灭刚点亮的转圈。清除由状态快照 / 完成事件（权威源）负责。
      let generating = state.generatingBySession;
      let changed = false;
      for (const tk of tasks) {
        if (tk.running !== true) continue;
        const sid = tk.sessionId ?? tk.id;
        if (!generating[sid]) {
          if (!changed) {
            generating = { ...generating };
            changed = true;
          }
          generating[sid] = true;
        }
      }
      return { tasks, ...(changed ? { generatingBySession: generating } : {}) };
    }),
  setTaskGroups: (taskGroups) => set({ taskGroups }),
  addTask: (task) => set((state) => ({ tasks: [task, ...state.tasks] })),
  // 活跃置顶（乐观更新）：移到该分组第一个任务之前（tasks 为跨分组扁平数组，Sidebar 按组保序渲染）
  touchTask: (id) =>
    set((state) => {
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return state;
      const rest = state.tasks.filter((t) => t.id !== id);
      const firstInGroup = rest.findIndex((t) => t.groupId === task.groupId);
      const insertIdx = firstInGroup === -1 ? rest.length : firstInGroup;
      const next = [...rest];
      next.splice(insertIdx, 0, { ...task, updatedAt: new Date().toISOString() });
      return { tasks: next };
    }),
  updateTask: (id, patch) =>
    set((state) => {
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return {};
      const merged = { ...task, ...patch };
      const rest = state.tasks.filter((t) => t.id !== id);
      // 该任务所在组按 order 局部重排（与后端 listTasks 排序一致）：
      // 跨组移动（后端 order 置顶）后"移入顶部"即时可见，不必等重新拉取列表
      const groupTasks = rest
        .filter((t) => t.groupId === merged.groupId)
        .concat(merged)
        .sort((a, b) => {
          const oa = a.order ?? Number.MAX_SAFE_INTEGER;
          const ob = b.order ?? Number.MAX_SAFE_INTEGER;
          if (oa !== ob) return oa - ob;
          return b.createdAt.localeCompare(a.createdAt);
        });
      const others = rest.filter((t) => t.groupId !== merged.groupId);
      return { tasks: [...others, ...groupTasks] };
    }),
  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      activeTaskId: state.activeTaskId === id ? null : state.activeTaskId,
    })),
  setActiveTaskId: (activeTaskId) => set({ activeTaskId }),
  addTaskGroup: (group) => set((state) => ({ taskGroups: [...state.taskGroups, group] })),
  updateTaskGroup: (id, patch) =>
    set((state) => ({
      taskGroups: state.taskGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })),
  removeTaskGroup: (id) =>
    set((state) => {
      const { [id]: _omitMeta, ...restMeta } = state.groupTasksMeta;
      return {
        taskGroups: state.taskGroups.filter((g) => g.id !== id),
        // 顺带清理该分组的加载态与已物化任务；迁往默认分组的任务由 WS tasks.changed / 兜底 reload 重新物化
        tasks: state.tasks.filter((t) => t.groupId !== id),
        groupTasksMeta: restMeta,
      };
    }),
  // 展开/收起持久化：缺省视为展开（undefined → true），同值不重复写盘
  setTaskGroupExpanded: (groupId, expanded) =>
    set((state) => {
      if ((state.taskGroupExpanded[groupId] ?? true) === expanded) return {};
      const taskGroupExpanded = { ...state.taskGroupExpanded, [groupId]: expanded };
      void idbSet('moss-task-group-expanded', taskGroupExpanded);
      return { taskGroupExpanded };
    }),
  // --- 分组任务按需加载 / 组内分页 ---
  patchGroupTasksMeta: (groupId, patch) =>
    set((state) => ({
      groupTasksMeta: {
        ...state.groupTasksMeta,
        [groupId]: {
          ...(state.groupTasksMeta[groupId] ?? { loaded: false, loading: false, hasMore: false, total: 0 }),
          ...patch,
        },
      },
    })),
  setGroupTasks: (groupId, tasks, meta, mode) =>
    set((state) => {
      const others = state.tasks.filter((t) => t.groupId !== groupId);
      const existing = state.tasks.filter((t) => t.groupId === groupId);
      let slice: TaskItem[];
      if (mode === 'append') {
        // 续载：按 id 去重后追加（与 WS 广播交错时安全）
        const seen = new Set(existing.map((t) => t.id));
        slice = [...existing, ...tasks.filter((t) => !seen.has(t.id))];
      } else {
        // 首屏：以服务端本组页为准覆盖该组切片（乐观任务的短暂缺失由 task.created 广播 / updateTask 校正）
        slice = tasks;
      }
      return {
        tasks: [...others, ...slice],
        groupTasksMeta: {
          ...state.groupTasksMeta,
          [groupId]: {
            ...(state.groupTasksMeta[groupId] ?? { loaded: false, loading: false, hasMore: false, total: 0 }),
            ...meta,
          },
        },
      };
    }),
  resetGroupTasks: () => set({ tasks: [], groupTasksMeta: {} }),
  applyFullTaskSnapshot: (tasks) =>
    set((state) => {
      // 与 setTasks 同源的「运行态置位」：只置位不清除（清除由状态快照 / 完成事件负责）
      let generating = state.generatingBySession;
      let changed = false;
      for (const tk of tasks) {
        if (tk.running !== true) continue;
        const sid = tk.sessionId ?? tk.id;
        if (!generating[sid]) {
          if (!changed) {
            generating = { ...generating };
            changed = true;
          }
          generating[sid] = true;
        }
      }
      // 全量快照：所有分组均为「已完整加载」（折叠分组由 Radix 卸载内容，不占 DOM）
      const groupTasksMeta: Record<string, GroupTasksMeta | undefined> = { ...state.groupTasksMeta };
      for (const g of state.taskGroups) {
        groupTasksMeta[g.id] = {
          loaded: true,
          loading: false,
          hasMore: false,
          total: tasks.filter((t) => t.groupId === g.id).length,
        };
      }
      return { tasks, groupTasksMeta, ...(changed ? { generatingBySession: generating } : {}) };
    }),

  // --- Actions: Todo / Context ---
  setTodos: (sessionId, todos) =>
    set((state) => ({
      todosBySession: { ...state.todosBySession, [sessionId]: todos },
    })),
  setContext: (sessionId, ctx) =>
    set((state) => ({
      contextBySession: { ...state.contextBySession, [sessionId]: ctx },
    })),
  setContextStats: (sessionId, stats) =>
    set((state) => ({
      contextStatsBySession: { ...state.contextStatsBySession, [sessionId]: stats },
    })),
  bumpContextFileReadSeq: (sessionId) =>
    set((state) => ({
      contextFileReadSeqBySession: {
        ...state.contextFileReadSeqBySession,
        [sessionId]: (state.contextFileReadSeqBySession[sessionId] ?? 0) + 1,
      },
    })),

  // --- Actions: 自动化 ---
  setAutomations: (automations) => set({ automations }),
  addAutomation: (a) => set((state) => ({ automations: [...state.automations, a] })),
  updateAutomation: (id, patch) =>
    set((state) => ({
      automations: state.automations.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),
  removeAutomation: (id) =>
    set((state) => ({ automations: state.automations.filter((a) => a.id !== id) })),
  setAutomationHistory: (id, history) =>
    set((state) => ({
      automationHistory: { ...state.automationHistory, [id]: history },
    })),
  addAutomationRun: (id, run) =>
    set((state) => {
      const list = state.automationHistory[id] ?? [];
      // 幂等：WS 重放 / 多入口 / load 竞态下同 runId 只保留一条
      if (list.some((r) => r.id === run.id)) return state;
      return {
        automationHistory: {
          ...state.automationHistory,
          [id]: [run, ...list],
        },
      };
    }),
  updateAutomationRun: (id, runId, patch) =>
    set((state) => ({
      automationHistory: {
        ...state.automationHistory,
        [id]: (state.automationHistory[id] ?? []).map((r) =>
          r.id === runId ? { ...r, ...patch } : r,
        ),
      },
    })),
  openAutomationForm: (editingId) =>
    set((state) => ({
      automationFormOpen: true,
      automationFormEditingId: editingId ?? null,
      automationFormSeq: state.automationFormSeq + 1,
    })),
  closeAutomationForm: () => set({ automationFormOpen: false, automationFormEditingId: null }),

  // --- Actions: Skills / Commands ---
  setSkills: (skills) => set({ skills }),
  setCommands: (commands) => set({ commands }),

  // --- Actions: 工具 ---
  setTools: (tools) => set({ tools }),
  updateTool: (name, patch) =>
    set((state) => ({
      tools: state.tools.map((t) => (t.name === name ? { ...t, ...patch } : t)),
    })),

  // --- Actions: 配置 ---
  setAppConfig: (appConfig) => set({ appConfig }),
  setApiConfig: (apiConfig) => set({ apiConfig }),

  // --- Actions: MCP ---
  setMcpServers: (mcpServers) => set({ mcpServers }),
  setMcpTools: (mcpTools) => set({ mcpTools }),

  // --- Actions: 运行统计 ---
  setRunStats: (sessionId, stats) =>
    set((state) => ({
      runStatsBySession: { ...state.runStatsBySession, [sessionId]: stats },
    })),

  // --- Actions: 专家团/Subagent 成员事件计数 ---
  bumpAgenteamEvent: (taskId, teamId, memberName) =>
    set((state) => {
      const prev = state.agenteamEvents[taskId];
      const next: Record<string, AgenteamEventEntry> = {
        ...state.agenteamEvents,
        [taskId]: {
          teamId,
          memberName,
          count: (prev?.count ?? 0) + 1,
          lastAt: Date.now(),
        },
      };
      // 上限 100 条：按 lastAt 淘汰最旧（防长会话运行内存无界增长）
      const keys = Object.keys(next);
      if (keys.length > 100) {
        keys
          .sort((a, b) => (next[a]?.lastAt ?? 0) - (next[b]?.lastAt ?? 0))
          .slice(0, keys.length - 100)
          .forEach((k) => delete next[k]);
      }
      return { agenteamEvents: next };
    }),

  // --- Actions: 中控岛 ---
  setHubActiveModule: (sessionId, moduleId) =>
    set((state) => ({
      hubActiveModuleBySession: { ...state.hubActiveModuleBySession, [sessionId]: moduleId },
    })),

  // --- Actions: 工具图标映射 ---
  setToolIconMap: (toolIconMap) => set({ toolIconMap }),

  // --- Actions: PendingAsk ---
  addPendingAsk: (ask) =>
    set((state) => ({
      pendingAsks: [
        ...state.pendingAsks.filter(
          (a) => !(a.sessionId === ask.sessionId && a.toolCallId === ask.toolCallId),
        ),
        ask,
      ],
    })),
  removePendingAsk: (sessionId, toolCallId) =>
    set((state) => ({
      pendingAsks: state.pendingAsks.filter(
        (a) => !(a.sessionId === sessionId && a.toolCallId === toolCallId),
      ),
    })),
  clearPendingAsks: () => set({ pendingAsks: [] }),
  clearPendingAsksBySession: (sessionId) =>
    set((state) => ({
      pendingAsks: state.pendingAsks.filter((a) => a.sessionId !== sessionId),
    })),

  // --- Actions: 消息撤回备份 ---
  setTruncateBackup: (sessionId, backup) =>
    set((state) => ({
      truncateBackups: { ...state.truncateBackups, [sessionId]: backup },
    })),

  // --- Actions: PendingConfirm ---
  addPendingConfirm: (confirm) =>
    set((state) => ({
      pendingConfirms: [
        ...state.pendingConfirms.filter(
          (c) => !(c.sessionId === confirm.sessionId && c.toolCallId === confirm.toolCallId),
        ),
        confirm,
      ],
    })),
  removePendingConfirm: (sessionId, toolCallId) =>
    set((state) => ({
      pendingConfirms: state.pendingConfirms.filter(
        (c) => !(c.sessionId === sessionId && c.toolCallId === toolCallId),
      ),
    })),
  clearPendingConfirmsBySession: (sessionId) =>
    set((state) => ({
      pendingConfirms: state.pendingConfirms.filter((c) => c.sessionId !== sessionId),
    })),

  // --- Actions: WS ---
  setWsStatus: (wsStatus) => set({ wsStatus }),
  setWsConnection: ({ status, attempt, nextRetryAt }) =>
    set({ wsStatus: status, wsReconnectAttempt: attempt, wsNextRetryAt: nextRetryAt }),
  bumpWsRestored: () => set((state) => ({ wsRestoredSeq: state.wsRestoredSeq + 1 })),
  setWsRestoring: (sessionId, v) =>
    set((state) => ({
      wsRestoringBySession: { ...state.wsRestoringBySession, [sessionId]: v },
    })),
  setSyncing: (sessionId, v) =>
    set((state) => ({
      syncingBySession: { ...state.syncingBySession, [sessionId]: v },
    })),

  // --- Actions: 发送快捷键 ---
  setSendShortcut: (sendShortcut) => {
    const normalized = normalizeShortcut(sendShortcut);
    void idbSet('moss-send-shortcut', normalized);
    set({ sendShortcut: normalized });
  },

  // --- Actions: 跟进行为 ---
  setFollowUpBehavior: (followUpBehavior) => {
    void idbSet('moss-follow-up-behavior', followUpBehavior);
    set({ followUpBehavior });
  },
  addToMessageQueue: (sessionId, message) =>
    set((state) => {
      const prev = state.messageQueueBySession[sessionId] ?? [];
      const existing = prev[0];
      // 合并语义：每会话至多一条。多条排队消息用「换行 + 分隔符」拼接到同一条，
      // 附件去重合并，时间戳刷新为最新（后续按时间排序/展示都以最新为准）。
      const merged: QueuedMessage = existing
        ? {
            id: existing.id,
            content: `${existing.content}${QUEUE_MERGE_SEPARATOR}${message.content}`,
            timestamp: message.timestamp,
            ...mergeAttachments(existing.attachments, message.attachments),
          }
        : message;
      const messageQueueBySession = { ...state.messageQueueBySession, [sessionId]: [merged] };
      // 队列是客户端行为（何时续发由本端决定），持久化到 IndexedDB 保证刷新后不丢
      void idbSet('moss-message-queues', messageQueueBySession);
      return { messageQueueBySession };
    }),
  takeFromMessageQueue: (sessionId, messageId) => {
    // 需要返回被移除的项（供「编辑」回填），故用 get() 读取当前队列再 set
    const state = get();
    const queue = state.messageQueueBySession[sessionId] ?? [];
    const item = queue.find((m) => m.id === messageId) ?? null;
    if (!item) return null;
    const messageQueueBySession = {
      ...state.messageQueueBySession,
      [sessionId]: queue.filter((m) => m.id !== messageId),
    };
    void idbSet('moss-message-queues', messageQueueBySession);
    set({ messageQueueBySession });
    return item;
  },
  removeFromMessageQueue: (sessionId, messageId) =>
    set((state) => {
      const queue = state.messageQueueBySession[sessionId] ?? [];
      const messageQueueBySession = {
        ...state.messageQueueBySession,
        [sessionId]: queue.filter((m) => m.id !== messageId),
      };
      void idbSet('moss-message-queues', messageQueueBySession);
      return { messageQueueBySession };
    }),
  clearMessageQueue: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.messageQueueBySession;
      void idbSet('moss-message-queues', rest);
      return { messageQueueBySession: rest };
    }),
  injectComposer: (text, attachments) =>
    set((state) => ({
      composerInjection: {
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        // seq 自增：同文本二次回填也能触发 TaskInput 的一次消费
        seq: (state.composerInjection?.seq ?? 0) + 1,
      },
    })),
  clearComposerInjection: () => set({ composerInjection: null }),

  // --- Actions: 外观设置 ---
  setAccentColor: (accentColor) => {
    void idbSet('moss-accent-color', accentColor);
    set({ accentColor });
  },
  setFontSize: (fontSize) => {
    void idbSet('moss-font-size', fontSize);
    set({ fontSize });
  },
  setUiDensity: (uiDensity) => {
    void idbSet('moss-ui-density', uiDensity);
    set({ uiDensity });
  },
  setCornerRadius: (cornerRadius) => {
    void idbSet('moss-corner-radius', cornerRadius);
    set({ cornerRadius });
  },
  setRightPanelRatio: (ratio, manual = false) => {
    const clamped = clampRightPanelRatio(ratio);
    void idbSet('moss-right-panel-ratio', clamped);
    // manual=true（拖拽）→ 标记「自定义」；false（选择预设）→ 复位
    void idbSet('moss-right-panel-custom', manual);
    set({ rightPanelRatio: clamped, rightPanelCustom: manual });
  },

  // --- Actions: 执行权限模式 ---
  setPermissionMode: (permissionMode, sessionId) => {
    if (sessionId) {
      // 会话级覆盖：不写 IndexedDB（后端 session 持久化，刷新经 GET /api/tasks/:id 恢复）
      set((state) => ({ permissionModeBySession: { ...state.permissionModeBySession, [sessionId]: permissionMode } }));
      return;
    }
    // 全局默认：持久化 IndexedDB
    void idbSet('moss-permission-mode', permissionMode);
    set({ permissionMode });
  },

  // --- Actions: 渲染设置（render 模块） ---
  setRenderSetting: (key, value) => {
    set((state) => {
      const renderSettings = { ...state.renderSettings, [key]: value };
      void idbSet('moss-render-settings', renderSettings);
      return { renderSettings };
    });
  },

  setAnimationSetting: (key, value) => {
    set((state) => {
      const animationSettings = { ...state.animationSettings, [key]: value };
      void idbSet('moss-animation-settings', animationSettings);
      return { animationSettings };
    });
  },

  setPrefersReducedMotion: (v) => set({ prefersReducedMotion: v }),

  // --- Actions: 服务商添加弹窗信号 ---
  requestProviderDialog: () => set({ providerDialogRequest: true }),
  clearProviderDialogRequest: () => set({ providerDialogRequest: false }),
  toggleProviderSearch: () =>
    set((state) => ({ providerSearchSeq: state.providerSearchSeq + 1 })),

  // --- Actions: 插件库 MCP tab header 按钮信号 ---
  requestMcpDialog: () => set({ mcpDialogRequest: true }),
  clearMcpDialogRequest: () => set({ mcpDialogRequest: false }),
  requestMcpRefresh: () => set((state) => ({ mcpRefreshSeq: state.mcpRefreshSeq + 1 })),
  requestSkillsDialog: () => set({ skillsDialogRequest: true }),
  clearSkillsDialogRequest: () => set({ skillsDialogRequest: false }),
  requestSkillsRefresh: () => set((state) => ({ skillsRefreshSeq: state.skillsRefreshSeq + 1 })),

  // --- Actions: 右侧边栏标签页 ---
  addSidebarTab: (sessionId, type, title, toolCallId) => {
    const id = newTabId();
    const tab: SidebarTab = { id, type, title, toolCallId, createdAt: Date.now() };
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      const map = {
        ...state.sidebarTabsBySession,
        [sessionId]: { tabs: [...cur.tabs, tab], activeId: id },
      };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    });
    return id;
  },

  openFileTab: (sessionId, path) => {
    // 同一路径已打开 → 聚焦已有标签，不重复建页（仅限当前会话）
    const existing = (get().sidebarTabsBySession[sessionId] ?? defaultSessionTabs()).tabs.find(
      (t) => t.type === 'file' && t.filePath === path,
    );
    if (existing) {
      set((state) => {
        const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
        const map = {
          ...state.sidebarTabsBySession,
          [sessionId]: { tabs: cur.tabs, activeId: existing.id },
        };
        persistSidebarTabs(map);
        return { sidebarTabsBySession: map };
      });
      return existing.id;
    }
    const id = newTabId();
    const tab: SidebarTab = {
      id,
      type: 'file',
      title: fileNameOf(path),
      filePath: path,
      createdAt: Date.now(),
    };
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      const map = {
        ...state.sidebarTabsBySession,
        [sessionId]: { tabs: [...cur.tabs, tab], activeId: id },
      };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    });
    return id;
  },

  openArchiveEntryTab: (sessionId, entry) => {
    // 同一 archivePath+innerPath 已打开 → 聚焦已有标签
    const existing = (get().sidebarTabsBySession[sessionId] ?? defaultSessionTabs()).tabs.find(
      (t) =>
        t.type === 'file' &&
        t.archiveEntry?.archivePath === entry.archivePath &&
        t.archiveEntry?.innerPath === entry.innerPath,
    );
    if (existing) {
      set((state) => {
        const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
        const map = {
          ...state.sidebarTabsBySession,
          [sessionId]: { tabs: cur.tabs, activeId: existing.id },
        };
        persistSidebarTabs(map);
        return { sidebarTabsBySession: map };
      });
      return existing.id;
    }
    const id = newTabId();
    const tab: SidebarTab = {
      id,
      type: 'file',
      title: entry.name,
      archiveEntry: entry,
      createdAt: Date.now(),
    };
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      const map = {
        ...state.sidebarTabsBySession,
        [sessionId]: { tabs: [...cur.tabs, tab], activeId: id },
      };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    });
    return id;
  },

  removeSidebarTab: (sessionId, id) =>
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      let tabs = cur.tabs.filter((t) => t.id !== id);
      let activeId = cur.activeId;
      // 删空则重建默认「开始」标签
      if (tabs.length === 0) {
        const def = defaultSessionTabs();
        tabs = def.tabs;
        activeId = def.activeId;
      } else if (activeId === id) {
        // 删的是活跃标签 → 切到最后一个
        activeId = tabs[tabs.length - 1].id;
      }
      const map = { ...state.sidebarTabsBySession, [sessionId]: { tabs, activeId } };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    }),

  setActiveSidebarTab: (sessionId, id) =>
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      const map = {
        ...state.sidebarTabsBySession,
        [sessionId]: { tabs: cur.tabs, activeId: id },
      };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    }),

  renameSidebarTab: (sessionId, id, title) =>
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      const tabs = cur.tabs.map((t) => (t.id === id ? { ...t, title } : t));
      const map = {
        ...state.sidebarTabsBySession,
        [sessionId]: { tabs, activeId: cur.activeId },
      };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    }),

  convertSidebarTab: (sessionId, id, type, title) =>
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      const tabs = cur.tabs.map((t) =>
        // 显式重建对象：保留 id/createdAt，清除可能残留的 filePath/toolCallId
        t.id === id ? { id: t.id, type, title, createdAt: t.createdAt } : t,
      );
      const map = { ...state.sidebarTabsBySession, [sessionId]: { tabs, activeId: id } };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    }),

  // 聚焦终端标签（AI 新建终端自动展示）：已有终端标签→激活；有「开始」→原地转换；否则新增；并展开右侧面板
  focusTerminalTab: (sessionId) =>
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      const existing = cur.tabs.find((t) => t.type === 'terminal');
      let tabs = cur.tabs;
      let activeId: string;
      if (existing) {
        activeId = existing.id;
      } else {
        const startTab = cur.tabs.find((t) => t.type === 'start');
        if (startTab) {
          activeId = startTab.id;
          tabs = cur.tabs.map((t) =>
            t.id === startTab.id ? { id: t.id, type: 'terminal' as const, title: 'terminal.title', createdAt: t.createdAt } : t,
          );
        } else {
          activeId = newTabId();
          tabs = [...cur.tabs, { id: activeId, type: 'terminal' as const, title: 'terminal.title', createdAt: Date.now() }];
        }
      }
      const map = { ...state.sidebarTabsBySession, [sessionId]: { tabs, activeId } };
      persistSidebarTabs(map);
      return {
        sidebarTabsBySession: map,
        rightPanelOpenBySession: { ...state.rightPanelOpenBySession, [sessionId]: true },
      };
    }),

  reorderSidebarTabs: (sessionId, fromId, toId) =>
    set((state) => {
      const cur = state.sidebarTabsBySession[sessionId] ?? defaultSessionTabs();
      const from = cur.tabs.findIndex((t) => t.id === fromId);
      const to = cur.tabs.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return state;
      const tabs = [...cur.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      const map = {
        ...state.sidebarTabsBySession,
        [sessionId]: { tabs, activeId: cur.activeId },
      };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    }),

  resetSidebarTabs: (sessionId) =>
    set((state) => {
      const map = { ...state.sidebarTabsBySession, [sessionId]: defaultSessionTabs() };
      persistSidebarTabs(map);
      return { sidebarTabsBySession: map };
    }),

  // --- Actions: 持久终端元数据（内存态） ---
  setTerminalList: (sessionId, terminals) =>
    set((state) => {
      const cur = state.terminalsBySession[sessionId];
      // 活跃项缺失时优先选「在线」终端（离线项为后端重启后的只读历史，不应作为默认激活项）
      const fallback = terminals.find((t) => !t.offline) ?? terminals[0];
      const activeId =
        cur?.activeId && terminals.some((t) => t.id === cur.activeId)
          ? cur.activeId
          : fallback?.id;
      return {
        terminalsBySession: { ...state.terminalsBySession, [sessionId]: { list: terminals, activeId } },
      };
    }),
  addTerminal: (terminal) =>
    set((state) => {
      const cur = state.terminalsBySession[terminal.sessionId];
      const list = cur?.list ?? [];
      const exists = list.some((t) => t.id === terminal.id);
      const next = exists
        ? list.map((t) => (t.id === terminal.id ? terminal : t))
        : [...list, terminal];
      return {
        terminalsBySession: {
          ...state.terminalsBySession,
          // 新建的终端自动激活（对齐 VS Code）；已存在的仅更新信息，不抢焦点
          [terminal.sessionId]: { list: next, activeId: exists ? cur?.activeId : terminal.id },
        },
      };
    }),
  removeTerminal: (terminalId) =>
    set((state) => {
      let changed = false;
      const map = { ...state.terminalsBySession };
      for (const [sid, entry] of Object.entries(map)) {
        if (!entry) continue;
        const list = entry.list.filter((t) => t.id !== terminalId);
        if (list.length !== entry.list.length) {
          changed = true;
          const activeId =
            entry.activeId === terminalId ? list[0]?.id : entry.activeId;
          map[sid] = { list, activeId };
        }
      }
      return changed ? { terminalsBySession: map } : {};
    }),
  updateTerminal: (terminalId, patch) =>
    set((state) => {
      let changed = false;
      const map = { ...state.terminalsBySession };
      for (const [sid, entry] of Object.entries(map)) {
        if (!entry) continue;
        const idx = entry.list.findIndex((t) => t.id === terminalId);
        if (idx >= 0) {
          changed = true;
          const list = [...entry.list];
          list[idx] = { ...list[idx], ...patch };
          map[sid] = { ...entry, list };
        }
      }
      return changed ? { terminalsBySession: map } : {};
    }),
  setActiveTerminal: (sessionId, terminalId) =>
    set((state) => {
      const cur = state.terminalsBySession[sessionId] ?? { list: [] };
      return {
        terminalsBySession: { ...state.terminalsBySession, [sessionId]: { ...cur, activeId: terminalId } },
      };
    }),
  setTerminalPtyBackend: (info) => set({ terminalPtyBackend: info }),

  // --- Actions: 右侧面板展开态/宽度（内存态，不持久化） ---
  setRightPanelOpen: (sessionId, v) =>
    set((state) => ({
      rightPanelOpenBySession: { ...state.rightPanelOpenBySession, [sessionId]: v },
    })),
  showFilePreviewDialog: (path) => set({ filePreviewDialogPath: path }),
  hideFilePreviewDialog: () => set({ filePreviewDialogPath: null }),
  migrateRightPanelState: (fromSessionId, toSessionId) =>
    set((state) => {
      if (fromSessionId === toSessionId) return state;
      const fromOpen = state.rightPanelOpenBySession[fromSessionId] ?? false;
      const { [fromSessionId]: _omit, ...rest } = state.rightPanelOpenBySession;
      // 标签状态随对话转移（'' 空白页 → 新会话）
      const fromTabs = state.sidebarTabsBySession[fromSessionId];
      const { [fromSessionId]: _omitTabs, ...restTabs } = state.sidebarTabsBySession;
      const nextTabs = fromTabs ? { ...restTabs, [toSessionId]: fromTabs } : restTabs;
      persistSidebarTabs(nextTabs);
      return {
        rightPanelOpenBySession: { ...rest, [toSessionId]: fromOpen },
        sidebarTabsBySession: nextTabs,
      };
    }),

  // --- Actions: 持久化状态注入 ---
  hydratePersisted: (patch) =>
    set((state) => {
      const next: Partial<UIState> = {};
      if (typeof patch.workingDirectory === 'string' && patch.workingDirectory.length > 0) {
        next.workingDirectory = patch.workingDirectory;
      }
      if (Array.isArray(patch.recentDirectories)) {
        const dirs = patch.recentDirectories.filter(
          (d): d is string => typeof d === 'string',
        ).slice(0, 5);
        next.recentDirectories = dirs;
        // 别名：仅保留仍在最近列表中的键（键为路径）
        if (patch.recentDirectoryAliases && typeof patch.recentDirectoryAliases === 'object') {
          const keep = new Set(dirs);
          const aliases: Record<string, string> = {};
          for (const [k, v] of Object.entries(patch.recentDirectoryAliases)) {
            if (keep.has(k) && typeof v === 'string' && v.trim()) aliases[k] = v;
          }
          next.recentDirectoryAliases = aliases;
        }
      }
      if (typeof patch.sendShortcut === 'string' && patch.sendShortcut.length > 0) {
        next.sendShortcut = patch.sendShortcut;
      }
      if (patch.followUpBehavior === 'queue' || patch.followUpBehavior === 'guide') {
        next.followUpBehavior = patch.followUpBehavior;
      }
      if (typeof patch.accentColor === 'string' && patch.accentColor.length > 0) {
        next.accentColor = patch.accentColor;
      }
      if (patch.fontSize === 'small' || patch.fontSize === 'medium' || patch.fontSize === 'large') {
        next.fontSize = patch.fontSize;
      }
      if (patch.uiDensity === 'compact' || patch.uiDensity === 'standard' || patch.uiDensity === 'comfortable') {
        next.uiDensity = patch.uiDensity;
      }
      if (patch.cornerRadius === 'small' || patch.cornerRadius === 'standard' || patch.cornerRadius === 'large') {
        next.cornerRadius = patch.cornerRadius;
      }
      if (typeof patch.rightPanelRatio === 'number') {
        // 一律收敛到 [窄, 宽]：历史持久化值可能落在区间外（如早期开发态拖出的比例）
        next.rightPanelRatio = clampRightPanelRatio(patch.rightPanelRatio);
      }
      if (typeof patch.rightPanelCustom === 'boolean') {
        next.rightPanelCustom = patch.rightPanelCustom;
      }
      if (
        patch.permissionMode === 'ask' ||
        patch.permissionMode === 'auto' ||
        patch.permissionMode === 'skip'
      ) {
        next.permissionMode = patch.permissionMode;
      }
      // 右侧边栏标签页（会话级）：校验并注入按会话 map；无记录的会话运行时回退默认「开始」
      if (patch.sidebarTabsBySession && typeof patch.sidebarTabsBySession === 'object') {
        const clean: Record<string, SessionSidebarTabs> = {};
        for (const [k, v] of Object.entries(patch.sidebarTabsBySession)) {
          if (!k || !v || !Array.isArray(v.tabs) || v.tabs.length === 0) continue;
          const tabs = v.tabs as SidebarTab[];
          const activeId =
            typeof v.activeId === 'string' && tabs.some((t) => t.id === v.activeId)
              ? v.activeId
              : tabs[0].id;
          clean[k] = { tabs, activeId };
        }
        next.sidebarTabsBySession = clean;
      }
      if (isValidRenderSettings(patch.renderSettings)) {
        next.renderSettings = patch.renderSettings;
      }
      if (isValidAnimationSettings(patch.animationSettings)) {
        next.animationSettings = patch.animationSettings;
      }
      if (patch.messageQueues && typeof patch.messageQueues === 'object') {
        const queues: Record<string, QueuedMessage[]> = {};
        for (const [sid, list] of Object.entries(patch.messageQueues)) {
          if (!Array.isArray(list)) continue;
          const items = list.filter(
            (m): m is QueuedMessage =>
              !!m && typeof m.id === 'string' && typeof m.content === 'string',
          );
          // 合并语义：每会话至多一条（旧版多条目数据只保留首条，避免残留多条）
          if (items.length > 0) queues[sid] = [items[0]];
        }
        next.messageQueueBySession = queues;
      }
      // 任务分组展开/收起（groupId → expanded）：仅收布尔值，非法项丢弃
      if (patch.taskGroupExpanded && typeof patch.taskGroupExpanded === 'object') {
        const clean: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(patch.taskGroupExpanded)) {
          if (k && typeof v === 'boolean') clean[k] = v;
        }
        next.taskGroupExpanded = clean;
      }
      return next;
    }),
}));
