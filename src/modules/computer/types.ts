// src/modules/computer/types.ts
// Computer 模块契约：cua-driver 进程生命周期 / 工具调用 / 截图 / 活动记录。
// 由 computer 模块实现并注册到 ServiceNames.COMPUTER；computer 工具与 /api/computer/* 共用。

/** 连接状态 */
export type ComputerConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'installing';

/** 主显示器信息（cua get_screen_size 的结果；scale 可能缺失） */
export interface ComputerScreenInfo {
  width: number;
  height: number;
  scale: number | null;
}

/** 对外状态快照（面板 / 工具错误提示共用） */
export interface ComputerStatus {
  /** 是否找到 cua-driver 可执行文件 */
  installed: boolean;
  /** 解析到的驱动绝对路径 */
  driverPath: string | null;
  /** 驱动版本（读取失败为 null） */
  version: string | null;
  connection: ComputerConnectionState;
  /** cua 暴露的工具数量（未连接为 0） */
  toolCount: number;
  screen: ComputerScreenInfo | null;
  /** 用户是否暂停了 Agent 的 computer 控制 */
  paused: boolean;
  /** 当前工具配置中的截图上限与前台开关（面板展示 / 截图请求默认值） */
  config: {
    maxImageDimension: number;
    allowForeground: boolean;
  };
  /** 最近一次连接/安装错误 */
  error: string | null;
}

/** list_windows 的窗口记录（仅保留面板需要的字段） */
export interface ComputerWindowInfo {
  window_id: number;
  pid: number;
  app_name?: string;
  title?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  is_on_screen?: boolean;
  z_index?: number | null;
}

/** 面板动作时间线条目（内存环形缓冲，最多 50 条） */
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
  /** 本次调用耗时（毫秒） */
  durationMs?: number;
}

/** 一次截图产物（落盘路径 + 可选尺寸） */
export interface ComputerCapture {
  path: string;
  width?: number;
  height?: number;
}

/** cua 工具调用归一化结果 */
export interface ComputerToolResult {
  text: string;
  images: Array<{ data: string; mimeType: string; path: string }>;
  structured?: unknown;
  isError: boolean;
}

/** 调用选项（工具层提供 action/summary/target 供活动记录；面板 source=panel 跳过暂停检查） */
export interface ComputerCallOptions {
  /** cua 会话标签（默认 moss-<sessionId 哈希>；面板用 moss-panel） */
  sessionLabel?: string;
  /** MOSS 会话 id（活动记录与 WS 路由） */
  sessionId?: string;
  /** MOSS 工具动作名（活动记录） */
  action?: string;
  /** 动作摘要（不含输入文本等敏感内容） */
  summary?: string;
  /** 目标描述（窗口/桌面） */
  target?: string;
  /** 本次动作产生的截图路径（供时间线展示/定位） */
  screenshotPath?: string;
  source?: 'agent' | 'panel';
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Computer 服务接口（ServiceNames.COMPUTER） */
export interface ComputerService {
  /** 模块初始化：准备目录、解析驱动、后台连接（不阻塞内核启动） */
  initialize(): Promise<void>;
  destroy(): Promise<void>;

  getStatus(): ComputerStatus;

  /** 确保已连接；未安装或连接失败时抛错 */
  ensureConnected(): Promise<void>;
  /** 断开后重连 */
  reconnect(): Promise<void>;

  /** Windows：通过官方 install.ps1 安装（-NoAutoStart -NoPathUpdate）；其他平台返回不支持 */
  install(): Promise<{ ok: boolean; output: string }>;

  isPaused(): boolean;
  setPaused(paused: boolean): void;

  /** cua 已暴露的工具名（连接后缓存） */
  listToolNames(): string[];
  supportsTool(name: string): boolean;
  /** cua 工具的原始 inputSchema（用于版本/平台参数适配） */
  getToolSchema(name: string): unknown | null;

  /**
   * 调用 cua 工具。
   * - 自动注入 session（若 schema 声明）
   * - 自动保存 image content 为文件
   * - source=agent 时记录活动并广播
   */
  callTool(
    tool: string,
    args: Record<string, unknown>,
    opts?: ComputerCallOptions,
  ): Promise<ComputerToolResult>;

  /** 面板实时画面：整屏截图（写入 live/ 临时文件） */
  captureDesktop(opts?: { maxImageDimension?: number }): Promise<ComputerCapture>;
  /** 面板实时画面：单窗口截图（display_only，不替换 Agent 快照） */
  captureWindow(
    pid: number,
    windowId: number,
    opts?: { maxImageDimension?: number },
  ): Promise<ComputerCapture>;

  /** 最近活动（按 sessionId 过滤；无 sessionId 返回全部） */
  getActivities(sessionId?: string): ComputerActivity[];

  /** ~/.moss/computer（截图/安装脚本根目录） */
  getDataDir(): string;

  /** 分配一次工具截图的落盘路径（由工具在调用前创建，cua 写入） */
  createScreenshotPath(kind: string, pid?: number, windowId?: number): string;
}
