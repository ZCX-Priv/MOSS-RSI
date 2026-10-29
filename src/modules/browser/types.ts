// src/modules/browser/types.ts
// Browser 模块契约：浏览器实例 / AI 标签页 / CDP 页面操作 / 内置 Chrome / 扩展桥接。
// 由 browser 模块实现并注册到 ServiceNames.BROWSER；browser 工具与 /api/browser/* 共用。

/** 实例来源：builtin=MOSS 启动的内置 Chrome，external=用户浏览器里的扩展，cdp=外部 CDP 直连 */
export type BrowserInstanceKind = 'builtin' | 'external' | 'cdp';

/** 浏览器控制模式：内置 Chrome / 浏览器扩展 / 外部 CDP 直连 */
export type BrowserMode = 'builtin' | 'extension' | 'cdp';

/** 浏览器目标选择：auto / builtin / external / 具体实例 id */
export type BrowserTarget = string;

/** 工具运行时可配置参数（config.tools.browser） */
export interface BrowserToolConfig {
  enabled: boolean;
  /** 默认控制模式（browser 工具未显式指定 target 时使用） */
  mode: BrowserMode;
  /** CDP 模式默认端点（http(s)://host:port、host:port、纯端口或 ws://） */
  cdpEndpoint: string;
  timeoutMs: number;
  bridgePort: number;
  bridgeToken: string;
  tabGroupTitle: string;
  tabGroupColor: string;
  maxSnapshotNodes: number;
  maxImageDimension: number;
  browserPath: string;
  autoDownloadChromeForTesting: boolean;
  autoInstallExtensions: boolean;
  allowEvaluate: boolean;
}

/** 桥接 WebSocket 服务状态 */
export interface BrowserBridgeStatus {
  running: boolean;
  /** 实际监听端口（null=未启动） */
  port: number | null;
  /** 配置端口（改端口需重启 MOSS，status 会提示差异） */
  configuredPort: number;
  tokenConfigured: boolean;
  error: string | null;
}

/** 一个已连接的扩展实例 */
export interface BrowserInstanceInfo {
  id: string;
  kind: BrowserInstanceKind;
  browserName: string;
  browserVersion: string;
  extensionId: string;
  extensionVersion: string;
  /** 内置 Chrome 本次启动注入的标记（外部浏览器为空） */
  builtinTag?: string;
  connectedAt: number;
  tabCount: number;
}

/** 内置 Chrome 状态 */
export interface BrowserBuiltinStatus {
  running: boolean;
  executable: string | null;
  source: 'config' | 'local' | 'chrome-for-testing' | null;
  version: string | null;
  profileDir: string;
  /** 扩展是否已加载（影响 AI 标签页分组） */
  extensionLoaded: boolean;
  extensionId: string | null;
  error: string | null;
}

/** 浏览器扩展（MOSS Browser Bridge）状态 */
export interface BrowserExtensionStatus {
  dir: string;
  version: string | null;
  seeded: boolean;
}

/** Chrome for Testing 下载/安装状态 */
export interface BrowserCftStatus {
  installed: boolean;
  buildId: string | null;
  executable: string | null;
  downloading: boolean;
  progress: { received: number; total: number; percent: number } | null;
  error: string | null;
}

/** 对外暴露的 AI 标签页信息 */
export interface BrowserTabInfo {
  /** 工具层使用的短 id（如 t1） */
  tab: string;
  instanceId: string;
  instanceKind: BrowserInstanceKind;
  browserName: string;
  browserVersion: string;
  nativeTabId: number;
  windowId?: number;
  groupId: number | null;
  url: string;
  title: string;
  active: boolean;
  createdAt: number;
}

/** 外部 CDP 直连状态（浏览器级 WS） */
export interface BrowserCdpStatus {
  connected: boolean;
  /** 配置/本次使用的端点 */
  endpoint: string;
  /** 实际连接的浏览器级 WebSocket 地址 */
  resolvedUrl: string | null;
  /** Browser.getVersion 的 product（如 Chrome/145.0.0.0） */
  product: string | null;
  version: string | null;
  /** 最近一次已知的 page target 数量 */
  targetCount: number;
  error: string | null;
}

