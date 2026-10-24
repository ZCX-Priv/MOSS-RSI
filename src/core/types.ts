// src/core/types.ts
// 微内核类型契约：所有内核服务的接口定义。
// 内核只定义契约，不包含业务逻辑。

// ============================================================================
// 日志服务
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  fatal(message: string, context?: Record<string, unknown>): void;
  /** 创建子日志器，自动附加前缀 */
  child(scope: string): Logger;
  /** 动态调整级别 */
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
}

/** 日志文件元信息 */
export interface LogFileInfo {
  name: string;
  /** 字节数 */
  size: number;
  /** 最后修改时间（毫秒时间戳） */
  mtime: number;
}

/** 日志查询选项（人类可读文本行按正则解析过滤） */
export interface LogQueryOptions {
  /** 指定日志文件名（如 moss-2026-08-18.log）；缺省 = 最新一个文件 */
  file?: string;
  /** 最低级别过滤（>=，如 warn 表示保留 warn/error/fatal） */
  minLevel?: LogLevel;
  /** 关键词子串过滤（大小写不敏感） */
  search?: string;
  /** 分页大小，默认 200，上限 1000 */
  limit?: number;
  /** 分页偏移（最新优先序） */
  offset?: number;
}

export interface LogQueryResult {
  /** 过滤+分页后的日志行（最新优先） */
  lines: string[];
  /** 过滤后总行数（分页前） */
  total: number;
}

/** 日志服务（由内核注册为 kernel.logger：文件枚举 / 查询 / 清理 / 级别调整） */
export interface LogService {
  getLogFiles(): LogFileInfo[];
  readLogs(opts: LogQueryOptions): LogQueryResult;
  /** 立即按保留策略清理过期日志，返回删除文件数 */
  cleanupNow(): number;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
}

// ============================================================================
// 环境检测
// ============================================================================

export type Platform = 'win32' | 'darwin' | 'linux' | 'android' | 'other';

export interface Environment {
  readonly platform: Platform;
  readonly arch: string;
  readonly isWindows: boolean;
  readonly isMac: boolean;
  readonly isLinux: boolean;
  /** Android（Termux/proot 等）：POSIX 特例，存储路径与卷枚举规则不同 */
  readonly isAndroid: boolean;
  /** 用户主目录 */
  readonly homeDir: string;
  /** MOSS 用户数据目录：~/.moss */
  readonly dataDir: string;
  /** MOSS 配置目录：~/.moss/config */
  readonly configDir: string;
  /** MOSS 日志目录：~/.moss/logs */
  readonly logsDir: string;
  /** PID 文件路径：~/.moss/moss.pid */
  readonly pidFile: string;
  /** 运行时 Bun 版本 */
  readonly runtimeVersion: string;
  /** 当前进程 PID */
  readonly pid: number;
  /** 包安装根目录 */
  readonly packageRoot: string;
}

// ============================================================================
// 事件总线（Hook 系统）
// ============================================================================

/**
 * Filter 模式 handler：接收数据，可修改并返回。
 * 用于请求/响应处理链（如 llm:request:before）。
 */
export type FilterHandler<T> = (data: T) => T | Promise<T>;

/**
 * Action 模式 handler：执行副作用，不返回数据。
 * 用于通知/日志（如 session:message）。
 */
export type ActionHandler = (data: unknown) => void | Promise<void>;

export interface EventBusSubscription {
  /** 注销此订阅 */
  unsubscribe(): void;
}

export interface EventBus {
  /**
   * 注册 Filter handler。emit 时按 priority 升序执行（priority 小的先执行）。
   * 同 priority 按 注册顺序。
   */
  on<T>(event: string, handler: FilterHandler<T>, priority?: number): EventBusSubscription;

  /**
   * 注册 Action handler。broadcast 时并行调用所有 handler。
   */
  onAction(event: string, handler: ActionHandler): EventBusSubscription;

  /**
   * 触发 Filter 事件：链式调用所有 handler，返回最终数据。
   * 任一 handler 抛错则中断链，错误向上抛。
   */
  emit<T>(event: string, data: T): Promise<T>;

