// src/modules/browser/service.ts
// Browser 服务实现：扩展实例/内置 Chrome/AI 标签页注册表 + 页面操作编排。
//
// 数据通路：
// - external：扩展 WS 中继 chrome.debugger → 页面 CDP
// - builtin：Browser WS flat session → 页面 CDP；扩展仅负责建页/分组

import { randomUUID } from 'node:crypto';
import { t } from '../../core/i18n';
import type { ConfigService, Environment, Logger } from '../../core/types';
import type { ComputerService } from '../contracts';
import { BrowserBridgeServer, type BridgeEventPayload } from './bridge';
import { BuiltinChromeManager } from './builtin';
import { CdpBrowserManager } from './cdp-attach';
import { BrowserExtensionInstaller } from './installer';
import { CdpConnection } from './cdp';
import {
  buildSnapshot,
  captureScreenshot,
  clickElement,
  ConsoleBuffer,
  diffPercent,
  dragElement,
  enablePageDomains,
  evaluateExpression,
  frameSignature,
  getPageInfo,
  holdKeys,
  hoverElement,
  keyDown as dispatchKeyDown,
  keyUp as dispatchKeyUp,
  navigatePage,
  pressKey,
  scrollPage,
  selectOption,
  typeInto,
  waitChange as waitFrameChange,
  waitCondition,
  waitStable as waitFrameStable,
  type CdpSession,
  type FrameSignature,
  type ScreenshotRegion,
  type ScreenshotResult,
} from './page';
import {
  downloadChromeForTesting,
  ensureBrowserDirs,
  getBrowserDirs,
  getCftStatus,
  newScreenshotPath,
  openDirectory,
  pruneScreenshots,
  readCftMarker,
  resolveBrowserExecutable,
  seedExtension,
  type BrowserDirs,
} from './paths';
import type {
  BrowserCdpStatus,
  BrowserCftStatus,
  BrowserClickOptions,
  BrowserConsoleResult,
  BrowserDragOptions,
  BrowserEvaluateOptions,
  BrowserExtensionStatus,
  BrowserFocusResult,
  BrowserFrameInfo,
  BrowserFrameWaitOptions,
  BrowserFrameWaitResult,
  BrowserHoldOptions,
  BrowserHoverOptions,
  BrowserInstanceInfo,
  BrowserInstanceKind,
  BrowserInstallerStatus,
  BrowserMacroResult,
  BrowserMacroStep,
  BrowserMacroStepResult,
  BrowserMode,
  BrowserNavigateOptions,
  BrowserOpenOptions,
  BrowserPageInfo,
  BrowserPressKeyOptions,
  BrowserRect,
  BrowserScreenshot,
  BrowserScrollOptions,
  BrowserSelectOptions,
  BrowserService,
  BrowserSnapshot,
  BrowserStatus,
  BrowserTabInfo,
  BrowserTarget,
  BrowserToolConfig,
  BrowserTypeOptions,
  BrowserWaitOptions,
  NativeTabInfo,
} from './types';

const BROWSER_MODES: ReadonlySet<BrowserMode> = new Set<BrowserMode>([
  'builtin',
  'extension',
  'cdp',
]);

const DEFAULT_CONFIG: BrowserToolConfig = {
  enabled: true,
  mode: 'extension',
  cdpEndpoint: 'http://127.0.0.1:9222',
  timeoutMs: 30_000,
  bridgePort: 7799,
  bridgeToken: '',
  tabGroupTitle: 'MOSS',
  tabGroupColor: 'blue',
  maxSnapshotNodes: 800,
  maxImageDimension: 1600,
  browserPath: '',
  autoDownloadChromeForTesting: false,
  autoInstallExtensions: false,
  allowEvaluate: true,
  autoFocus: true,
};

/** 旧版标签组名：用于接管历史分组 */
const LEGACY_GROUP_TITLES = ['MOSS AI'];

