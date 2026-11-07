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

/** 健康检查单项（cua health_report） */
export interface ComputerHealthCheck {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message: string;
  /** 失败时的修复指引（如 macOS 辅助功能/屏幕录制授权） */
  hint?: string;
}

/** 驱动健康检查结果（连接失败或手动诊断时填充） */
export interface ComputerHealth {
  overall: 'ok' | 'degraded' | 'failed';
  checks: ComputerHealthCheck[];
  checkedAt: number;
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
  /** 后端运行平台 */
  platform: 'win32' | 'darwin' | 'linux' | 'android' | 'other';
  /** 当前平台是否支持电脑控制（Android 为 false） */
  supported: boolean;
  /** 当前驱动版本具备的关键能力（用于面板降级提示） */
  capabilities: {
    startSession: boolean;
    healthReport: boolean;
    desktopCapture: boolean;
    windowCapture: boolean;
  };
  /** 最近一次健康检查（未检查为 null） */
  health: ComputerHealth | null;
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
  /** 临时画面（HTTP 读取后即可删除，避免面板轮询堆积文件） */
  transient?: boolean;
}

/** 进程顶层窗口（原生枚举；含 cua list_windows 不返回的无标题浮层） */
export interface ComputerProcessWindow {
  windowId: number;
  pid: number;
  className: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  minimized: boolean;
  isForeground: boolean;
  /** owner HWND（无 owner 为 0） */
  owner: number;
  isPopup: boolean;
  isToolWindow: boolean;
  /** EnumWindows 顺序（0 = Z 序最前） */
  zOrder: number;
}

/** 自动目标解析结果（浮层优先） */
export interface ComputerWindowTarget {
  windowId: number;
  /** 是否切换到了同进程的浮层/弹出窗口 */
  isOverlay: boolean;
  /** 该 pid 的主窗口（面积最大） */
  mainWindowId?: number;
  className?: string;
  title?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  /** native：Win32 EnumWindows；cua：cua list_windows 回退 */
  source: 'native' | 'cua';
}

/** cua 工具调用归一化结果 */
export interface ComputerToolResult {
  text: string;
  images: Array<{ data: string; mimeType: string; path: string }>;
  structured?: unknown;
  isError: boolean;
}

/** 窗口聚焦结果（自动焦点 / action=focus 共用） */
export interface ComputerFocusResult {
  ok: boolean;
  /** 实际聚焦到的窗口 id（回退时与请求的 windowId 不同） */
  focusedWindowId?: number;
  /** 目标窗口无法聚焦，已回退到同 pid 的主窗口 */
  fallback: boolean;
  /** 实际聚焦的是同进程的浮层/弹出窗口 */
  overlay?: boolean;
  error?: string;
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

  /** 驱动健康检查（cua health_report）；未连接或驱动不支持时返回 null */
  checkHealth(): Promise<ComputerHealth | null>;

  /** 最近活动（按 sessionId 过滤；无 sessionId 返回全部） */
  getActivities(sessionId?: string): ComputerActivity[];

  /** ~/.moss/computer（截图/安装脚本根目录） */
  getDataDir(): string;

  /** 分配一次工具截图的落盘路径（由工具在调用前创建，cua 写入） */
  createScreenshotPath(kind: string, pid?: number, windowId?: number): string;

  /** 列出某进程的顶层窗口（Windows 原生枚举；不可用时回退 cua list_windows） */
  listProcessWindows(pid: number): Promise<ComputerProcessWindow[]>;

  /**
   * 自动目标解析：同一进程弹出浮层/对话框时，返回最前面的浮层窗口，
   * 让截图与 UIA 树都针对该窗口；没有浮层时返回请求窗口（或主窗口）。
   */
  resolveWindowTarget(pid: number, requestedWindowId?: number): Promise<ComputerWindowTarget>;

  /** 当前系统前台窗口（原生枚举不可用时返回 null） */
  getForegroundWindowInfo(): ComputerProcessWindow | null;

  /**
   * 聚焦窗口（bring_to_front）。目标窗口失效/无法聚焦时回退到同 pid 的主窗口；
   * 失败不抛错，返回 ok=false 供调用方继续后台执行。
   */
  focusWindow(
    pid: number,
    windowId?: number,
    opts?: { force?: boolean },
  ): Promise<ComputerFocusResult>;
}