  /**
   * 广播 Action 事件：并行调用所有 handler。
   * 单个 handler 抛错不影响其他 handler，仅记录日志。
   */
  broadcast(event: string, data: unknown): Promise<void>;

  /** 移除指定 handler */
  off(event: string, handler: Function): void;

  /** 注销某个 scope 注册的所有 handler（模块销毁时调用） */
  offAll(scope: string): void;

  /** 列出所有已注册事件名（调试用） */
  listEvents(): string[];
}

// ============================================================================
// 服务注册表
// ============================================================================

export interface ServiceRegistry {
  /** 注册服务。若已存在同名服务且未强制覆盖则抛错。 */
  register<T>(
    name: string,
    service: T,
    options?: {
      override?: boolean;
      scope?: string;
    },
  ): void;
  /** 解析服务，不存在则抛错 */
  resolve<T>(name: string): T;
  /** 尝试解析，不存在返回 null */
  tryResolve<T>(name: string): T | null;
  has(name: string): boolean;
  /** 注销服务（仅限注册 scope 自己） */
  unregister(name: string): void;
  /** 注销某个 scope 注册的所有服务 */
  unregisterScope(scope: string): void;
  /** 列出所有已注册服务名 */
  list(): string[];
}

// ============================================================================
// 配置服务
// ============================================================================

// type-only import：编译时擦除，无运行时循环依赖
// ToolsConfig 从 manifest 的 Zod schema 推导，保持类型与 schema 永远一致
import type { ToolsConfig } from '../modules/tools/manifest';
import type { FileHistoryConfig } from '../modules/file-history/types';
import type { FilesysConfig } from '../modules/filesys/types';
import type { SafetyConfig } from '../modules/safety/types';
import type { ContextEngineConfig } from '../modules/context/types';
import type { RemoteConfig } from '../modules/remote/types';