const GROUP_COLORS = new Set([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

interface FrameRecord {
  /** 稳定 key：OOPIF=targetId；同进程 iframe=frameId */
  frame: string;
  mode: 'oopif' | 'context';
  frameId: string;
  targetId?: string;
  sessionId?: string;
  contextId?: number;
  url: string;
  title: string;
  /** 帧在 frame tree 中的深度（auto 选最深/最内层） */
  depth: number;
  /** 顶层 iframe 的页面坐标（嵌套 frame 继承最外层祖先） */
  rect?: BrowserRect;
  /** 顶层 iframe 的 URL（刷新 rect 时用于重新定位） */
  topUrl?: string;
  /** 该 frame 是否已获得键盘焦点（真实 CDP Input 前确认） */
  inputFocused?: boolean;
  /** 是否已对该 frame 启用 focus emulation（避免每次动作重复发送） */
  focusEmulated?: boolean;
  session: CdpSession | null;
}

interface FrameTreeNode {
  frame?: {
    id?: string;
    parentId?: string;
    url?: string;
    name?: string;
  };
  childFrames?: FrameTreeNode[];
}

interface FlatFrame {
  id: string;
  parentId?: string;
  url: string;
  name: string;
  depth: number;
}

/** 展平 Page.getFrameTree（包含同进程/嵌套 iframe） */
function flattenFrameTree(root: FrameTreeNode | undefined): FlatFrame[] {
  const out: FlatFrame[] = [];
  const walk = (node: FrameTreeNode | undefined, depth: number, parentId?: string): void => {
    const frame = node?.frame;
    const frameId = frame?.id;
    if (!frame || typeof frameId !== 'string') return;
    out.push({
      id: frameId,
      ...(parentId ? { parentId } : {}),
      url: typeof frame.url === 'string' ? frame.url : '',
      name: typeof frame.name === 'string' ? frame.name : '',
      depth,
    });
    for (const child of node.childFrames ?? []) {
      walk(child, depth + 1, frameId);
    }
  };
  walk(root, 0);
  return out;
}

interface TabRecord {
  key: string;
  instanceId: string;
  kind: BrowserInstanceKind;
  browserName: string;
  browserVersion: string;
  nativeTabId: number;
  windowId?: number;
  /** 打开该标签页的源标签页（弹窗/新标签页聚焦回退用） */
  openerTabId?: number;
  groupId: number | null;
  targetId?: string;
  sessionId?: string;
  session: CdpSession | null;
  sessionPromise: Promise<CdpSession> | null;
  sessionDead: boolean;
  refs: Map<string, number>;
  /** 跨域 iframe 快照的 ref 路由（key 形如 f1:e3 → 子会话 backendNodeId） */
  frameRefs: Map<string, { frame: string; backendNodeId: number }>;
  /** 自动确认过的 JavaScript 弹窗（供下一次工具结果回传） */
  dialogs: string[];
  console: ConsoleBuffer;
  listeners: Set<(method: string, params: unknown, sessionId?: string) => void>;
  /** 会话级事件解绑函数（frame 追踪等） */
  sessionCleanup: Array<() => void>;
  /** iframe / OOPIF 子会话（key = targetId） */
  frames: Map<string, FrameRecord>;
  /** 是否已对根会话启用 focus emulation（每会话只发一次） */
  focusEmulated?: boolean;
  /** 最近一次截图的尺寸信息（供 coord_space=screenshot 换算） */
  lastShot?: {
    imageWidth?: number;
    imageHeight?: number;
    viewportWidth?: number;
    viewportHeight?: number;
    scale?: number;
    frame?: string;
    region?: BrowserRect;
  };
  url: string;
  title: string;
  active: boolean;
  createdAt: number;
}

/** 已失效但保留 URL 的标签页记录，用于按 URL 重新接管 */
interface RetiredTab {
  key: string;
  instanceId: string;
  nativeTabId: number;
  url: string;
  title: string;
  at: number;
}

interface ResolvedTarget {
  /** 实例 id；无扩展的内置 Chrome 使用 'builtin' 作为合成 id */
  key: string;
  kind: BrowserInstanceKind;
  /** 扩展桥接实例 id（null=内置 Chrome 未加载扩展） */
  bridgeId: string | null;
  browserName: string;
  browserVersion: string;
  /** 上次使用该实例的 AI 标签页 */
  lastTabKey: string | null;
}

class RelaySession implements CdpSession {
  constructor(
    private readonly sendFn: (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>,
    private readonly onEventFn: (
      handler: (method: string, params: unknown, sessionId?: string) => void,
      sessionId?: string,
    ) => () => void,
    private readonly sessionId?: string,
  ) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.sendFn(method, params, this.sessionId)) as T;
  }

  onEvent(handler: (method: string, params: unknown) => void): () => void {
    return this.onEventFn((method, params) => handler(method, params), this.sessionId);
  }
}

/**
 * 同进程 iframe 会话：跨域但同站点的 iframe（如 poki.com 的 games.poki.com）
 * 不会生成独立 CDP target，无法用独立 session 定向。
 * 这里用 Page.createIsolatedWorld 拿到该 frame 的 executionContextId：
 * - Runtime.evaluate 在该 frame 执行（读取 canvas/页面状态）；
 * - 键盘/文本/鼠标事件转发到根会话（真实 CDP 事件，浏览器按当前焦点与 hit-test 路由）；
 * - 鼠标坐标加上 iframe 偏移；截图转发根会话并用 iframe rect 裁剪。
 */
class ContextFrameSession implements CdpSession {
  constructor(
    private readonly root: CdpSession,
    private readonly frame: FrameRecord,
  ) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (method) {
      case 'Runtime.evaluate':
        return (await this.evaluateInFrame(params)) as T;
      case 'Input.dispatchKeyEvent':
      case 'Input.insertText':
        // 真实 CDP 事件（isTrusted=true）。旧实现用 Runtime.evaluate 合成 KeyboardEvent，
        // 游戏既看不到 isTrusted，也拿不到 keyCode/which，表现为按键完全无效。
        await this.ensureInputFocus();
        return (await this.root.send<T>(method, params)) as T;
      case 'Input.dispatchMouseEvent':
        return (await this.forwardMouse(params)) as T;
      case 'Page.captureScreenshot':
        return (await this.captureFrame(params)) as T;
      case 'Page.getLayoutMetrics':
        return this.root.send<T>(method, params);
      default:
        return this.root.send<T>(method, params);
    }
  }

  onEvent(handler: (method: string, params: unknown) => void): () => void {
    // 同进程 frame 的事件从根会话发出；保留接口与根会话一致
    return this.root.onEvent(handler);
  }

  private async ensureContextId(): Promise<number> {
    if (this.frame.contextId !== undefined) return this.frame.contextId;
    const created = await this.root.send<{ executionContextId?: number }>('Page.createIsolatedWorld', {
      frameId: this.frame.frameId,
      worldName: 'moss_frame',
    });
    if (typeof created.executionContextId !== 'number') {
      throw new Error('无法为 iframe 创建隔离执行上下文');
    }
    this.frame.contextId = created.executionContextId;
    return created.executionContextId;
  }

  private async evaluateInFrame(params: Record<string, unknown>): Promise<unknown> {
    const contextId = await this.ensureContextId();
    try {
      return await this.root.send('Runtime.evaluate', { ...params, contextId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/context|Cannot find|not found/i.test(message)) throw err;
      // frame 导航后旧 context 失效：重建一次
      this.frame.contextId = undefined;
      const fresh = await this.ensureContextId();
      return this.root.send('Runtime.evaluate', { ...params, contextId: fresh });
    }
  }

  /** 确保 iframe 内的文档获得焦点（真实按键会被路由到当前聚焦的 frame） */
  private async ensureInputFocus(): Promise<void> {
    if (this.frame.inputFocused) return;
    let hasActiveElement = false;
    try {
      const evaluated = await this.evaluateInFrame({
        // 不用 document.hasFocus()：Emulation.setFocusEmulationEnabled 会让它恒为 true，
        // 无法区分 iframe 内部是否真的持有焦点。
        expression: `(() => {
          const el = document.activeElement;
          if (!el) return { active: '' };
          return { active: el.tagName || '' };
        })()`,
        returnByValue: true,
      });
      const active =
        isRecord(evaluated) && isRecord(evaluated.result) && typeof evaluated.result.value === 'object'
          ? evaluated.result.value
          : null;
      const tag = isRecord(active) && typeof active.active === 'string' ? active.active : '';
      hasActiveElement = tag !== '' && tag !== 'BODY' && tag !== 'HTML';
    } catch {
      hasActiveElement = false;
    }
    if (!hasActiveElement) {
      const rect = this.frame.rect;
      if (rect) {
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        await this.root.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'none',
          buttons: 0,
        });
        await this.root.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
          buttons: 1,
        });
        await this.root.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
          buttons: 0,
        });
      }
    }
    this.frame.inputFocused = true;
  }

  private async forwardMouse(params: Record<string, unknown>): Promise<unknown> {
    const rect = this.frame.rect;
    if (!rect) return this.root.send('Input.dispatchMouseEvent', params);
    const x = typeof params.x === 'number' ? params.x + rect.x : params.x;
    const y = typeof params.y === 'number' ? params.y + rect.y : params.y;
    return this.root.send('Input.dispatchMouseEvent', { ...params, x, y });
  }

  private async captureFrame(params: Record<string, unknown>): Promise<unknown> {
    const rect = this.frame.rect;
    if (!rect) return this.root.send('Page.captureScreenshot', params);
    const clip = isRecord(params.clip) ? params.clip : undefined;
    const x = typeof clip?.x === 'number' ? clip.x + rect.x : rect.x;
    const y = typeof clip?.y === 'number' ? clip.y + rect.y : rect.y;
    const width = typeof clip?.width === 'number' ? clip.width : rect.width;
    const height = typeof clip?.height === 'number' ? clip.height : rect.height;
    const scale = typeof clip?.scale === 'number' ? clip.scale : 1;
    return this.root.send('Page.captureScreenshot', {
      ...params,
      clip: { x, y, width, height, scale },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function modeValue(value: unknown, fallback: BrowserMode): BrowserMode {
  return typeof value === 'string' && BROWSER_MODES.has(value as BrowserMode)
    ? (value as BrowserMode)
    : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BrowserServiceDeps {
  env: Environment;
  logger: Logger;
  config: ConfigService;
  /** 自动安装器使用的桌面自动化服务（可能未注册/未连接） */
  computer: ComputerService | null;
}

export class BrowserServiceImpl implements BrowserService {
  private readonly env: Environment;
  private readonly logger: Logger;
  private readonly config: ConfigService;
  private readonly dirs: BrowserDirs;
  private readonly bridge: BrowserBridgeServer;
  private readonly builtin: BuiltinChromeManager;
  private readonly cdp: CdpBrowserManager;
  private readonly installer: BrowserExtensionInstaller;

  private extensionStatus: BrowserExtensionStatus;
  private readonly tabs = new Map<string, TabRecord>();
  /** 已失效标签页的 URL 快照：用于按 URL 恢复同一个 tN key */
  private readonly retiredTabs = new Map<string, RetiredTab>();
  private tabSeq = 0;
  private currentTabKey: string | null = null;
  private lastTargetKey: string | null = null;
  private builtinInstanceId: string | null = null;
  private builtinError: string | null = null;
  /** 每个实例的「刚执行过 click/press_key」窗口，用于接管无 opener 的新标签页 */
  private readonly pendingNewTabUntil = new Map<string, number>();
  /** 最近自动接管的新标签页（供 click 结果提示） */
  private lastAdoptedTab: { instanceId: string; tab: string; at: number } | null = null;
  /** 扩展 reload 冷却（key = extensionId）：避免版本不一致时反复 reload 导致闪屏/断连 */
  private readonly extensionReloadAt = new Map<string, number>();
  /** 已请求过 reload 的「扩展 + 版本对」：同一版本组合只 reload 一次，绝不循环 */
  private readonly reloadRequestedPairs = new Set<string>();
  /** 已告警过「reload 后版本仍未更新」的扩展（每个扩展只提示一次） */
  private readonly warnedExtensionVersions = new Set<string>();

  private cftDownloading = false;
  private cftProgress: { received: number; total: number; percent: number } | null = null;
  private cftError: string | null = null;

  constructor(deps: BrowserServiceDeps) {
    this.env = deps.env;
    this.logger = deps.logger;
    this.config = deps.config;
    this.dirs = getBrowserDirs(deps.env);
    this.extensionStatus = { dir: this.dirs.extension, version: null, seeded: false };

    this.bridge = new BrowserBridgeServer({
      logger: this.logger,
      getToken: () => this.getToolConfig().bridgeToken,
      getBuiltinTag: () => this.builtin.getBuiltinTag(),
      onInstanceConnected: (info) => this.onInstanceConnected(info),
      onInstanceDisconnected: (instanceId) => this.onInstanceDisconnected(instanceId),
      onEvent: (payload) => this.onBridgeEvent(payload),
    });

    this.builtin = new BuiltinChromeManager({
      env: this.env,
      logger: this.logger,
      dirs: this.dirs,
      extensionDir: this.dirs.extension,
      getOptions: () => {
        const cfg = this.getToolConfig();
        return { browserPath: cfg.browserPath, bridgePort: cfg.bridgePort, bridgeToken: cfg.bridgeToken };
      },
    });

    this.cdp = new CdpBrowserManager({
      logger: this.logger,
      getDefaultEndpoint: () => this.getToolConfig().cdpEndpoint,
    });

    this.installer = new BrowserExtensionInstaller({
      env: this.env,
      logger: this.logger,
      dirs: this.dirs,
      extensionDir: this.dirs.extension,
      computer: deps.computer,
      getConfig: () => this.getToolConfig(),
      getInstances: () => this.listEffectiveInstances(),
      getExtensionVersion: () => this.extensionStatus.version,
    });
  }

  async initialize(): Promise<void> {
    ensureBrowserDirs(this.dirs);
    // 扩展播种 / 截图清理移到 warmup（递归目录 + 哈希是启动期明显开销）
    const cfg = this.getToolConfig();
    this.bridge.start(cfg.bridgePort);
    this.logger.info(`[browser] 模块已初始化（扩展目录 ${this.dirs.extension}）`);
    // 启动阶段不触碰浏览器：扩展安装只在用户于「设置 → 浏览器」点击按钮或工具 action='setup' 时执行
  }

  /** 后台预热：扩展目录播种 + 历史截图清理（不阻塞启动与首条消息） */
  async warmup(): Promise<void> {
    try {
      pruneScreenshots(this.dirs);
    } catch {
      // 清理失败不影响功能
    }
    this.extensionStatus = seedExtension(this.env, this.dirs);
    this.logger.info('[browser] warmup completed', { extensionDir: this.dirs.extension });
  }

  async destroy(): Promise<void> {
    for (const record of this.tabs.values()) {
      record.sessionCleanup.splice(0).forEach((fn) => fn());
      record.console.dispose();
      record.listeners.clear();
      record.frames.clear();
    }
    this.tabs.clear();
    await this.builtin.close();
    await this.cdp.disconnect();
    this.bridge.stop();
  }

  // ==========================================================================
  // 配置与状态
  // ==========================================================================

  private getToolConfig(): BrowserToolConfig {
    try {
      const tools = this.config.getAppConfig().tools as Record<string, Record<string, unknown>>;
      const raw = tools.browser ?? {};
      const color = stringValue(raw.tabGroupColor, DEFAULT_CONFIG.tabGroupColor);
      return {
        enabled: booleanValue(raw.enabled, DEFAULT_CONFIG.enabled),
        mode: modeValue(raw.mode, DEFAULT_CONFIG.mode),
        cdpEndpoint:
          stringValue(raw.cdpEndpoint, DEFAULT_CONFIG.cdpEndpoint).trim() || DEFAULT_CONFIG.cdpEndpoint,
        timeoutMs: numberValue(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs, 5000, 300_000),
        bridgePort: numberValue(raw.bridgePort, DEFAULT_CONFIG.bridgePort, 1024, 65535),
        bridgeToken: stringValue(raw.bridgeToken, DEFAULT_CONFIG.bridgeToken).trim(),
        tabGroupTitle: this.normalizeGroupTitle(
          stringValue(raw.tabGroupTitle, DEFAULT_CONFIG.tabGroupTitle).trim() || DEFAULT_CONFIG.tabGroupTitle,
        ),
        tabGroupColor: GROUP_COLORS.has(color) ? color : DEFAULT_CONFIG.tabGroupColor,
        maxSnapshotNodes: numberValue(raw.maxSnapshotNodes, DEFAULT_CONFIG.maxSnapshotNodes, 100, 3000),
        maxImageDimension: numberValue(raw.maxImageDimension, DEFAULT_CONFIG.maxImageDimension, 0, 4096),
        browserPath: stringValue(raw.browserPath, DEFAULT_CONFIG.browserPath).trim(),
        autoDownloadChromeForTesting: booleanValue(
          raw.autoDownloadChromeForTesting,
          DEFAULT_CONFIG.autoDownloadChromeForTesting,
        ),
        autoInstallExtensions: booleanValue(
          raw.autoInstallExtensions,
          DEFAULT_CONFIG.autoInstallExtensions,
        ),
        allowEvaluate: booleanValue(raw.allowEvaluate, DEFAULT_CONFIG.allowEvaluate),
        autoFocus: booleanValue(raw.autoFocus, DEFAULT_CONFIG.autoFocus),
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** 旧配置中的「MOSS AI」自动归一化为「MOSS」 */
  private normalizeGroupTitle(value: string): string {
    if (!value) return 'MOSS';
    return value === 'MOSS AI' ? 'MOSS' : value;
  }

  getStatus(): BrowserStatus {
    this.syncBuiltinInstance();
    const cfg = this.getToolConfig();
    const builtinStatus = this.builtin.getStatus();
    const cftBase = getCftStatus(this.dirs);
    const cft: BrowserCftStatus = {
      ...cftBase,
      downloading: this.cftDownloading,
      progress: this.cftProgress,
      error: this.cftError,
    };
    return {
      mode: cfg.mode,
      bridge: {
        running: this.bridge.running,
        port: this.bridge.port,
        configuredPort: cfg.bridgePort,
        tokenConfigured: Boolean(cfg.bridgeToken),
        error: this.bridge.error,
      },
      instances: this.listEffectiveInstances(),
      builtin: {
        ...builtinStatus,
        error: builtinStatus.error ?? this.builtinError,
      },
      cdp: this.cdp.getStatus(),
      extension: this.extensionStatus,
      cft,
      installer: this.installer.getStatus(),
      tabs: this.listTabInfos(),
      currentTab: this.currentTabKey,
      config: {
        tabGroupTitle: cfg.tabGroupTitle,
        tabGroupColor: cfg.tabGroupColor,
        maxSnapshotNodes: cfg.maxSnapshotNodes,
        maxImageDimension: cfg.maxImageDimension,
        allowEvaluate: cfg.allowEvaluate,
        timeoutMs: cfg.timeoutMs,
      },
    };
  }

  private listEffectiveInstances(): BrowserInstanceInfo[] {
    return this.bridge.listInstances().map((info) => {
      const kind: BrowserInstanceKind =
        info.kind === 'builtin' || info.id === this.builtinInstanceId ? 'builtin' : 'external';
      return { ...info, kind, tabCount: this.countTabs(info.id) };
    });
  }

  private countTabs(instanceId: string): number {
    let count = 0;
    for (const record of this.tabs.values()) {
      if (record.instanceId === instanceId) count += 1;
    }
    return count;
  }

  private syncBuiltinInstance(): void {
    const tag = this.builtin.getBuiltinTag();
    if (!tag) {
      if (!this.builtin.isRunning()) this.builtinInstanceId = null;
      return;
    }
    const tagged = this.bridge.listInstances().find((info) => info.builtinTag === tag);
    this.builtinInstanceId = tagged?.id ?? null;
    if (tagged && !this.builtin.getStatus().extensionLoaded) {
      this.builtin.adoptExtension(tagged.extensionId);
    }
  }

  // ==========================================================================
  // 扩展 / 内置 Chrome 控制
  // ==========================================================================

  async ensureExtension(): Promise<BrowserExtensionStatus> {
    this.extensionStatus = seedExtension(this.env, this.dirs);
    return this.extensionStatus;
  }

  async openExtensionDir(): Promise<{ ok: boolean; path: string }> {
    await this.ensureExtension();
    const ok = openDirectory(this.env, this.dirs.extension);
    return { ok, path: this.dirs.extension };
  }

  /** 显式安装扩展；force=true 时忽略配置守卫（设置页按钮 / 工具 setup 使用） */
  async autoInstallExtensions(force = false): Promise<BrowserInstallerStatus> {
    await this.ensureExtension();
    return this.installer.run(force);
  }

  getInstallerStatus(): BrowserInstallerStatus {
    return this.installer.getStatus();
  }

  async launchBuiltin(): Promise<BrowserStatus['builtin']> {
    if (this.builtin.isRunning()) {
      this.syncBuiltinInstance();
      return this.getStatus().builtin;
    }
    const cfg = this.getToolConfig();
    this.builtinError = null;
    let resolved = resolveBrowserExecutable(this.env, this.dirs, cfg.browserPath);
    if (!resolved && cfg.autoDownloadChromeForTesting) {
      await this.startChromeForTestingDownload();
      resolved = resolveBrowserExecutable(this.env, this.dirs, cfg.browserPath);
    }
    if (!resolved) {
      this.builtinError = '未找到可用的 Chrome/Chromium；请在「设置 → 浏览器」下载 Chrome for Testing 或配置浏览器路径';
      return this.getStatus().builtin;
    }

    let result = await this.builtin.launch(resolved);
    if (!result.status.extensionLoaded && resolved.source !== 'chrome-for-testing') {
      const cft = readCftMarker(this.dirs);
      if (cft) {
        result = await this.builtin.launch({ executable: cft.executable, source: 'chrome-for-testing' });
      } else if (cfg.autoDownloadChromeForTesting) {
        await this.startChromeForTestingDownload();
        const downloaded = readCftMarker(this.dirs);
        if (downloaded) {
          result = await this.builtin.launch({ executable: downloaded.executable, source: 'chrome-for-testing' });
        }
      }
    }

    if (result.status.running) {
      this.builtinError = null;
    } else {
      this.builtinError = result.status.error;
    }
    // 即使 SW 探测失败，扩展也可能已通过 WS 带 tag 连上
    await this.waitForBuiltinInstance(10_000);
    this.syncBuiltinInstance();
    return this.getStatus().builtin;
  }

  private async waitForBuiltinInstance(timeoutMs: number): Promise<void> {
    const tag = this.builtin.getBuiltinTag();
    if (!tag) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tagged = this.bridge.listInstances().find((info) => info.builtinTag === tag);
      if (tagged) {
        this.builtinInstanceId = tagged.id;
        if (!this.builtin.getStatus().extensionLoaded) {
          this.builtin.adoptExtension(tagged.extensionId);
        }
        return;
      }
      await sleep(250);
    }
  }

  async closeBuiltin(): Promise<void> {
    const instanceId = this.builtinInstanceId;
    await this.builtin.close();
    this.builtinInstanceId = null;
    if (instanceId) this.removeTabsOfInstance(instanceId);
    this.removeTabsOfInstance('builtin');
    this.syncBuiltinInstance();
  }

  async connectCdp(endpoint?: string): Promise<BrowserCdpStatus> {
    return this.cdp.connect(endpoint);
  }

  async disconnectCdp(): Promise<void> {
    await this.cdp.disconnect();
    // 连接已断开：该通路创建的 AI 标签页不再可用
    this.removeTabsOfInstance('cdp');
  }

  async startChromeForTestingDownload(): Promise<void> {
    if (this.cftDownloading) return;
    this.cftDownloading = true;
    this.cftProgress = { received: 0, total: 0, percent: 0 };
    this.cftError = null;
    try {
      await downloadChromeForTesting(this.dirs, (received, total) => {
        this.cftProgress = {
          received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        };
      });
    } catch (err) {
      this.cftError = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[browser] Chrome for Testing 下载失败: ${this.cftError}`);
    } finally {
      this.cftDownloading = false;
      this.cftProgress = null;
    }
  }

  // ==========================================================================
  // 实例目标解析
  // ==========================================================================

  private syntheticBuiltin(): ResolvedTarget | null {
    const status = this.builtin.getStatus();
    if (!status.running) return null;
    return {
      key: 'builtin',
      kind: 'builtin',
      bridgeId: null,
      browserName: '内置 Chrome',
      browserVersion: status.version ?? '',
      lastTabKey: this.lastTabFor('builtin'),
    };
  }

  private lastTabFor(instanceKey: string): string | null {
    let latest: TabRecord | null = null;
    for (const record of this.tabs.values()) {
      if (record.instanceId !== instanceKey) continue;
      if (!latest || record.createdAt > latest.createdAt) latest = record;
    }
    return latest?.key ?? null;
  }

  private instanceToTarget(info: BrowserInstanceInfo): ResolvedTarget {
    return {
      key: info.id,
      kind: info.id === this.builtinInstanceId ? 'builtin' : 'external',
      bridgeId: info.id,
      browserName: info.browserName,
      browserVersion: info.browserVersion,
      lastTabKey: this.lastTabFor(info.id),
    };
  }

  /** 确保外部 CDP 已连接（未连接时按端点懒连接） */
  private async ensureCdp(endpoint?: string): Promise<BrowserCdpStatus> {
    if (this.cdp.isConnected()) return this.cdp.getStatus();
    return this.cdp.connect(endpoint?.trim() || this.getToolConfig().cdpEndpoint);
  }

  private async resolveTarget(target?: BrowserTarget): Promise<ResolvedTarget> {
    this.syncBuiltinInstance();
    const cfg = this.getToolConfig();
    // 未显式指定 target 时使用配置的默认模式（默认插件）
    const wanted = (target ?? cfg.mode).trim() || cfg.mode;
    const instances = this.listEffectiveInstances();
    const wantBuiltin = wanted === 'builtin';
    const wantExternal = wanted === 'external' || wanted === 'extension';

    if (wanted === 'cdp') {
      const status = await this.ensureCdp(cfg.cdpEndpoint);
      return {
        key: 'cdp',
        kind: 'cdp',
        bridgeId: null,
        browserName: status.product ?? 'CDP',
        browserVersion: status.version ?? '',
        lastTabKey: this.lastTabFor('cdp'),
      };
    }

    if (wantBuiltin) {
      if (!this.builtin.isRunning()) {
        await this.launchBuiltin();
      }
      this.syncBuiltinInstance();
      const refreshed = this.listEffectiveInstances();
      if (this.builtinInstanceId) {
        const info = refreshed.find((item) => item.id === this.builtinInstanceId);
        if (info) return this.instanceToTarget(info);
      }
      const synthetic = this.syntheticBuiltin();
      if (synthetic) return synthetic;
      throw new Error(
        this.builtinError ?? t('browser.builtinNotAvailable'),
      );
    }

    if (wantExternal) {
      const external = instances.find((item) => item.kind === 'external');
      if (external) return this.instanceToTarget(external);
      throw new Error(t('browser.noExternalInstance'));
    }

    if (wanted === 'auto') {
      if (this.lastTargetKey) {
        const last = instances.find((item) => item.id === this.lastTargetKey);
        if (last) return this.instanceToTarget(last);
      }
      if (this.builtin.isRunning()) {
        if (this.builtinInstanceId) {
          const info = instances.find((item) => item.id === this.builtinInstanceId);
          if (info) return this.instanceToTarget(info);
        }
        const synthetic = this.syntheticBuiltin();
        if (synthetic) return synthetic;
      }
      const external = instances.find((item) => item.kind === 'external');
      if (external) return this.instanceToTarget(external);
      throw new Error(t('browser.noBrowserAvailable'));
    }

    const explicit = instances.find((item) => item.id === wanted);
    if (explicit) return this.instanceToTarget(explicit);
    if (wanted === 'builtin') {
      const synthetic = this.syntheticBuiltin();
      if (synthetic) return synthetic;
    }
    throw new Error(t('browser.instanceNotFound', { id: wanted }));
  }

  // ==========================================================================
  // 桥接回调
  // ==========================================================================

  private onInstanceConnected(info: BrowserInstanceInfo): void {
    if (info.kind === 'builtin') {
      this.builtinInstanceId = info.id;
      if (!this.builtin.getStatus().extensionLoaded) this.builtin.adoptExtension(info.extensionId);
    } else {
      this.syncBuiltinInstance();
    }
    this.maybeReloadExtension(info);
    void this.adoptExistingTabs(info.id).catch((err: unknown) => {
      this.logger.warn(`[browser] 恢复 AI 标签页失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * 扩展文件由 MOSS 播种；版本不一致时最多请求一次 reload 让新代码生效。
   * 关键：去重键是「扩展 + 当前版本 → 内置版本」，而不是每次重连的 instanceId，
   * 否则 reload → 断连 → 新实例 → 再 reload 会形成死循环（外部浏览器会持续闪屏）。
   */
  private maybeReloadExtension(info: BrowserInstanceInfo): void {
    const bundled = this.extensionStatus.version;
    if (!bundled || info.extensionVersion === bundled) return;
    const pairKey = `${info.extensionId}:${info.extensionVersion}->${bundled}`;
    if (this.reloadRequestedPairs.has(pairKey)) {
      // 已经 reload 过但版本仍未变化：只提示一次，避免循环
      if (info.kind !== 'builtin' && !this.warnedExtensionVersions.has(info.extensionId)) {
        this.warnedExtensionVersions.add(info.extensionId);
        this.logger.warn(
          `[browser] 扩展版本仍未更新（当前 ${info.extensionVersion}，内置 ${bundled}）：请在设置→浏览器重新安装/手动重载扩展`,
        );
      }
      return;
    }
    const last = this.extensionReloadAt.get(info.extensionId) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.extensionReloadAt.set(info.extensionId, Date.now());
    this.reloadRequestedPairs.add(pairKey);
    setTimeout(() => {
      void this.bridge
        .send(info.id, 'extension.reload', {}, 5000)
        .catch(() => {
          // 旧版本扩展不支持该命令：由自动安装器/用户重启浏览器完成升级
        });
    }, 500);
  }

  private onInstanceDisconnected(instanceId: string): void {
    this.removeTabsOfInstance(instanceId);
    if (this.builtinInstanceId === instanceId) this.builtinInstanceId = null;
  }

  private onBridgeEvent(payload: BridgeEventPayload): void {
    if (payload.event === 'tab.created') {
      void this.adoptCreatedTab(payload.instanceId, payload.tab);
      return;
    }
    if (payload.event === 'tab.removed') {
      this.removeTabByNative(payload.instanceId, payload.tabId);
      return;
    }
    if (payload.event === 'tab.updated') {
      this.updateTabByNative(payload.instanceId, payload.tab);
      return;
    }

    const record = Array.from(this.tabs.values()).find(
      (item) => item.instanceId === payload.instanceId && item.nativeTabId === payload.tabId,
    );
    if (!record) return;
    if (payload.event === 'debugger.detached') {
      record.sessionDead = true;
      record.session = null;
      record.sessionId = undefined;
      return;
    }
    for (const listener of record.listeners) {
      try {
        listener(payload.method, payload.params, payload.sessionId);
      } catch {
        // 单个监听器异常不影响其它监听器
      }
    }
  }

  /** 接管 click/window.open 产生的新标签页（有 AI opener 或处于点击后的短窗口） */
  private async adoptCreatedTab(instanceId: string, tab: NativeTabInfo): Promise<void> {
    if (tab.tabId < 0) return;
    const existing = this.findTabByNative(instanceId, tab.tabId);
    if (existing) {
      existing.url = tab.url || existing.url;
      existing.title = tab.title || existing.title;
      existing.active = tab.active;
      return;
    }
    let shouldAdopt = false;
    if (typeof tab.openerTabId === 'number') {
      shouldAdopt = this.findTabByNative(instanceId, tab.openerTabId) !== null;
    }
    const deadline = this.pendingNewTabUntil.get(instanceId) ?? 0;
    if (!shouldAdopt && deadline > Date.now()) shouldAdopt = true;
    if (!shouldAdopt) return;

    const cfg = this.getToolConfig();
    let groupId: number | null = null;
    try {
      const group = await this.bridge.send(
        instanceId,
        'groups.ensure',
        {
          tabId: tab.tabId,
          title: cfg.tabGroupTitle,
          color: cfg.tabGroupColor,
          legacyTitles: LEGACY_GROUP_TITLES,
        },
        10_000,
      );
      if (isRecord(group) && typeof group.groupId === 'number') groupId = group.groupId;
    } catch (err) {
      this.logger.warn(
        `[browser] 新标签页分组失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const info = this.bridge.getInstance(instanceId);
    const key = `t${++this.tabSeq}`;
    const record: TabRecord = {
      key,
      instanceId,
      kind: info?.kind === 'builtin' ? 'builtin' : 'external',
      browserName: info?.browserName ?? 'Chromium',
      browserVersion: info?.browserVersion ?? '',
      nativeTabId: tab.tabId,
      ...(tab.windowId >= 0 ? { windowId: tab.windowId } : {}),
      ...(typeof tab.openerTabId === 'number' ? { openerTabId: tab.openerTabId } : {}),
      groupId,
      session: null,
      sessionPromise: null,
      sessionDead: false,
      refs: new Map(),
      frameRefs: new Map(),
      dialogs: [],
      console: new ConsoleBuffer(),
      listeners: new Set(),
      sessionCleanup: [],
      frames: new Map(),
      url: tab.url,
      title: tab.title,
      active: tab.active,
      createdAt: Date.now(),
    };
    this.tabs.set(key, record);
    this.currentTabKey = key;
    this.lastTargetKey = instanceId;
    this.lastAdoptedTab = { instanceId, tab: key, at: Date.now() };
    this.pendingNewTabUntil.delete(instanceId);
    // 页面会话延迟到首次操作时建立：新标签页的 target 可能尚未就绪
    // 是否聚焦新标签页由工具层根据 auto_focus 决定（见 withOpenedTab 结果）。
  }

  private removeTabByNative(instanceId: string, nativeTabId: number): void {
    const record = this.findTabByNative(instanceId, nativeTabId);
    if (!record) return;
    this.rememberRetiredTab(record);
    record.sessionCleanup.splice(0).forEach((fn) => fn());
    record.console.dispose();
    record.listeners.clear();
    record.frames.clear();
    this.tabs.delete(record.key);
    if (this.currentTabKey === record.key) {
      const remaining = Array.from(this.tabs.values()).sort((a, b) => b.createdAt - a.createdAt)[0];
      this.currentTabKey = remaining?.key ?? null;
    }
  }

  private updateTabByNative(instanceId: string, tab: NativeTabInfo): void {
    const record = this.findTabByNative(instanceId, tab.tabId);
    if (!record) return;
    if (tab.url) record.url = tab.url;
    if (tab.title) record.title = tab.title;
    record.active = tab.active;
    if (tab.groupId >= 0) record.groupId = tab.groupId;
  }

  /** 扩展（重）连后恢复该实例此前创建的 AI 分组标签页 */
  private async adoptExistingTabs(instanceId: string): Promise<void> {
    const cfg = this.getToolConfig();
    let groups: unknown;
    let tabs: unknown;
    try {
      groups = await this.bridge.send(instanceId, 'groups.query', { title: cfg.tabGroupTitle }, 5000);
      tabs = await this.bridge.send(instanceId, 'tabs.list', {}, 5000);
    } catch {
      return;
    }
    if (!Array.isArray(groups)) return;
    const groupIds = new Set<number>();
    for (const group of groups) {
      if (isRecord(group) && typeof group.id === 'number') groupIds.add(group.id);
    }
    // 兼容旧「MOSS AI」分组：改名为新标题后接管
    if (groupIds.size === 0) {
      for (const legacyTitle of LEGACY_GROUP_TITLES) {
        if (legacyTitle === cfg.tabGroupTitle) continue;
        try {
          const legacy = await this.bridge.send(instanceId, 'groups.query', { title: legacyTitle }, 5000);
          if (!Array.isArray(legacy) || legacy.length === 0) continue;
          for (const group of legacy) {
            if (!isRecord(group) || typeof group.id !== 'number') continue;
            groupIds.add(group.id);
            await this.bridge
              .send(instanceId, 'groups.update', { groupId: group.id, title: cfg.tabGroupTitle }, 5000)
              .catch(() => undefined);
          }
          if (groupIds.size > 0) break;
        } catch {
          // 旧标题查询失败不影响新标题接管
        }
      }
    }
    if (!Array.isArray(tabs)) return;
    if (groupIds.size === 0) return;
    const info = this.bridge.getInstance(instanceId);
    const kind: BrowserInstanceKind = info?.kind === 'builtin' ? 'builtin' : 'external';
    for (const raw of tabs) {
      if (!isRecord(raw)) continue;
      const tabId = typeof raw.tabId === 'number' ? raw.tabId : -1;
      const groupId = typeof raw.groupId === 'number' ? raw.groupId : -1;
      if (tabId < 0 || !groupIds.has(groupId)) continue;
      if (this.findTabByNative(instanceId, tabId)) continue;
      const key = `t${++this.tabSeq}`;
      const record: TabRecord = {
        key,
        instanceId,
        kind,
        browserName: info?.browserName ?? 'Chromium',
        browserVersion: info?.browserVersion ?? '',
        nativeTabId: tabId,
        windowId: typeof raw.windowId === 'number' ? raw.windowId : undefined,
        groupId,
        session: null,
        sessionPromise: null,
        sessionDead: false,
        refs: new Map(),
        frameRefs: new Map(),
        dialogs: [],
        console: new ConsoleBuffer(),
        listeners: new Set(),
        sessionCleanup: [],
        frames: new Map(),
        url: typeof raw.url === 'string' ? raw.url : '',
        title: typeof raw.title === 'string' ? raw.title : '',
        active: raw.active === true,
        createdAt: Date.now(),
      };
      this.tabs.set(key, record);
      if (!this.currentTabKey) this.currentTabKey = key;
      this.lastTargetKey = instanceId;
    }
  }

  private findTabByNative(instanceId: string, nativeTabId: number): TabRecord | null {
    for (const record of this.tabs.values()) {
      if (record.instanceId === instanceId && record.nativeTabId === nativeTabId) return record;
    }
    return null;
  }

  /** 建页与「恢复已有 AI 标签页」并发时，移除同一原生标签的旧记录（保留本次新记录） */
  private removeDuplicateNativeTab(keep: TabRecord): void {
    if (keep.nativeTabId < 0) return;
    for (const [key, record] of Array.from(this.tabs.entries())) {
      if (key === keep.key) continue;
      if (record.instanceId !== keep.instanceId || record.nativeTabId !== keep.nativeTabId) continue;
      record.sessionCleanup.splice(0).forEach((fn) => fn());
      record.console.dispose();
      record.listeners.clear();
      record.frames.clear();
      this.tabs.delete(key);
      if (this.currentTabKey === key) this.currentTabKey = keep.key;
    }
  }

  private removeTabsOfInstance(instanceId: string): void {
    for (const [key, record] of Array.from(this.tabs.entries())) {
      if (record.instanceId !== instanceId) continue;
      this.rememberRetiredTab(record);
      record.sessionCleanup.splice(0).forEach((fn) => fn());
      record.console.dispose();
      record.listeners.clear();
      record.frames.clear();
      record.session = null;
      // 不 detach debugger：桥接断开不等于标签关闭。主动 detach 会让扩展的调试提示条
      // 反复消失/出现（页面闪白 + 失焦），由 Chrome 在标签真正关闭时自动回收。
      this.tabs.delete(key);
      if (this.currentTabKey === key) this.currentTabKey = null;
    }
    if (this.lastTargetKey === instanceId) this.lastTargetKey = null;
    if (!this.currentTabKey) {
      const remaining = Array.from(this.tabs.values()).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (remaining) this.currentTabKey = remaining.key;
    }
  }

  // ==========================================================================
  // 标签页
  // ==========================================================================

  private toTabInfo(record: TabRecord): BrowserTabInfo {
    const info = this.bridge.getInstance(record.instanceId);
    const kind: BrowserInstanceKind = info
      ? info.kind === 'builtin' || info.id === this.builtinInstanceId
        ? 'builtin'
        : 'external'
      : record.kind;
    return {
      tab: record.key,
      instanceId: record.instanceId,
      instanceKind: kind,
      browserName: info?.browserName ?? record.browserName,
      browserVersion: info?.browserVersion ?? record.browserVersion,
      nativeTabId: record.nativeTabId,
      ...(record.windowId !== undefined ? { windowId: record.windowId } : {}),
      groupId: record.groupId,
      url: record.url,
      title: record.title,
      active: record.active,
      createdAt: record.createdAt,
    };
  }

  private listTabInfos(): BrowserTabInfo[] {
    return Array.from(this.tabs.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => this.toTabInfo(record));
  }

  async listTabs(all = false, target?: BrowserTarget): Promise<BrowserTabInfo[]> {
    if (all) {
      const resolved = await this.resolveTarget(target);
      if (resolved.bridgeId) {
        const raw = await this.bridge.send(resolved.bridgeId, 'tabs.list', {}, 10_000);
        if (Array.isArray(raw)) {
          return raw
            .filter(isRecord)
            .map((item) => ({
              tab: `native:${String(item.tabId)}`,
              instanceId: resolved.key,
              instanceKind: resolved.kind,
              browserName: resolved.browserName,
              browserVersion: resolved.browserVersion,
              nativeTabId: typeof item.tabId === 'number' ? item.tabId : -1,
              ...(typeof item.windowId === 'number' ? { windowId: item.windowId } : {}),
              groupId: typeof item.groupId === 'number' && item.groupId >= 0 ? item.groupId : null,
              url: typeof item.url === 'string' ? item.url : '',
              title: typeof item.title === 'string' ? item.title : '',
              active: item.active === true,
              createdAt: Date.now(),
            }));
        }
      }
      return this.listTabInfos();
    }
    if (target) {
      const resolved = await this.resolveTarget(target);
      return this.listTabInfos().filter((item) => item.instanceId === resolved.key);
    }
    return this.listTabInfos();
  }

  async listNativeTabs(target?: BrowserTarget): Promise<NativeTabInfo[]> {
    const resolved = await this.resolveTarget(target);
    if (!resolved.bridgeId) return [];
    const raw = await this.bridge.send(resolved.bridgeId, 'tabs.list', {}, 10_000);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecord).map((item) => ({
      tabId: typeof item.tabId === 'number' ? item.tabId : -1,
      windowId: typeof item.windowId === 'number' ? item.windowId : -1,
      ...(typeof item.openerTabId === 'number' ? { openerTabId: item.openerTabId } : {}),
      groupId: typeof item.groupId === 'number' ? item.groupId : -1,
      url: typeof item.url === 'string' ? item.url : '',
      title: typeof item.title === 'string' ? item.title : '',
      active: item.active === true,
      status: typeof item.status === 'string' ? item.status : '',
      pinned: item.pinned === true,
    }));
  }

  async openTab(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    const cfg = this.getToolConfig();
    const focus = options.focus ?? cfg.autoFocus;
    const cdpEndpoint = options.cdpEndpoint?.trim();
    if (cdpEndpoint) await this.ensureCdp(cdpEndpoint);
    const resolved = await this.resolveTarget(cdpEndpoint ? 'cdp' : options.target);
    const timeout = Math.max(options.timeoutMs ?? cfg.timeoutMs, 30_000);
    const bridgePort = this.bridge.port;
    const marker = bridgePort
      ? `http://127.0.0.1:${bridgePort}/blank#moss-${randomUUID()}`
      : `about:blank#moss-${randomUUID()}`;
    let nativeTabId = -1;
    let windowId: number | undefined;
    let groupId: number | null = null;
    let targetId: string | undefined;
    let existingTargetIds: string[] = [];

    if (resolved.bridgeId) {
      if (resolved.kind === 'builtin') {
        existingTargetIds = (await this.builtin.listPageTargets()).map((item) => item.targetId);
      }
      // 外部浏览器：首次建页时新开后台 MOSS 窗口（focused:false），后续复用该窗口
      const created =
        resolved.kind === 'external'
          ? await this.ensureExternalMossTab(resolved.bridgeId, cfg, marker, timeout, focus)
          : null;
      const tab = created ?? (await this.createLegacyMossTab(resolved.bridgeId, marker, timeout, cfg, focus));
      nativeTabId = tab.tabId;
      if (tab.windowId !== undefined) windowId = tab.windowId;
      groupId = tab.groupId;
      if (resolved.kind === 'builtin') {
        const found = await this.builtin.findPageTargetByPrefix(marker, 5000);
        if (found) {
          targetId = found;
        } else {
          // fragment 可能被浏览器改写：用建页前后差集兜底
          const now = await this.builtin.listPageTargets();
          const createdTarget = now.find((item) => !existingTargetIds.includes(item.targetId));
          if (createdTarget) targetId = createdTarget.targetId;
        }
      }
    } else if (resolved.kind === 'cdp') {
      // 外部 CDP：优先新建标签页；Electron 等不支持 Target.createTarget 时附着已有页面
      targetId = await this.cdp.createPageTarget(marker).catch(() => undefined);
      if (!targetId) {
        const pages = await this.cdp.listPageTargets();
        const pick = pages.find((page) => !page.url.startsWith('devtools://')) ?? pages[0];
        if (!pick) throw new Error(t('browser.cdpNoTarget'));
        targetId = pick.targetId;
      }
    } else {
      targetId = await this.builtin.createPageTarget(marker);
    }

    const key = `t${++this.tabSeq}`;
    const record: TabRecord = {
      key,
      instanceId: resolved.key,
      kind: resolved.kind,
      browserName: resolved.browserName,
      browserVersion: resolved.browserVersion,
      nativeTabId,
      ...(windowId !== undefined ? { windowId } : {}),
      groupId,
      ...(targetId !== undefined ? { targetId } : {}),
      session: null,
      sessionPromise: null,
      sessionDead: false,
      refs: new Map(),
      frameRefs: new Map(),
      dialogs: [],
      console: new ConsoleBuffer(),
      listeners: new Set(),
      sessionCleanup: [],
      frames: new Map(),
      url: marker,
      title: '',
      active: true,
      createdAt: Date.now(),
    };
    this.tabs.set(key, record);
    this.removeDuplicateNativeTab(record);
    this.currentTabKey = key;
    this.lastTargetKey = resolved.key;

    // 先建立页面会话；失败不删除标签页（用户仍可在浏览器中看到它）
    try {
      await this.ensureTabSession(record);
    } catch (err) {
      this.logger.warn(`[browser] 标签页会话建立失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (options.url) {
      try {
        await this.navigate(key, { url: options.url, timeoutMs: options.timeoutMs });
      } catch (err) {
        // 导航失败时收掉 marker 占位页：否则它会一直以 http://127.0.0.1:7799/blank#moss-...
        // 出现在 tabs/导航结果里，模型下一次很容易继续操作这个空页。
        await this.closeTab(key).catch(() => undefined);
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`已创建标签页但导航失败：${detail}`);
      }
    } else {
      await this.refreshRecordInfo(record);
    }
    // 打开后聚焦：显式要求聚焦（focus=true）时才抬窗口；后台 open 不抢焦点
    if (focus) {
      await this.ensureFocused(key, { force: true, focusWindow: true }).catch(() => undefined);
    }
    return this.toTabInfo(record);
  }

  /**
   * 扩展 0.3.0+：在 MOSS 专属窗口建页并归组。
   * 旧扩展返回 Unknown command 时等待 reload 后重试，仍不支持则返回 null 交给旧流程兜底。
   */
  private async ensureExternalMossTab(
    bridgeId: string,
    cfg: BrowserToolConfig,
    marker: string,
    timeout: number,
    focus: boolean,
  ): Promise<{ tabId: number; windowId?: number; groupId: number | null; createdWindow: boolean } | null> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = await this.bridge.send(
          bridgeId,
          'windows.ensureMoss',
          {
            url: marker,
            active: focus,
            focus,
            title: cfg.tabGroupTitle,
            color: cfg.tabGroupColor,
            legacyTitles: LEGACY_GROUP_TITLES,
          },
          timeout,
        );
        if (!isRecord(raw) || typeof raw.tabId !== 'number') {
          throw new Error(t('browser.tabCreateFailed'));
        }
        return {
          tabId: raw.tabId,
          ...(typeof raw.windowId === 'number' ? { windowId: raw.windowId } : {}),
          groupId: typeof raw.groupId === 'number' ? raw.groupId : null,
          createdWindow: raw.createdWindow === true,
        };
      } catch (err) {
        lastError = err;
        const detail = err instanceof Error ? err.message : String(err);
        if (!/Unknown command/i.test(detail)) throw err;
        if (attempt < 2) await sleep(1000);
      }
    }
    this.logger.warn(
      `[browser] 扩展暂不支持 windows.ensureMoss（${lastError instanceof Error ? lastError.message : String(lastError)}），回退当前窗口建页`,
    );
    return null;
  }

  /** 旧建页流程：当前窗口 tabs.create + groups.ensure（内置 Chrome 与旧扩展共用） */
  private async createLegacyMossTab(
    bridgeId: string,
    marker: string,
    timeout: number,
    cfg: BrowserToolConfig,
    focus: boolean,
  ): Promise<{ tabId: number; windowId?: number; groupId: number | null }> {
    const created = await this.bridge.send(
      bridgeId,
      'tabs.create',
      { url: marker, active: focus, focus },
      timeout,
    );
    if (!isRecord(created) || typeof created.tabId !== 'number') {
      throw new Error(t('browser.tabCreateFailed'));
    }
    const result: { tabId: number; windowId?: number; groupId: number | null } = {
      tabId: created.tabId,
      groupId: null,
    };
    if (typeof created.windowId === 'number') result.windowId = created.windowId;
    try {
      const group = await this.bridge.send(
        bridgeId,
        'groups.ensure',
        {
          tabId: result.tabId,
          title: cfg.tabGroupTitle,
          color: cfg.tabGroupColor,
          legacyTitles: LEGACY_GROUP_TITLES,
        },
        timeout,
      );
      if (isRecord(group) && typeof group.groupId === 'number') result.groupId = group.groupId;
    } catch (err) {
      this.logger.warn(
        `[browser] AI 标签页分组失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return result;
  }

  async focusTab(tab?: string): Promise<BrowserTabInfo> {
    const result = await this.ensureFocused(tab, { force: true, focusWindow: true });
    return this.toTabInfo(await this.requireTab(result.tab));
  }

  /**
   * 聚焦目标标签页。
   * - 例行操作：focusWindow=false（默认）只把标签设为活动标签，不抬操作系统窗口，
   *   避免用户切回其他窗口后每次操作都把整个浏览器窗口闪到前台。
   * - 显式 focus/open：focusWindow=true 才调用 windows.update(focused:true)。
   * - 失败时回退到 opener 标签页 → 当前标签页（上一级窗口）。
   */
  async ensureFocused(
    tab?: string,
    options: { force?: boolean; focusWindow?: boolean } = {},
  ): Promise<BrowserFocusResult> {
    const focusWindow = options.focusWindow === true;
    const record = await this.requireTab(tab);
    const focusOne = async (target: TabRecord): Promise<boolean> => {
      if (target.kind === 'cdp') {
        if (!target.targetId) return false;
        // Target.activateTarget 会抬窗口：只有显式聚焦时才调用
        if (focusWindow) await this.cdp.activate(target.targetId);
        return true;
      }
      if (target.instanceId !== 'builtin' && target.nativeTabId >= 0) {
        try {
          await this.bridge.send(
            target.instanceId,
            'tabs.activate',
            { tabId: target.nativeTabId, focusWindow },
            10_000,
          );
          return true;
        } catch {
          // 扩展不可用：继续尝试内置 CDP
        }
      }
      if (target.targetId) {
        const cdp = this.builtin.getCdp();
        if (!cdp) return false;
        if (focusWindow) {
          await cdp.send('Target.activateTarget', { targetId: target.targetId });
        }
        return true;
      }
      return false;
    };

    let reason = '';
    try {
      if (await focusOne(record)) {
        record.active = true;
        this.currentTabKey = record.key;
        this.lastTargetKey = record.instanceId;
        return { tab: record.key, focused: true, fallback: false };
      }
      reason = '目标标签页不支持激活';
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    // 回退：弹窗/新标签页的 opener → 当前标签页（上一级窗口）
    const opener =
      record.openerTabId !== undefined
        ? this.findTabByNative(record.instanceId, record.openerTabId)
        : null;
    const current =
      this.currentTabKey && this.currentTabKey !== record.key
        ? this.tabs.get(this.currentTabKey) ?? null
        : null;
    const fallback = opener ?? current;
    if (fallback) {
      try {
        if (await focusOne(fallback)) {
          fallback.active = true;
          this.currentTabKey = fallback.key;
          this.lastTargetKey = fallback.instanceId;
          this.logger.warn(
            `[browser] 标签页 ${record.key} 无法聚焦，已回退到 ${fallback.key}（${reason}）`,
          );
          return { tab: record.key, focused: true, fallback: true, reason };
        }
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    return { tab: record.key, focused: false, fallback: false, reason };
  }

  async closeTab(tab?: string): Promise<void> {
    const record = await this.requireTab(tab);
    try {
      if (record.kind === 'cdp') {
        if (record.targetId) await this.cdp.closeTarget(record.targetId);
      } else if (record.instanceId !== 'builtin' && record.nativeTabId >= 0) {
        await this.bridge.send(record.instanceId, 'tabs.close', { tabId: record.nativeTabId }, 10_000);
      } else if (record.targetId) {
        const cdp = this.builtin.getCdp();
        await cdp?.send('Target.closeTarget', { targetId: record.targetId });
      }
    } catch {
      // 标签页可能已被用户关闭
    }
    // 标签关闭后浏览器会自动 detach debugger，无需再显式 detach（显式 detach 会触发额外闪屏）。
    record.sessionCleanup.splice(0).forEach((fn) => fn());
    record.console.dispose();
    record.listeners.clear();
    record.frames.clear();
    this.tabs.delete(record.key);
    if (this.currentTabKey === record.key) {
      const remaining = Array.from(this.tabs.values()).sort((a, b) => b.createdAt - a.createdAt)[0];
      this.currentTabKey = remaining?.key ?? null;
    }
  }

  /** 记录失效标签页的 URL，供后续按 URL 恢复同一个 tN key */
  private rememberRetiredTab(record: TabRecord): void {
    if (!record.url) return;
    this.retiredTabs.set(record.key, {
      key: record.key,
      instanceId: record.instanceId,
      nativeTabId: record.nativeTabId,
      url: record.url,
      title: record.title,
      at: Date.now(),
    });
    if (this.retiredTabs.size > 20) {
      const oldest = Array.from(this.retiredTabs.values()).sort((a, b) => a.at - b.at)[0];
      if (oldest) this.retiredTabs.delete(oldest.key);
    }
  }

  /**
   * 取标签页记录；key 失效时尝试在仍连接的原生标签页里按 URL 重新接管。
   * 这样扩展重连/标签被移动后，模型仍可继续使用 t1，而不是直接报「标签页不存在」。
   */
  private async requireTab(tab?: string): Promise<TabRecord> {
    const key = tab ?? this.currentTabKey;
    if (!key) throw new Error(t('browser.noTab'));
    const existing = this.tabs.get(key);
    if (existing) return existing;

    const retired = this.retiredTabs.get(key);
    if (retired) {
      const revived = await this.tryReviveTab(key, retired).catch(() => null);
      if (revived) return revived;
    }

    const available = this.tabs.size > 0 ? Array.from(this.tabs.keys()).join(', ') : '（无）';
    throw new Error(
      `${t('browser.tabNotFound', { tab: key })}；可用标签页：${available}。请执行 action=tabs 查看，或 action=open 重新打开。`,
    );
  }

  private async tryReviveTab(key: string, retired: RetiredTab): Promise<TabRecord | null> {
    const info = this.bridge.getInstance(retired.instanceId);
    if (!info) return null;
    const raw = await this.bridge.send(retired.instanceId, 'tabs.list', {}, 10_000);
    if (!Array.isArray(raw)) return null;
    const match = raw.filter(isRecord).find((item) => {
      const url = typeof item.url === 'string' ? item.url : '';
      if (!url || !retired.url) return false;
      // marker URL（.../blank#moss-<uuid>）必须精确匹配：同前缀会命中任意新建的空标签页，
      // 导致模型以为在操作原标签页、实际却导航到一个新的空页。
      const isMarker = retired.url.includes('#moss-');
      return url === retired.url || (!isMarker && url.startsWith(retired.url.split('#')[0]));
    });
    if (!match || typeof match.tabId !== 'number' || match.tabId < 0) return null;

    const record: TabRecord = {
      key,
      instanceId: retired.instanceId,
      kind: info.kind === 'builtin' ? 'builtin' : 'external',
      browserName: info.browserName,
      browserVersion: info.browserVersion,
      nativeTabId: match.tabId,
      ...(typeof match.windowId === 'number' && match.windowId >= 0
        ? { windowId: match.windowId }
        : {}),
      groupId: typeof match.groupId === 'number' ? match.groupId : null,
      session: null,
      sessionPromise: null,
      sessionDead: false,
      refs: new Map(),
      frameRefs: new Map(),
      dialogs: [],
      console: new ConsoleBuffer(),
      listeners: new Set(),
      sessionCleanup: [],
      frames: new Map(),
      url: typeof match.url === 'string' ? match.url : retired.url,
      title: typeof match.title === 'string' ? match.title : retired.title,
      active: match.active === true,
      createdAt: Date.now(),
    };
    this.tabs.set(key, record);
    this.currentTabKey = key;
    this.retiredTabs.delete(key);
    return record;
  }

  // ==========================================================================
  // 页面会话
  // ==========================================================================

  private async ensureTabSession(record: TabRecord): Promise<CdpSession> {
    if (record.session && !record.sessionDead) return record.session;
    if (record.sessionPromise) return record.sessionPromise;
    record.sessionPromise = this.createTabSession(record).finally(() => {
      record.sessionPromise = null;
    });
    return record.sessionPromise;
  }

  private async createTabSession(record: TabRecord): Promise<CdpSession> {
    // 新 session 的 focus emulation 状态未知：重置后由 enableFocusEmulation 重新启用一次
    record.focusEmulated = false;
    if (record.kind === 'cdp') {
      const connection = this.cdp.getCdp();
      if (!connection || connection.isClosed) throw new Error(t('browser.cdpNotConnected'));
      if (!record.targetId) throw new Error(t('browser.targetNotFound', { tab: record.key }));
      const sessionId = await this.cdp.attach(record.targetId);
      record.sessionId = sessionId;
      record.sessionDead = false;
      const session = new RelaySession(
        (method, params, childSessionId) => {
          const conn = this.cdp.getCdp();
          if (!conn) throw new Error(t('browser.cdpNotConnected'));
          return conn.send(method, params, childSessionId ?? sessionId);
        },
        (handler, childSessionId) => {
          const conn = this.cdp.getCdp();
          if (!conn) return () => {};
          const wanted = childSessionId ?? sessionId;
          return conn.onEvent((method, params, eventSessionId) => {
            if (eventSessionId === wanted) handler(method, params);
          });
        },
      );
      await enablePageDomains(session);
      record.session = session;
      record.console.attach(session);
      this.attachDialogAutoHandler(record, session);
      this.enableFocusEmulation(record, session);
      this.autoAttachFrames(record, session);
      return session;
    }

    if (record.kind === 'builtin' || record.instanceId === 'builtin') {
      const cdp = this.builtin.getCdp();
      if (!cdp) throw new Error(t('browser.builtinNotRunning'));
      if (!record.targetId) {
        // 恢复的标签页只有 nativeTabId/url：按 URL 匹配页面 target
        const found = record.url
          ? await this.builtin.findPageTargetByPrefix(record.url, 2000)
          : null;
        if (!found) throw new Error(t('browser.targetNotFound', { tab: record.key }));
        record.targetId = found;
      }
      const sessionId = await this.builtin.attach(record.targetId);
      record.sessionId = sessionId;
      record.sessionDead = false;
      const session = new RelaySession(
        (method, params, childSessionId) => {
          if (!this.builtin.getCdp()) throw new Error(t('browser.builtinNotRunning'));
          return this.builtin.getCdp()!.send(method, params, childSessionId ?? sessionId);
        },
        (handler, childSessionId) => {
          const connection = this.builtin.getCdp();
          if (!connection) return () => {};
          const wanted = childSessionId ?? sessionId;
          return connection.onEvent((method, params, eventSessionId) => {
            if (eventSessionId === wanted) handler(method, params);
          });
        },
      );
      await enablePageDomains(session);
      record.session = session;
      record.console.attach(session);
      this.attachDialogAutoHandler(record, session);
      this.enableFocusEmulation(record, session);
      this.autoAttachFrames(record, session);
      return session;
    }

    if (record.nativeTabId < 0) throw new Error(t('browser.targetNotFound', { tab: record.key }));
    await this.bridge.send(record.instanceId, 'debugger.attach', { tabId: record.nativeTabId }, 10_000);
    record.sessionDead = false;
    const session = new RelaySession(
      (method, params, childSessionId) =>
        this.bridge.send(
          record.instanceId,
          'debugger.send',
          {
            tabId: record.nativeTabId,
            method,
            params,
            ...(childSessionId ? { sessionId: childSessionId } : {}),
          },
          this.getToolConfig().timeoutMs,
        ),
      (handler, childSessionId) => {
        const wrapped = (
          method: string,
          params: unknown,
          eventSessionId?: string,
        ): void => {
          if (eventSessionId === childSessionId) handler(method, params);
        };
        record.listeners.add(wrapped);
        return () => record.listeners.delete(wrapped);
      },
    );
    await enablePageDomains(session);
    record.session = session;
    record.console.attach(session);
    this.attachDialogAutoHandler(record, session);
    this.enableFocusEmulation(record, session);
    this.autoAttachFrames(record, session);
    return session;
  }

  /** 每会话只启用一次 focus emulation（重复发送会让页面反复收到聚焦状态变化） */
  private enableFocusEmulation(record: TabRecord, session: CdpSession): void {
    if (record.focusEmulated) return;
    // 先置位避免并发重复发送；失败回滚，下次动作再试
    record.focusEmulated = true;
    void session
      .send('Emulation.setFocusEmulationEnabled', { enabled: true })
      .catch(() => {
        record.focusEmulated = false;
      });
  }

  /**
   * JavaScript 弹窗自动确认。
   * alert/confirm/prompt 打开后，CDP 命令会悬挂，页面文案（如「成功」）也读不到；
   * 这里统一 accept 并把文案记到 record.dialogs，下一次动作结果/快照回传给模型。
   */
  private attachDialogAutoHandler(record: TabRecord, session: CdpSession): void {
    const off = session.onEvent((method, params) => {
      if (method !== 'Page.javascriptDialogOpening' || !isRecord(params)) return;
      const type = typeof params.type === 'string' ? params.type : 'alert';
      const message = typeof params.message === 'string' ? params.message : '';
      const defaultPrompt = typeof params.defaultPrompt === 'string' ? params.defaultPrompt : '';
      record.dialogs.push(`${type}: ${message}`.trim());
      if (record.dialogs.length > 20) {
        record.dialogs.splice(0, record.dialogs.length - 20);
      }
      void session
        .send('Page.handleJavaScriptDialog', {
          accept: true,
          ...(type === 'prompt' ? { promptText: defaultPrompt } : {}),
        })
        .catch(() => undefined);
    });
    record.sessionCleanup.push(off);
  }

  /** 为一帧建立子会话（extension: debugger.send + sessionId；builtin/cdp: CdpConnection） */
  private createFrameSession(record: TabRecord, frame: FrameRecord, root: CdpSession): CdpSession {
    if (frame.session) return frame.session;
    if (frame.mode === 'context') {
      frame.session = new ContextFrameSession(root, frame);
      return frame.session;
    }
    if (record.kind === 'builtin' || record.instanceId === 'builtin') {
      const connection = this.builtin.getCdp();
      if (!connection) throw new Error(t('browser.builtinNotRunning'));
      const childSessionId = frame.sessionId;
      frame.session = new RelaySession(
        (method, params, sid) => connection.send(method, params, sid ?? childSessionId),
        (handler, sid) =>
          connection.onEvent((method, params, eventSessionId) => {
            if (eventSessionId === (sid ?? childSessionId)) handler(method, params);
          }),
      );
      // 子会话是独立 CDP session：AX/DOM 等域需要单独启用（失败不阻断输入转发）
      void enablePageDomains(frame.session).catch(() => undefined);
      return frame.session;
    }
    if (record.kind === 'cdp') {
      const connection = this.cdp.getCdp();
      if (!connection) throw new Error(t('browser.cdpNotConnected'));
      const childSessionId = frame.sessionId;
      frame.session = new RelaySession(
        (method, params, sid) => connection.send(method, params, sid ?? childSessionId),
        (handler, sid) =>
          connection.onEvent((method, params, eventSessionId) => {
            if (eventSessionId === (sid ?? childSessionId)) handler(method, params);
          }),
      );
      void enablePageDomains(frame.session).catch(() => undefined);
      return frame.session;
    }
    const childSessionId = frame.sessionId;
    frame.session = new RelaySession(
      (method, params, sid) =>
        this.bridge.send(
          record.instanceId,
          'debugger.send',
          {
            tabId: record.nativeTabId,
            method,
            params,
            ...(sid ? { sessionId: sid } : {}),
          },
          this.getToolConfig().timeoutMs,
        ),
      (handler, sid) => {
        const wrapped = (method: string, params: unknown, eventSessionId?: string): void => {
          if (eventSessionId === (sid ?? childSessionId)) handler(method, params);
        };
        record.listeners.add(wrapped);
        return () => record.listeners.delete(wrapped);
      },
    );
    void enablePageDomains(frame.session).catch(() => undefined);
    return frame.session;
  }

  /** 自动附着 iframe/OOPIF 子目标；失败只记录日志，不影响主页面操作 */
  private autoAttachFrames(record: TabRecord, session: CdpSession): void {
    void this.refreshFrames(record, session).catch(() => undefined);
    // 监听子目标创建/销毁（事件由根会话发出，sessionId 为 undefined）
    const off = session.onEvent((method, params) => {
      if (method === 'Page.frameNavigated' && isRecord(params) && isRecord(params.frame)) {
        const frame = params.frame;
        const frameId = typeof frame.id === 'string' ? frame.id : '';
        const parentId = typeof frame.parentId === 'string' ? frame.parentId : '';
        const url = typeof frame.url === 'string' ? frame.url : '';
        if (!parentId) {
          // 主 frame 导航：所有子 frame 记录整体失效。保留旧记录会让 auto 选中
          // 已不存在的 frameId，后续 createIsolatedWorld/输入全部落到空气里。
          for (const child of record.frames.values()) {
            if (child.mode === 'oopif' && child.sessionId) {
              void session
                .send('Target.detachFromTarget', { sessionId: child.sessionId })
                .catch(() => undefined);
            }
          }
          record.frames.clear();
          record.frameRefs.clear();
          record.focusEmulated = false;
          return;
        }
        // 子 frame 导航：更新 URL 并让旧的 isolated context/输入焦点失效
        for (const child of record.frames.values()) {
          if (child.frameId !== frameId && child.targetId !== frameId) continue;
          if (url) child.url = url;
          child.contextId = undefined;
          child.session = null;
          child.inputFocused = false;
          child.focusEmulated = false;
          record.frameRefs.clear();
        }
        return;
      }
      if (method === 'Target.attachedToTarget' && isRecord(params) && isRecord(params.targetInfo)) {
        const info = params.targetInfo;
        const targetId = typeof info.targetId === 'string' ? info.targetId : '';
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        if (!targetId || !sessionId) return;
        const type = typeof info.type === 'string' ? info.type : '';
        if (type !== 'iframe' && type !== 'page') return;
        record.frames.set(targetId, {
          frame: targetId,
          mode: 'oopif',
          frameId: targetId,
          targetId,
          sessionId,
          url: typeof info.url === 'string' ? info.url : '',
          title: typeof info.title === 'string' ? info.title : '',
          depth: 1,
          session: null,
        });
        return;
      }
      if (method === 'Target.detachedFromTarget' && isRecord(params)) {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        for (const [key, frame] of record.frames) {
          if (frame.sessionId === sessionId) record.frames.delete(key);
        }
      }
    });
    record.sessionCleanup.push(off);
  }

  private async attachFrameTarget(
    record: TabRecord,
    session: CdpSession,
    targetId: string,
    url: unknown,
    title: unknown,
  ): Promise<void> {
    if (record.frames.has(targetId)) return;
    try {
      const attached = await session.send<{ sessionId?: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      if (typeof attached.sessionId !== 'string' || !attached.sessionId) return;
      record.frames.set(targetId, {
        frame: targetId,
        mode: 'oopif',
        frameId: targetId,
        targetId,
        sessionId: attached.sessionId,
        url: typeof url === 'string' ? url : '',
        title: typeof title === 'string' ? title : '',
        depth: 1,
        session: null,
      });
    } catch {
      // 单个 frame attach 失败不阻断
    }
  }

  /** 重新枚举 iframe 子会话：优先独立 target（OOPIF），否则用同进程隔离上下文 */
  private async refreshFrames(record: TabRecord, session: CdpSession): Promise<void> {
    let autoAttachError = '';
    try {
      await session.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch (err) {
      autoAttachError = err instanceof Error ? err.message : String(err);
    }
    try {
      const rects = await this.topFrameRects(record);
      const rectByUrl = new Map(
        rects
          .filter((item) => item.src)
          .map((item) => [item.src.split('?')[0], item] as const),
      );

      // 1) 独立 target（跨站点 iframe / OOPIF）
      let targetCount = 0;
      let iframeTargets = 0;
      let liveTargetIds: Set<string> | null = null;
      try {
        const targets = await session.send<{ targetInfos?: Array<Record<string, unknown>> }>(
          'Target.getTargets',
          {},
        );
        targetCount = targets.targetInfos?.length ?? 0;
        const ids = new Set<string>();
        for (const info of targets.targetInfos ?? []) {
          if (!isRecord(info) || info.type !== 'iframe' || typeof info.targetId !== 'string') continue;
          iframeTargets += 1;
          ids.add(info.targetId);
          const url = typeof info.url === 'string' ? info.url : '';
          await this.attachFrameTarget(record, session, info.targetId, url, info.title);
        }
        // 只有确实返回了 iframe target 时才据此裁剪；部分扩展版本 Target.getTargets
        // 恒返回 0，此时不能把通过 attachedToTarget 拿到的 OOPIF 误删。
        if (iframeTargets > 0) liveTargetIds = ids;
      } catch {
        // Target 域不可用时依赖 frame tree
      }

      // 2) 同进程 iframe：Page.getFrameTree + Page.createIsolatedWorld
      const tree = await session.send<{ frameTree?: FrameTreeNode }>('Page.getFrameTree');
      const flat = flattenFrameTree(tree.frameTree);
      const liveFrameIds = new Set(flat.map((item) => item.id));
      // 清理已失效的 frame 记录：页面重载/子 frame 重建后 frameId 会变化，
      // 旧记录不删会让 auto 选到 stale frame（createIsolatedWorld: No frame for given id）。
      let pruned = 0;
      for (const [key, frame] of Array.from(record.frames)) {
        const contextStale = frame.mode === 'context' && !liveFrameIds.has(frame.frameId);
        const oopifStale =
          frame.mode === 'oopif' &&
          liveTargetIds !== null &&
          (!frame.targetId || !liveTargetIds.has(frame.targetId));
        if (contextStale || oopifStale) {
          record.frames.delete(key);
          pruned += 1;
        }
      }
      if (pruned > 0) record.frameRefs.clear();
      const parentById = new Map(flat.map((item) => [item.id, item.parentId] as const));
      for (const item of flat) {
        if (item.depth === 0) continue;
        const existing = Array.from(record.frames.values()).find(
          (frame) =>
            (frame.mode === 'oopif' && frame.url.split('?')[0] === item.url.split('?')[0]) ||
            (frame.mode === 'context' && frame.frameId === item.id),
        );
        // 顶层 iframe 的 rect 用于嵌套 frame 继承
        let topId = item.id;
        while (parentById.get(topId) && parentById.get(topId) !== tree.frameTree?.frame?.id) {
          topId = parentById.get(topId) ?? topId;
        }
        const topFrame = flat.find((frame) => frame.id === topId);
        const rectInfo = topFrame ? rectByUrl.get(topFrame.url.split('?')[0]) : undefined;
        if (existing) {
          existing.frameId = item.id;
          existing.depth = Math.max(existing.depth, item.depth);
          if (topFrame?.url) existing.topUrl = topFrame.url;
          if (rectInfo) existing.rect = rectInfo.rect;
          continue;
        }
        try {
          const created = await session.send<{ executionContextId?: number }>(
            'Page.createIsolatedWorld',
            { frameId: item.id, worldName: 'moss_frame' },
          );
          if (typeof created.executionContextId !== 'number') continue;
          record.frames.set(item.id, {
            frame: item.id,
            mode: 'context',
            frameId: item.id,
            contextId: created.executionContextId,
            url: item.url,
            title: item.name,
            depth: item.depth,
            ...(topFrame?.url ? { topUrl: topFrame.url } : {}),
            ...(rectInfo ? { rect: rectInfo.rect } : {}),
            session: null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // frame 在枚举后又被销毁：删掉对应记录，下一个 refresh 重建
          if (/No frame for given id|Cannot find.*frame/i.test(message)) {
            for (const [key, frame] of Array.from(record.frames)) {
              if (frame.mode === 'context' && frame.frameId === item.id) record.frames.delete(key);
            }
            record.frameRefs.clear();
          }
          // 跨进程 frame 若 createIsolatedWorld 失败，应由上面的 OOPIF target 覆盖
        }
      }

      this.logger.info('[browser] frames refresh', {
        tab: record.key,
        kind: record.kind,
        targetCount,
        iframeTargets,
        frameNodes: flat.length,
        attached: record.frames.size,
        pruned,
        iframeRects: rects.length,
        ...(autoAttachError ? { autoAttachError } : {}),
      });
    } catch (err) {
      this.logger.warn('[browser] frames refresh failed', {
        tab: record.key,
        kind: record.kind,
        error: err instanceof Error ? err.message : String(err),
        ...(autoAttachError ? { autoAttachError } : {}),
      });
    }
  }

  /** 顶层页面里的 iframe 布局信息（用于 auto 选择与截图回退） */
  private async topFrameRects(
    record: TabRecord,
  ): Promise<Array<{ src: string; rect: BrowserRect; active: boolean }>> {
    try {
      const session = await this.ensureTabSession(record);
      const result = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: `(() => {
          const list = Array.from(document.querySelectorAll('iframe'));
          return JSON.stringify(list.map((el) => {
            const r = el.getBoundingClientRect();
            return { src: el.src || '', x: r.x, y: r.y, width: r.width, height: r.height, active: document.activeElement === el };
          }));
        })()`,
        returnByValue: true,
      });
      const raw = result.result?.value;
      if (typeof raw !== 'string') return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRecord).map((item) => ({
        src: typeof item.src === 'string' ? item.src : '',
        rect: {
          x: typeof item.x === 'number' ? item.x : 0,
          y: typeof item.y === 'number' ? item.y : 0,
          width: typeof item.width === 'number' ? item.width : 0,
          height: typeof item.height === 'number' ? item.height : 0,
        },
        active: item.active === true,
      }));
    } catch {
      return [];
    }
  }

  /** 列出标签页内的 iframe / OOPIF 子会话 */
  async listFrames(tab: string | undefined): Promise<BrowserFrameInfo[]> {
    const record = await this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    await this.refreshFrames(record, session);
    const rects = await this.topFrameRects(record);
    const out: BrowserFrameInfo[] = [];
    for (const frame of record.frames.values()) {
      const topRect = rects.find(
        (item) =>
          frame.rect &&
          Math.abs(item.rect.x - frame.rect.x) < 1 &&
          Math.abs(item.rect.y - frame.rect.y) < 1 &&
          Math.abs(item.rect.width - frame.rect.width) < 1,
      );
      out.push({
        frame: frame.frame,
        frameId: frame.frameId,
        mode: frame.mode,
        ...(frame.targetId ? { targetId: frame.targetId } : {}),
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        ...(frame.contextId !== undefined ? { contextId: frame.contextId } : {}),
        url: frame.url,
        title: frame.title,
        active: topRect?.active === true,
        ...(frame.inputFocused ? { inputFocused: true } : {}),
        ...(frame.rect ? { rect: frame.rect } : {}),
      });
    }
    // 已获得键盘焦点的 frame 优先；其次 active；再次更深的 frame（游戏通常在最内层）
    return out.sort((a, b) => {
      const focusDiff = Number(b.inputFocused === true) - Number(a.inputFocused === true);
      if (focusDiff !== 0) return focusDiff;
      const activeDiff = Number(b.active) - Number(a.active);
      if (activeDiff !== 0) return activeDiff;
      const aRecord = record.frames.get(a.frame);
      const bRecord = record.frames.get(b.frame);
      return (bRecord?.depth ?? 0) - (aRecord?.depth ?? 0);
    });
  }

  /** 选择 iframe 子会话：auto / targetId / URL 子串；顶层返回 null */
  private async resolveFrame(
    record: TabRecord,
    frame: string | undefined,
  ): Promise<FrameRecord | null> {
    if (!frame || frame === 'all') return null;
    if (record.frames.size === 0) {
      const session = await this.ensureTabSession(record);
      await this.refreshFrames(record, session);
    }
    if (record.frames.size === 0) return null;
    const wanted = frame.trim();
    if (wanted !== 'auto') {
      const direct =
        record.frames.get(wanted) ??
        Array.from(record.frames.values()).find(
          (item) => item.frameId === wanted || item.targetId === wanted,
        );
      if (direct) return direct;
      const byUrl = Array.from(record.frames.values()).find((item) =>
        item.url.toLowerCase().includes(wanted.toLowerCase()),
      );
      if (byUrl) return byUrl;
      throw new Error(`未找到 iframe：${wanted}。可先执行 action=frames 查看可用 frame。`);
    }
    // auto 每次重新枚举：既清理 stale frame，也刷新 iframe 的当前 rect（页面滚动后坐标会变）。
    await this.refreshFrames(record, await this.ensureTabSession(record));
    const rects = await this.topFrameRects(record);
    const frames = Array.from(record.frames.values());
    const score = (item: FrameRecord): number => {
      const topRect = item.rect
        ? rects.find(
            (candidate) =>
              Math.abs(candidate.rect.x - item.rect!.x) < 1 &&
              Math.abs(candidate.rect.y - item.rect!.y) < 1 &&
              Math.abs(candidate.rect.width - item.rect!.width) < 1,
          )
        : undefined;
      const area = item.rect ? item.rect.width * item.rect.height : 0;
      return (
        (item.inputFocused ? 2_000_000 : 0) +
        (topRect?.active ? 1_000_000 : 0) +
        item.depth * 10_000 +
        area
      );
    };
    return frames.sort((a, b) => score(b) - score(a))[0] ?? null;
  }

  /** 取 frame 的会话（无 frame 时返回顶层会话；显式指定但不存在时报错，避免误发到父页面） */
  private async frameSession(
    record: TabRecord,
    frame: string | undefined,
  ): Promise<{ session: CdpSession; frame: FrameRecord | null }> {
    const root = await this.ensureTabSession(record);
    const resolved = await this.resolveFrame(record, frame);
    if (!resolved) {
      if (frame && frame !== 'auto' && frame !== 'all') {
        throw new Error(`未找到 iframe 子会话：${frame}。请先执行 action=frames 查看可用 frame。`);
      }
      return { session: root, frame: null };
    }
    // 后台标签页/窗口通常是 hidden+blur，游戏会暂停输入；让页面以为自己可见且聚焦。
    // 每会话只发一次，重复切换焦点状态会让页面/游戏出现重绘闪烁。
    if (resolved.mode === 'context') {
      this.enableFocusEmulation(record, root);
    }
    // 页面滚动/布局变化会让缓存的 iframe rect 过期；坐标动作前按 topUrl 重新定位
    await this.refreshFrameRect(record, resolved);
    const child = this.createFrameSession(record, resolved, root);
    if (child !== root && !resolved.focusEmulated) {
      resolved.focusEmulated = true;
      void child
        .send('Emulation.setFocusEmulationEnabled', { enabled: true })
        .catch(() => {
          resolved.focusEmulated = false;
        });
    }
    return { session: child, frame: resolved };
  }

  /** 刷新单个 frame 的顶层 iframe 矩形（页面滚动/布局变化后坐标会漂移） */
  private async refreshFrameRect(record: TabRecord, frame: FrameRecord): Promise<void> {
    if (!frame.rect && !frame.topUrl) return;
    try {
      const rects = await this.topFrameRects(record);
      const topKey = frame.topUrl?.split('?')[0];
      const match =
        (topKey ? rects.find((item) => item.src && item.src.split('?')[0] === topKey) : undefined) ??
        rects.find(
          (item) =>
            frame.rect &&
            Math.abs(item.rect.x - frame.rect.x) < 1 &&
            Math.abs(item.rect.y - frame.rect.y) < 1 &&
            Math.abs(item.rect.width - frame.rect.width) < 1,
        ) ??
        (rects.length === 1 ? rects[0] : undefined);
      if (match) frame.rect = match.rect;
    } catch {
      // 页面切换/销毁瞬间读取失败：保留旧 rect，由后续 refresh 修正
    }
  }

  /**
   * 跨域 iframe 快照的 ref 路由：f1:e3 → 对应子会话 + 仅含该 ref 的本地 refs 表。
   * 未命中前缀返回 null，调用方继续按顶层/frame 参数处理。
   */
  private async routeFrameRef(
    record: TabRecord,
    ref: string,
  ): Promise<{ session: CdpSession; refs: Map<string, number>; frame: FrameRecord } | null> {
    const hit = record.frameRefs.get(ref);
    if (!hit) return null;
    const frame = record.frames.get(hit.frame);
    if (!frame) return null;
    const root = await this.ensureTabSession(record);
    const session = this.createFrameSession(record, frame, root);
    return { session, refs: new Map([[ref, hit.backendNodeId]]), frame };
  }

  private async refreshRecordInfo(record: TabRecord): Promise<void> {
    try {
      const session = await this.ensureTabSession(record);
      const info = await getPageInfo(session);
      if (info.url) record.url = info.url;
      if (info.title) record.title = info.title;
    } catch {
      // 页面可能仍在加载
    }
  }

  private pageResult(record: TabRecord): BrowserPageInfo {
    // 弹窗只回传一次：模型需要在动作结果里看到 alert/confirm 的文案（如「成功」），
    // 而不是靠人工点确认后再去猜。
    const dialogs = record.dialogs.splice(0);
    return {
      tab: record.key,
      url: record.url,
      title: record.title,
      ...(dialogs.length > 0 ? { dialogs } : {}),
    };
  }

  /** click/press_key 后若自动接管了新标签页，附加到返回值 */
  private withOpenedTab(
    info: BrowserPageInfo,
    instanceId: string,
    since: number,
  ): BrowserPageInfo {
    const adopted = this.lastAdoptedTab;
    if (!adopted || adopted.instanceId !== instanceId || adopted.at < since) return info;
    const record = this.tabs.get(adopted.tab);
    if (!record) return info;
    return {
      ...info,
      openedTab: { tab: record.key, url: record.url, title: record.title },
    };
  }

  // ==========================================================================
  // 页面操作
  // ==========================================================================

  async navigate(tab: string | undefined, options: BrowserNavigateOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    const cfg = this.getToolConfig();
    const result = await navigatePage(session, options, {
      timeoutMs: options.timeoutMs ?? cfg.timeoutMs,
      maxSnapshotNodes: cfg.maxSnapshotNodes,
      maxImageDimension: cfg.maxImageDimension,
      allowEvaluate: cfg.allowEvaluate,
    });
    record.url = result.info.url || record.url;
    record.title = result.info.title || record.title;
    record.refs.clear();
    this.currentTabKey = record.key;
    return { ...this.pageResult(record), ...(result.loading ? { loading: true } : {}) };
  }

  async snapshot(tab: string | undefined, maxNodes?: number): Promise<BrowserSnapshot> {
    const record = await this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    const cfg = this.getToolConfig();
    const budget = Math.max(50, maxNodes ?? cfg.maxSnapshotNodes);
    const tree = await buildSnapshot(session, budget);
    record.refs = tree.refs;
    record.frameRefs.clear();

    // 跨域 iframe（OOPIF）的可访问性树不在顶层 AX 树中：按需合并子会话快照，
    // 并用 fN:eM 前缀把 ref 路由回对应子会话，模型可直接点击/输入。
    if (record.frames.size === 0) {
      await this.refreshFrames(record, session);
    }
    const frameSections: string[] = [];
    const frameLegend: string[] = [];
    const oopifFrames = Array.from(record.frames.values()).filter((frame) => frame.mode === 'oopif');
    const frameBudget = Math.max(60, Math.floor(budget / 2));
    for (let index = 0; index < oopifFrames.length && index < 3; index += 1) {
      const frame = oopifFrames[index];
      const label = `f${index + 1}`;
      const rect = frame.rect
        ? ` rect=(${Math.round(frame.rect.x)},${Math.round(frame.rect.y)},${Math.round(frame.rect.width)},${Math.round(frame.rect.height)})`
        : '';
      try {
        const child = this.createFrameSession(record, frame, session);
        // 子会话是独立 CDP session：必须单独启用 Accessibility 域
        await enablePageDomains(child);
        const sub = await buildSnapshot(child, frameBudget, { refPrefix: `${label}:` });
        if (!sub.text.trim()) continue;
        frameSections.push(`--- iframe ${label}${rect} ${frame.url} ---\n${sub.text}`);
        for (const [ref, backendNodeId] of sub.refs) {
          record.frameRefs.set(ref, { frame: frame.frame, backendNodeId });
        }
        frameLegend.push(`- ${label}${rect} ${frame.url}`);
      } catch (err) {
        frameSections.push(
          `--- iframe ${label}${rect} ${frame.url} ---\n（该 iframe 读取失败：${
            err instanceof Error ? err.message : String(err)
          }）`,
        );
      }
    }

    await this.refreshRecordInfo(record);
    this.currentTabKey = record.key;
    const dialogs = record.dialogs.splice(0);
    const dialogLines = dialogs.length > 0 ? `\n弹窗（已自动确认）：\n${dialogs.map((item) => `- ${item}`).join('\n')}\n` : '';
    const frameHint =
      frameLegend.length > 0
        ? `IFRAMES（ref 前缀 fN:M 可直接用于 click/type/select/hover/scroll）：\n${frameLegend.join('\n')}\n`
        : '';
    const header = `URL: ${record.url}\nTITLE: ${record.title}\n${dialogLines}${frameHint}`;
    const body = tree.text || t('browser.snapshotEmpty');
    const merged = `${header}\n${body}${frameSections.length > 0 ? `\n\n${frameSections.join('\n\n')}` : ''}${
      tree.truncated ? `\n\n${t('browser.snapshotTruncated')}` : ''
    }`;
    return {
      tab: record.key,
      url: record.url,
      title: record.title,
      text: merged,
      refCount: tree.refCount + record.frameRefs.size,
      truncated: tree.truncated || frameSections.some((section) => section.includes('已截断')),
    };
  }

  async screenshot(
    tab: string | undefined,
    options: { fullPage?: boolean; frame?: string; region?: BrowserRect } = {},
  ): Promise<BrowserScreenshot> {
    const record = await this.requireTab(tab);
    const cfg = this.getToolConfig();
    const { session, frame } = await this.frameSession(record, options.frame);
    let shot: ScreenshotResult;
    try {
      shot = await captureScreenshot(
        session,
        options.fullPage === true,
        cfg.maxImageDimension,
        options.region ? { region: options.region } : {},
      );
    } catch (err) {
      if (!frame) throw err;
      // iframe 子会话不支持 Page.captureScreenshot 时：截顶层并按 iframe rect 裁剪
      const rects = await this.topFrameRects(record);
      const rect =
        rects.find(
          (item) => item.src && frame.url && item.src.split('?')[0] === frame.url.split('?')[0],
        ) ??
        rects
          .filter((item) => item.rect.width > 0 && item.rect.height > 0)
          .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
      if (!rect) throw err;
      const root = await this.ensureTabSession(record);
      shot = await captureScreenshot(root, false, cfg.maxImageDimension, { region: rect.rect });
    }
    const path = newScreenshotPath(this.dirs, record.key);
    await Bun.write(path, shot.buffer);
    pruneScreenshots(this.dirs);
    await this.refreshRecordInfo(record);
    record.lastShot = {
      ...(shot.width !== undefined ? { imageWidth: shot.width } : {}),
      ...(shot.height !== undefined ? { imageHeight: shot.height } : {}),
      ...(shot.viewportWidth !== undefined ? { viewportWidth: shot.viewportWidth } : {}),
      ...(shot.viewportHeight !== undefined ? { viewportHeight: shot.viewportHeight } : {}),
      ...(shot.scale !== undefined ? { scale: shot.scale } : {}),
      ...(frame ? { frame: frame.frame } : {}),
      ...(shot.region ? { region: shot.region } : {}),
    };
    return {
      path,
      data: shot.buffer.toString('base64'),
      mimeType: 'image/png',
      ...(shot.width !== undefined ? { width: shot.width } : {}),
      ...(shot.height !== undefined ? { height: shot.height } : {}),
      ...(shot.viewportWidth !== undefined ? { viewportWidth: shot.viewportWidth } : {}),
      ...(shot.viewportHeight !== undefined ? { viewportHeight: shot.viewportHeight } : {}),
      ...(shot.dpr !== undefined ? { dpr: shot.dpr } : {}),
      ...(shot.scale !== undefined ? { scale: shot.scale } : {}),
      ...(frame ? { frame: frame.frame } : {}),
      ...(shot.region ? { region: shot.region } : {}),
    };
  }

  async click(tab: string | undefined, options: BrowserClickOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    // snapshot 合并的跨域 iframe ref（f1:e3）优先路由到对应子会话
    const routed = options.ref ? await this.routeFrameRef(record, options.ref) : null;
    const { session, frame } = routed ?? (await this.frameSession(record, options.frame));
    if (frame && options.selector) {
      throw new Error('frame 内点击请使用 ref 或 x/y 坐标（frame 内 CSS 像素）；selector 仅适用于顶层页面');
    }
    const refs = routed ? routed.refs : record.refs;
    let x = options.x;
    let y = options.y;
    if (typeof x === 'number' && typeof y === 'number' && options.coordSpace === 'screenshot') {
      const shot = record.lastShot;
      const scale =
        shot && shot.imageWidth && shot.viewportWidth && shot.viewportWidth > 0
          ? shot.imageWidth / shot.viewportWidth
          : shot?.scale;
      if (!scale || scale <= 0) {
        throw new Error('尚未截图，无法使用 coord_space=screenshot；请先执行 action=screenshot');
      }
      x = x / scale;
      y = y / scale;
    }
    const started = Date.now();
    this.pendingNewTabUntil.set(record.instanceId, started + 2500);
    await clickElement(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      ...(typeof x === 'number' ? { x } : {}),
      ...(typeof y === 'number' ? { y } : {}),
      ...(options.button ? { button: options.button } : {}),
      ...(options.clickCount !== undefined ? { clickCount: options.clickCount } : {}),
      ...(options.modifiers ? { modifiers: options.modifiers } : {}),
    }, refs);
    // 真实鼠标点击会把焦点送进 iframe（canvas），键盘输入可直接转发
    if (frame) frame.inputFocused = true;
    await this.refreshRecordInfo(record);
    return this.withOpenedTab(this.pageResult(record), record.instanceId, started);
  }

  async hover(tab: string | undefined, options: BrowserHoverOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const routed = options.ref ? await this.routeFrameRef(record, options.ref) : null;
    const session = routed?.session ?? (await this.ensureTabSession(record));
    await hoverElement(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
    }, routed?.refs ?? record.refs);
    return this.pageResult(record);
  }

  async typeText(tab: string | undefined, options: BrowserTypeOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const routed = options.ref ? await this.routeFrameRef(record, options.ref) : null;
    const session = routed?.session ?? (await this.ensureTabSession(record));
    await typeInto(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      text: options.text,
      ...(options.replace !== undefined ? { replace: options.replace } : {}),
      ...(options.submit !== undefined ? { submit: options.submit } : {}),
    }, routed?.refs ?? record.refs);
    // typeInto 已对目标元素执行 DOM.focus：键盘输入可直接发送到该 frame
    if (routed) routed.frame.inputFocused = true;
    await this.refreshRecordInfo(record);
    return this.pageResult(record);
  }

  async pressKey(tab: string | undefined, options: BrowserPressKeyOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const { session } = await this.frameSession(record, options.frame);
    const started = Date.now();
    this.pendingNewTabUntil.set(record.instanceId, started + 2500);
    await pressKey(session, options.key, options.modifiers);
    await this.refreshRecordInfo(record);
    return this.withOpenedTab(this.pageResult(record), record.instanceId, started);
  }

  async keyDown(
    tab: string | undefined,
    key: string,
    options: { frame?: string; modifiers?: string[] } = {},
  ): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const { session } = await this.frameSession(record, options.frame);
    await dispatchKeyDown(session, key, options.modifiers);
    this.currentTabKey = record.key;
    return this.pageResult(record);
  }

  async keyUp(
    tab: string | undefined,
    key: string,
    options: { frame?: string; modifiers?: string[] } = {},
  ): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const { session } = await this.frameSession(record, options.frame);
    await dispatchKeyUp(session, key, options.modifiers);
    this.currentTabKey = record.key;
    return this.pageResult(record);
  }

  async hold(tab: string | undefined, options: BrowserHoldOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const { session } = await this.frameSession(record, options.frame);
    await holdKeys(session, options.keys, options.durationMs, options.modifiers);
    this.currentTabKey = record.key;
    return this.pageResult(record);
  }

  /**
   * 单次调用内执行有先后顺序/等待的输入宏：把「按住 → 等待 → 抬起 → 观察」压进一次往返。
   * 支持 key_down/key_up/hold/press_key/click/drag/scroll/wait/screenshot/wait_stable/wait_change。
   */
  async macro(
    tab: string | undefined,
    steps: BrowserMacroStep[],
    options: { verify?: boolean } = {},
  ): Promise<BrowserMacroResult> {
    const record = await this.requireTab(tab);
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('macro 需要至少一个步骤');
    if (steps.length > 32) throw new Error('macro 最多 32 个步骤');
    const started = Date.now();
    const results: BrowserMacroStepResult[] = [];
    let lastScreenshot: BrowserScreenshot | undefined;
    let signatureBefore: FrameSignature | null = null;
    if (options.verify !== false) {
      try {
        const { session } = await this.frameSession(record, undefined);
        signatureBefore = await frameSignature(session);
      } catch {
        signatureBefore = null;
      }
    }

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const action = typeof step.action === 'string' ? step.action : '';
      const stepStarted = Date.now();
      try {
        if (!action) throw new Error('步骤缺少 action');
        switch (action) {
          case 'wait': {
            const ms = Math.max(0, Math.min(5000, Math.trunc(Number(step.wait_ms ?? step.ms ?? 0) || 0)));
            await sleep(ms);
            results.push({ index, action, ok: true, durationMs: Date.now() - stepStarted, detail: `wait ${ms}ms` });
            break;
          }
          case 'key_down':
            await this.keyDown(record.key, String(step.key ?? ''), {
              ...(typeof step.frame === 'string' ? { frame: step.frame } : {}),
              ...(Array.isArray(step.modifiers) ? { modifiers: step.modifiers.map(String) } : {}),
            });
            results.push({ index, action, ok: true, durationMs: Date.now() - stepStarted });
            break;
          case 'key_up':
            await this.keyUp(record.key, String(step.key ?? ''), {
              ...(typeof step.frame === 'string' ? { frame: step.frame } : {}),
              ...(Array.isArray(step.modifiers) ? { modifiers: step.modifiers.map(String) } : {}),
            });
            results.push({ index, action, ok: true, durationMs: Date.now() - stepStarted });
            break;
          case 'hold': {
            const keys = Array.isArray(step.keys)
              ? step.keys.map(String)
              : typeof step.key === 'string'
                ? [step.key]
                : [];
            await this.hold(record.key, {
              keys,
              durationMs: Math.max(0, Math.min(5000, Math.trunc(Number(step.duration_ms ?? 0) || 0))),
              ...(typeof step.frame === 'string' ? { frame: step.frame } : {}),
              ...(Array.isArray(step.modifiers) ? { modifiers: step.modifiers.map(String) } : {}),
            });
            results.push({ index, action, ok: true, durationMs: Date.now() - stepStarted });
            break;
          }
          case 'press_key':
            await this.pressKey(record.key, {
              key: String(step.key ?? ''),
              ...(typeof step.frame === 'string' ? { frame: step.frame } : {}),
              ...(Array.isArray(step.modifiers) ? { modifiers: step.modifiers.map(String) } : {}),
            });
            results.push({ index, action, ok: true, durationMs: Date.now() - stepStarted });
            break;
          case 'click':
            await this.click(record.key, {
              ...(typeof step.ref === 'string' ? { ref: step.ref } : {}),
              ...(typeof step.selector === 'string' ? { selector: step.selector } : {}),
              ...(typeof step.x === 'number' ? { x: step.x } : {}),
              ...(typeof step.y === 'number' ? { y: step.y } : {}),
              ...(typeof step.frame === 'string' ? { frame: step.frame } : {}),
              ...(step.coord_space === 'screenshot' ? { coordSpace: 'screenshot' } : {}),
              ...(step.button === 'left' || step.button === 'right' || step.button === 'middle'
                ? { button: step.button }
                : {}),
              ...(typeof step.click_count === 'number' ? { clickCount: step.click_count } : {}),
            });
            results.push({ index, action, ok: true, durationMs: Date.now() - stepStarted });
            break;
          case 'scroll':
            await this.scroll(record.key, {
              deltaX: typeof step.delta_x === 'number' ? step.delta_x : 0,
              deltaY: typeof step.delta_y === 'number' ? step.delta_y : 600,
            });
            results.push({ index, action, ok: true, durationMs: Date.now() - stepStarted });
            break;
          case 'screenshot': {
            lastScreenshot = await this.screenshot(record.key, {
              ...(typeof step.frame === 'string' ? { frame: step.frame } : {}),
              ...(isRecord(step.region) ? { region: step.region as unknown as BrowserRect } : {}),
            });
            results.push({
              index,
              action,
              ok: true,
              durationMs: Date.now() - stepStarted,
              detail: lastScreenshot.path,
            });
            break;
          }
          case 'wait_stable':
          case 'wait_change': {
            const { session } = await this.frameSession(
              record,
              typeof step.frame === 'string' ? step.frame : undefined,
            );
            const waitOptions = {
              ...(isRecord(step.region) ? { region: step.region as unknown as BrowserRect } : {}),
              ...(typeof step.timeout_ms === 'number' ? { timeoutMs: step.timeout_ms } : {}),
              ...(typeof step.interval_ms === 'number' ? { intervalMs: step.interval_ms } : {}),
              ...(typeof step.threshold === 'number' ? { threshold: step.threshold } : {}),
              ...(typeof step.stable_samples === 'number' ? { stableSamples: step.stable_samples } : {}),
            };
            const waited =
              action === 'wait_stable'
                ? await waitFrameStable(session, waitOptions)
                : await waitFrameChange(session, waitOptions);
            results.push({
              index,
              action,
              ok: waited.matched,
              durationMs: Date.now() - stepStarted,
              detail: `${waited.reason} diff=${waited.diffPercent}% samples=${waited.samples}`,
              ...(waited.matched ? {} : { error: '等待超时' }),
            });
            break;
          }
          default:
            throw new Error(`macro 不支持的步骤：${action}`);
        }
      } catch (err) {
        results.push({
          index,
          action: action || `#${index}`,
          ok: false,
          durationMs: Date.now() - stepStarted,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    let effect: BrowserMacroResult['effect'] = 'unknown';
    let diff = undefined as number | undefined;
    if (signatureBefore) {
      try {
        const { session } = await this.frameSession(record, undefined);
        const after = await frameSignature(session);
        diff = diffPercent(signatureBefore, after);
        effect = diff > 1.5 ? 'changed' : 'no-change';
      } catch {
        effect = 'unknown';
      }
    }
    return {
      steps: results,
      elapsedMs: Date.now() - started,
      effect,
      ...(diff !== undefined ? { diffPercent: diff } : {}),
      ...(lastScreenshot ? { lastScreenshot } : {}),
    };
  }

  async selectOption(tab: string | undefined, options: BrowserSelectOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const routed = options.ref ? await this.routeFrameRef(record, options.ref) : null;
    const session = routed?.session ?? (await this.ensureTabSession(record));
    await selectOption(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      values: options.values,
    }, routed?.refs ?? record.refs);
    if (routed) routed.frame.inputFocused = true;
    await this.refreshRecordInfo(record);
    return this.pageResult(record);
  }

  async scroll(tab: string | undefined, options: BrowserScrollOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const routed = options.ref ? await this.routeFrameRef(record, options.ref) : null;
    const session = routed?.session ?? (await this.ensureTabSession(record));
    await scrollPage(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.deltaX !== undefined ? { deltaX: options.deltaX } : {}),
      ...(options.deltaY !== undefined ? { deltaY: options.deltaY } : {}),
    }, routed?.refs ?? record.refs);
    await this.refreshRecordInfo(record);
    return this.pageResult(record);
  }

  async drag(tab: string | undefined, options: BrowserDragOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const hasFrom = Boolean(
      options.fromRef ||
        options.fromSelector ||
        (typeof options.fromX === 'number' && typeof options.fromY === 'number'),
    );
    const hasTo = Boolean(
      options.toRef ||
        options.toSelector ||
        (typeof options.toX === 'number' && typeof options.toY === 'number'),
    );
    if (!hasFrom || !hasTo) throw new Error(t('browserTool.dragNeedsOption'));
    const session = await this.ensureTabSession(record);
    const started = Date.now();
    this.pendingNewTabUntil.set(record.instanceId, started + 2500);
    await dragElement(
      session,
      {
        ...(options.fromRef ? { fromRef: options.fromRef } : {}),
        ...(options.fromSelector ? { fromSelector: options.fromSelector } : {}),
        ...(typeof options.fromX === 'number' ? { fromX: options.fromX } : {}),
        ...(typeof options.fromY === 'number' ? { fromY: options.fromY } : {}),
        ...(options.toRef ? { toRef: options.toRef } : {}),
        ...(options.toSelector ? { toSelector: options.toSelector } : {}),
        ...(typeof options.toX === 'number' ? { toX: options.toX } : {}),
        ...(typeof options.toY === 'number' ? { toY: options.toY } : {}),
        ...(options.button ? { button: options.button } : {}),
        ...(typeof options.steps === 'number' ? { steps: options.steps } : {}),
        ...(typeof options.durationMs === 'number' ? { durationMs: options.durationMs } : {}),
      },
      record.refs,
    );
    await this.refreshRecordInfo(record);
    return this.withOpenedTab(this.pageResult(record), record.instanceId, started);
  }

  async evaluate(
    tab: string | undefined,
    options: BrowserEvaluateOptions,
  ): Promise<{ result: string; type: string }> {
    const record = await this.requireTab(tab);
    const { session } = await this.frameSession(record, options.frame);
    const cfg = this.getToolConfig();
    return evaluateExpression(session, options.expression, cfg.allowEvaluate);
  }

  async waitFor(tab: string | undefined, options: BrowserWaitOptions): Promise<BrowserPageInfo> {
    const record = await this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    const cfg = this.getToolConfig();
    await waitCondition(session, {
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.text ? { text: options.text } : {}),
    }, {
      timeoutMs: options.timeoutMs ?? cfg.timeoutMs,
      maxSnapshotNodes: cfg.maxSnapshotNodes,
      maxImageDimension: cfg.maxImageDimension,
      allowEvaluate: cfg.allowEvaluate,
    });
    await this.refreshRecordInfo(record);
    return this.pageResult(record);
  }

  async waitStable(
    tab: string | undefined,
    options: BrowserFrameWaitOptions,
  ): Promise<BrowserFrameWaitResult> {
    const record = await this.requireTab(tab);
    const { session, frame } = await this.frameSession(record, options.frame);
    const result = await waitFrameStable(session, {
      ...(options.region ? { region: options.region } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      ...(options.stableSamples !== undefined ? { stableSamples: options.stableSamples } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ...result, ...(frame ? { frame: frame.frame } : {}) };
  }

  async waitChange(
    tab: string | undefined,
    options: BrowserFrameWaitOptions,
  ): Promise<BrowserFrameWaitResult> {
    const record = await this.requireTab(tab);
    const { session, frame } = await this.frameSession(record, options.frame);
    const result = await waitFrameChange(session, {
      ...(options.region ? { region: options.region } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      ...(options.stableSamples !== undefined ? { stableSamples: options.stableSamples } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ...result, ...(frame ? { frame: frame.frame } : {}) };
  }

  async consoleLogs(tab: string | undefined, clear?: boolean): Promise<BrowserConsoleResult> {
    const record = await this.requireTab(tab);
    await this.ensureTabSession(record);
    return { entries: record.console.list(clear === true), cleared: clear === true };
  }

  /** 供工具层读取内置 Chrome 的 CDP（测试/调试用） */
  getBuiltinCdp(): CdpConnection | null {
    return this.builtin.getCdp();
  }
}