/** /api/browser/status 与工具 status 的共享状态 */
export interface BrowserStatus {
  /** 当前默认控制模式（tools.browser.mode） */
  mode: BrowserMode;
  bridge: BrowserBridgeStatus;
  instances: BrowserInstanceInfo[];
  builtin: BrowserBuiltinStatus;
  cdp: BrowserCdpStatus;
  extension: BrowserExtensionStatus;
  cft: BrowserCftStatus;
  installer: BrowserInstallerStatus;
  tabs: BrowserTabInfo[];
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

/** 打开 AI 标签页参数 */
export interface BrowserOpenOptions {
  target?: BrowserTarget;
  url?: string;
  timeoutMs?: number;
  /** 临时 CDP 端点；传入时本次及后续调用使用该端点（覆盖目标为 cdp） */
  cdpEndpoint?: string;
}

/** 导航参数 */
export interface BrowserNavigateOptions {
  url?: string;
  back?: boolean;
  forward?: boolean;
  reload?: boolean;
  timeoutMs?: number;
}

export interface BrowserPageInfo {
  tab: string;
  url: string;
  title: string;
  /** 页面仍在加载（navigate 超时） */
  loading?: boolean;
  /** click/press_key 打开了新标签页并已接管 */
  openedTab?: { tab: string; url: string; title: string };
}

/** snapshot 结果（text 已包含 ref 标记） */
export interface BrowserSnapshot {
  tab: string;
  url: string;
  title: string;
  text: string;
  refCount: number;
  truncated: boolean;
}

export interface BrowserScreenshot {
  path: string;
  data: string;
  mimeType: 'image/png';
  width?: number;
  height?: number;
}

export interface BrowserClickOptions {
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: string[];
  timeoutMs?: number;
}

export interface BrowserHoverOptions {
  ref?: string;
  selector?: string;
  timeoutMs?: number;
}

export interface BrowserTypeOptions {
  ref?: string;
  selector?: string;
  text: string;
  replace?: boolean;
  submit?: boolean;
  timeoutMs?: number;
}

export interface BrowserPressKeyOptions {
  key: string;
  modifiers?: string[];
  timeoutMs?: number;
}

export interface BrowserSelectOptions {
  ref?: string;
  selector?: string;
  values: string[];
  timeoutMs?: number;
}

export interface BrowserScrollOptions {
  ref?: string;
  deltaX?: number;
  deltaY?: number;
  timeoutMs?: number;
}

/** 按住并拖动：起点/终点支持 ref、selector 或坐标 */
export interface BrowserDragOptions {
  fromRef?: string;
  fromSelector?: string;
  fromX?: number;
  fromY?: number;
  toRef?: string;
  toSelector?: string;
  toX?: number;
  toY?: number;
  button?: 'left' | 'right' | 'middle';
  steps?: number;
  durationMs?: number;
  timeoutMs?: number;
}

export interface BrowserEvaluateOptions {
  expression: string;
  timeoutMs?: number;
}

export interface BrowserWaitOptions {
  waitMs?: number;
  selector?: string;
  text?: string;
  timeoutMs?: number;
}

export interface BrowserConsoleEntry {
  type: string;
  text: string;
  ts: number;
  url?: string;
  line?: number;
}

export interface BrowserConsoleResult {
  entries: BrowserConsoleEntry[];
  cleared: boolean;
}

/** 标签页列表项（扩展原生字段，用于 tabs 列表与恢复） */
export interface NativeTabInfo {
  tabId: number;
  windowId: number;
  /** 打开该标签页的源标签页（target=_blank / window.open） */
  openerTabId?: number;
  groupId: number;
  url: string;
  title: string;
  active: boolean;
  status: string;
  pinned: boolean;
}

/** 自动安装器中单个浏览器的状态 */
export type BrowserInstallerState =
  | 'pending'
  | 'installing'
  | 'already'
  | 'installed'
  | 'reloaded'
  | 'skipped'
  | 'manual'
  | 'failed';

export interface BrowserInstallerBrowser {
  id: string;
  name: string;
  executable: string;
  state: BrowserInstallerState;
  detail?: string;
  at?: number;
}

/** 扩展安装状态（仅在用户显式触发安装时执行） */
export interface BrowserInstallerStatus {
  enabled: boolean;
  running: boolean;
  /** 本次进程是否已完成至少一次真实安装校验（WebUI 据此避免安装前误弹确认框） */
  checked: boolean;
  current: string | null;
  browsers: BrowserInstallerBrowser[];
}

/** 扩展桥接 hello 帧 */
export interface BridgeHello {
  type: 'hello';
  protocol: number;
  extensionId: string;
  extensionVersion: string;
  instanceId: string;
  browser?: { name?: string; version?: string; userAgent?: string };
  token?: string;
  /** 内置 Chrome 启动时注入的标记（扩展从 chrome.storage 读取） */
  builtinTag?: string;
}

/** Browser 服务接口（ServiceNames.BROWSER） */
export interface BrowserService {
  initialize(): Promise<void>;
  destroy(): Promise<void>;