/** 应用配置（config.json）的结构 —— 由 config-service 中 Zod schema 严格校验 */
export interface AppConfig {
  version: number;
  server: {
    host: string;
    port: number;
    autoPort: boolean;
    locale?: string;
  };
  daemon: {
    enabled: boolean;
  };
  /** 日志系统配置（级别 / 保留天数 / 单文件大小上限），由 core/logger 消费 */
  logs: {
    level: LogLevel;
    retentionDays: number;
    maxFileMb: number;
  };
  update: {
    autoCheck: boolean;
    channel: 'stable' | 'beta';
    checkIntervalHours: number;
  };
  agent: {
    defaultModel: string;
    maxTokens: number;
    /** 单次 run 的最大轮数；0 = 不限制（无限轮） */
    maxTurns: number;
    /** SSE 流空闲超时（ms）：推理型模型长思考/长程任务需放宽；缺省用内置默认（15 分钟） */
    llmStreamIdleTimeoutMs?: number;
    workingDirectory: string;
  };
  // tools 类型从 manifest 自动推导（单一真相源），新增工具无需手动改此文件
  tools: ToolsConfig;
  mcpServers: Record<string, unknown>;
  /** MCP 客户端配置（调用超时 / sampling 授权） */
  mcp?: {
    /** 单次 MCP 工具调用超时（毫秒），默认 120000 */
    callTimeoutMs?: number;
    /** 是否允许 MCP 服务器借用本地 LLM（sampling），默认 true */
    allowSampling?: boolean;
  };
  /** 对外 MCP Server 暴露配置（/mcp 端点） */
  mcpServer?: {
    /** 是否启用对外暴露，默认 false */
    enabled: boolean;
    /** 暴露的工具白名单；空数组 = 全部内置工具（仅在 exposeInternalTools 开启时生效） */
    allowedTools: string[];
    /**
     * POST 响应体模式，默认 'sse'。
     * - 'sse'：Streamable HTTP 默认行为，响应为 text/event-stream；
     *   连接持续有 SDK 的 15s keep-alive 帧，长任务不会被 Bun 的 idleTimeout 掐断。
     * - 'json'：响应为 application/json（单次返回）。
     *   ⚠ 该模式下等待期间无任何字节下行，超过 Bun.serve idleTimeout（60s）的
     *   工具调用会被连接层直接断开，仅作兼容逃生舱。
     */
    responseMode?: 'json' | 'sse';
    /**
     * 是否额外暴露 MOSS 的内部工具（read/glob/grep/terminal/memory…），默认 false。
     * /mcp 的定位是「让别的 Agent 驱动 MOSS」（agent 级工具 moss_*），而不是把 MOSS
     * 降级成工具代理。开启后仍需 allowedTools 白名单，且 requireConfirmation /
     * destructiveHint / ask 类工具始终不会暴露。
     */
    exposeInternalTools?: boolean;
    /**
     * 任务轨迹摘要开关，默认 true。
     * 开启后 moss_task_status 会额外调用摘要模型，把当前轨迹（近若干步、过滤后的
     * 工具结果、todo）压缩成 2-4 句摘要返回；失败自动降级（仅少一个字段，不影响轮询）。
     */
    trackSummary?: boolean;
  };
  /** Skill 启停（name → { enabled }，缺省视为启用） */
  skills?: Record<string, { enabled?: boolean }>;
  /** 自定义斜杠命令启停（~/.moss/commands/<name>.md；name → { enabled }，缺省视为启用） */
  commands?: Record<string, { enabled?: boolean }>;
  security: {
    authToken: string;
    bindLocalhostOnly: boolean;
  };
  /** 文件历史服务配置（由 file-history 模块消费） */
  fileHistory?: FileHistoryConfig;
  /** 虚拟文件系统配置（由 filesys 模块消费：roots/缓存/终端快照检测） */
  filesys?: FilesysConfig;
  /** 统一权限决策配置（由 safety 模块消费：模式/规则/危险拦截/保护路径） */
  safety?: SafetyConfig;
  /** 上下文引擎配置（由 context 模块消费：压缩/修剪/自愈/遥测） */
  context?: ContextEngineConfig;
  /** 远程访问配置（由 remote 模块消费：局域网/公网隧道控制 webui；Zod schema 全 default 自愈） */
  remote: RemoteConfig;
  /** web 工具配置（联网搜索默认引擎；由 web 工具消费） */
  web?: {
    /** 默认搜索服务商 id；空串 = 本地免费引擎（bing/baidu/sogou 回退链） */
    searchProviderId: string;
  };
  /** 语音输入配置（由 voice 模块消费；Zod schema 全 default 自愈） */
  voice?: {
    /** 总开关（默认关闭；关闭时输入框麦克风按钮隐藏） */
    enabled: boolean;
    /** 语音服务商 id；空串 = 内置本地引擎（sherpa-onnx 承载三类模型） */
    providerId: string;
    /** 本地模型 id；空串 = 使用推荐默认模型 */
    localModel: string;
    /** 识别语言提示（'auto' | 'zh' | 'en' 等） */
    language: string;
  };
}

export type ApiConfig = {
  /** 配置结构版本：2 = providers 结构（1 = 旧扁平 models，加载时自动迁移） */
  version: number;
  providers: ProviderConfig[];
};

/** 服务商配置：持有 API 格式/地址/Key 及自定义查询地址，模型挂其下 */
export interface ProviderConfig {
  /** 内部唯一 id（如 "provider_1734..."） */
  id: string;
  /** 显示名，如 "OpenAI" */
  name: string;
  /**
   * 服务商类型：model=模型服务商（默认，缺省等同）、search=搜索服务商。
   * search 服务商 format 固定为 'search'，由 searchEngine 决定引擎，models 恒为空。
   */
  kind?: 'model' | 'search' | 'voice';
  format: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini' | 'search' | 'voice';
  /** 搜索引擎类型（kind='search' 时必填）：zhipu=智谱 search_pro、bocha=博查、tavily=Tavily */
  searchEngine?: 'zhipu' | 'bocha' | 'tavily';
  /**
   * 语音引擎类型（kind='voice' 时必填）：openai-transcriptions = OpenAI 兼容
   * /audio/transcriptions 整段转写接口。本地引擎不占用服务商条目（providerId 空串即本地）。
   */
  voiceEngine?: 'openai-transcriptions';
  /** 语音模型名（kind='voice' 时使用，如 'whisper-1'；本地引擎忽略此字段） */
  voiceModel?: string;
  endpoint: string;
  apiKey: string;
  /** 自定义余额查询地址（OpenAI 兼容 subscription 接口完整 URL；空 = 不提供余额查询） */
  balanceUrl?: string;
  /** 自定义模型列表获取地址（空 = 按 format 推断默认值） */
  modelsUrl?: string;
  /** 品牌图标 key（@lobehub/icons 的 provider key，如 'openai'；空 = 默认 Server 图标） */
  icon?: string;
  /** 附加服务（文件存储等） */
  services?: ProviderServiceConfig[];
  models: ProviderModelConfig[];
}