  getStatus(): BrowserStatus;
  /** 连接外部 CDP 端点（不传时使用配置的 cdpEndpoint） */
  connectCdp(endpoint?: string): Promise<BrowserCdpStatus>;
  /** 断开外部 CDP 连接（同时清理该连接的 AI 标签页） */
  disconnectCdp(): Promise<void>;
  /** 播种扩展并返回目录绝对路径 */
  ensureExtension(): Promise<BrowserExtensionStatus>;
  /** 在资源管理器中打开扩展目录 */
  openExtensionDir(): Promise<{ ok: boolean; path: string }>;
  launchBuiltin(): Promise<BrowserBuiltinStatus>;
  closeBuiltin(): Promise<void>;
  /** 后台启动 CfT 下载（失败写入状态，不抛错） */
  startChromeForTestingDownload(): Promise<void>;

  /** 显式安装扩展；force=true 忽略配置守卫 */
  autoInstallExtensions(force?: boolean): Promise<BrowserInstallerStatus>;
  getInstallerStatus(): BrowserInstallerStatus;

  /** 打开 AI 标签页（自动归组） */
  openTab(options: BrowserOpenOptions): Promise<BrowserTabInfo>;
  listTabs(all?: boolean, target?: BrowserTarget): Promise<BrowserTabInfo[]>;
  /** 列出该实例的原生标签页（all=true 用） */
  listNativeTabs(target?: BrowserTarget): Promise<NativeTabInfo[]>;
  focusTab(tab?: string): Promise<BrowserTabInfo>;
  closeTab(tab?: string): Promise<void>;

  navigate(tab: string | undefined, options: BrowserNavigateOptions): Promise<BrowserPageInfo>;
  snapshot(tab: string | undefined, maxNodes?: number): Promise<BrowserSnapshot>;
  screenshot(tab: string | undefined, fullPage?: boolean): Promise<BrowserScreenshot>;
  click(tab: string | undefined, options: BrowserClickOptions): Promise<BrowserPageInfo>;
  hover(tab: string | undefined, options: BrowserHoverOptions): Promise<BrowserPageInfo>;
  typeText(tab: string | undefined, options: BrowserTypeOptions): Promise<BrowserPageInfo>;
  pressKey(tab: string | undefined, options: BrowserPressKeyOptions): Promise<BrowserPageInfo>;
  selectOption(tab: string | undefined, options: BrowserSelectOptions): Promise<BrowserPageInfo>;
  scroll(tab: string | undefined, options: BrowserScrollOptions): Promise<BrowserPageInfo>;
  drag(tab: string | undefined, options: BrowserDragOptions): Promise<BrowserPageInfo>;
  evaluate(tab: string | undefined, options: BrowserEvaluateOptions): Promise<{ result: string; type: string }>;
  waitFor(tab: string | undefined, options: BrowserWaitOptions): Promise<BrowserPageInfo>;
  consoleLogs(tab: string | undefined, clear?: boolean): Promise<BrowserConsoleResult>;
}