/**
 * 思考强度等级（等级库条目）。
 * 预设档 id 固定 'off'/'low'/'medium'/'high'；自定义档 level_{ts}_{rand}。
 */
export interface ThinkingLevelConfig {
  id: string;
  /** 显示名，如 "极致" / "关闭" */
  label: string;
  /** API 参数值：'off'/'low'/'medium'/'high'/自定义（如 'xhigh'） */
  effort: string;
}

/** 服务商附加服务（当前仅文件存储） */
export interface ProviderServiceConfig {
  /** 内部唯一 id（如 "service_1734..."） */
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

/** 服务商下的模型：名称 + 模型 id + 模型级高级配置 */
export interface ProviderModelConfig {
  /** 内部唯一 id（如 "model_1734..."）；从旧版迁移时保留原 id */
  id: string;
  /** 显示名，如 "GPT-4o" */
  name: string;
  /** 发送给 API 的模型名，如 "gpt-4o" */
  model: string;
  thinking: {
    enabled: boolean;
    /** 思考强度：预设档（low/medium/high 等）或自定义字符串 */
    effort?: string;
    /** 自定义等级显示名（预设档无此字段） */
    label?: string;
    budgetTokens?: number;
  };
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
  /**
   * 思考强度等级库（模型级，有序：位置越靠后档位越高）。
   * 预设初始库为 [off, low, medium, high]，全部可增删（至少保留 1 个）。
   * effort==='off' 的等级选中时表示关闭思考（thinking.enabled=false）。
   * undefined = 使用默认库（前端 fallback 渲染，不写盘）；一旦增删过即整体持久化。
   */
  thinkingLevels?: ThinkingLevelConfig[];
}

/**
 * 运行时"扁平视图"：provider 连接信息（format/endpoint/apiKey）与模型配置的合并结果，
 * 由 core/provider-utils 的 flattenModels() 生成，供 LLMRouter/context/agent 等运行时消费。
 */
export interface ModelConfig {
  /** 内部唯一 id（如 "model_1734..."） */
  id: string;
  /** 显示名，如 "GPT-4o" */
  name: string;
  /** 发送给 API 的模型名，如 "gpt-4o" */
  model: string;
  format: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
  endpoint: string;
  apiKey: string;
  thinking: {
    enabled: boolean;
    /** 思考强度：预设档（low/medium/high 等）或自定义字符串 */
    effort?: string;
    /** 自定义等级显示名（预设档无此字段） */
    label?: string;
    budgetTokens?: number;
  };
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
}

export interface ConfigService {
  /** 加载配置（首次运行自动从模板复制） */
  load(): Promise<void>;
  /** 配置加载失败时回退到默认配置（降级运行，仅内存） */
  loadDefaults(): void;
  /** 获取当前应用配置（只读视图） */
  getAppConfig(): AppConfig;
  /** 获取当前 API 配置（只读视图） */
  getApiConfig(): ApiConfig;
  /** 更新应用配置（持久化） */
  updateAppConfig(patch: Partial<AppConfig>): Promise<void>;
  /** 更新 API 配置（持久化） */
  updateApiConfig(patch: Partial<ApiConfig>): Promise<void>;
  /** 重新从磁盘加载 */
  reload(): Promise<void>;
  /** 监听配置变更 */
  onChange(handler: (which: 'app' | 'api') => void): EventBusSubscription;
}

// ============================================================================
// 模块系统
// ============================================================================
// 模块由内核静态 import 直接编排：按固定顺序初始化、反向销毁。

/** 模块上下文：完整能力 */
export interface ModuleContext {
  logger: Logger;
  config: ConfigService;
  eventBus: EventBus;
  services: ServiceRegistry;
  env: Environment;
}

/** 模块主接口 */
export interface Module {
  initialize(context: ModuleContext): Promise<void>;
  destroy?(): Promise<void>;
}

/** 内核导出的统一上下文（供 CLI / 外部代码使用） */
export interface KernelContext {
  logger: Logger;
  config: ConfigService;
  eventBus: EventBus;
  services: ServiceRegistry;
  env: Environment;
  kernel: {
    stop(): Promise<void>;
  };
}

// ============================================================================
// 内核标准事件名
// ============================================================================

export const KernelEvents = {
  Ready: 'kernel:ready',
  Shutdown: 'kernel:shutdown',
  ConfigChanged: 'config:changed',
} as const;

// ============================================================================
// 标准服务名（由各模块注册）
// ============================================================================

export const ServiceNames = {
  LLM_ROUTER: 'llm.router',
  TOOL_REGISTRY: 'tool.registry',
  MCP_MANAGER: 'mcp.manager',
  AGENT_ENGINE: 'agent.engine',
  SERVER_INSTANCE: 'server.instance',
  /** 配置服务（由内核注册：运行时读取 config.json / api.json，如 web 工具解析搜索服务商） */
  CONFIG_SERVICE: 'kernel.config',
  /** Skill 注册表（由 tools 模块注册） */
  SKILL_REGISTRY: 'skill.registry',
  /** Command 注册表（由 tools 模块注册：~/.moss/commands/*.md 自定义斜杠命令） */
  COMMAND_REGISTRY: 'command.registry',
  /** Agent 注册表（由 agenteam 模块注册） */
  AGENTEAM_REGISTRY: 'agenteam.registry',
  /** agenteam 编排服务（由 agenteam 模块注册：团队生命周期/DAG调度/质量门禁/临时subagent） */
  AGENTEAM_ORCHESTRATOR: 'agenteam.orchestrator',
  /** 自动化任务服务（由 automation 模块注册） */
  AUTOMATION_SERVICE: 'automation.service',
  /** 文件历史服务（由 file-history 模块注册：Track Edit + Snapshot + undo） */
  FILE_HISTORY: 'file.history',
  /** 虚拟文件系统服务（由 filesys 模块注册：统一文件 IO / 读缓存 / roots / 变更事件） */
  FILESYS: 'file.sys',
  /** 终端服务（由 terminal 模块注册：持久终端 PTY 会话管理 + 输出缓冲 + 状态） */
  TERMINAL: 'terminal.service',
  /** 安全服务（由 safety 模块注册：统一权限决策 + 会话规则 + 规则建议） */
  SAFETY: 'safety.service',
  /** 上下文引擎（由 context 模块注册：拼接/压缩/自愈/预算/治理/遥测） */
  CONTEXT_ENGINE: 'context.engine',
  /** 规则引擎（由 rules 模块注册：用户规则存储/加载/条件注入） */
  RULES_ENGINE: 'rules.engine',
  /** 钩子引擎（由 hooks 模块注册：生命周期事件钩子执行） */
  HOOKS_ENGINE: 'hooks.engine',
  /** 记忆引擎（由 memory 模块注册：记忆宫殿存储/检索/蒸馏） */
  MEMORY_ENGINE: 'memory.engine',
  /** 日志服务（由内核注册：日志文件枚举 / 查询 / 清理 / 级别调整） */
  LOGGER: 'kernel.logger',
  /** 远程访问服务（由 remote 模块注册：隧道生命周期/状态快照） */
  REMOTE_SERVICE: 'remote.service',
  /**
   * MCP 对外派发的任务注册表（由 mcp 模块注册）：
   * 外部 Agent 经 /mcp 或 `moss mcp` 派发的异步任务状态（进度/轨迹/结果）。
   */
  MCP_TASK_REGISTRY: 'mcp.task.registry',
  /** 语音识别服务（由 voice 模块注册：本地引擎 sherpa-onnx 承载 zipformer/SenseVoice/Whisper + 在线服务商） */
  VOICE_SERVICE: 'voice.service',
  /** 计算机操作服务（由 computer 模块注册：cua-driver 进程生命周期 / 工具调用 / 截图 / 活动记录） */
  COMPUTER: 'computer.service',
} as const;
