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
  dragElement,
  enablePageDomains,
  evaluateExpression,
  getPageInfo,
  hoverElement,
  navigatePage,
  pressKey,
  scrollPage,
  selectOption,
  typeInto,
  waitCondition,
  type CdpSession,
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
  BrowserHoverOptions,
  BrowserInstanceInfo,
  BrowserInstanceKind,
  BrowserInstallerStatus,
  BrowserMode,
  BrowserNavigateOptions,
  BrowserOpenOptions,
  BrowserPageInfo,
  BrowserPressKeyOptions,
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

interface TabRecord {
  key: string;
  instanceId: string;
  kind: BrowserInstanceKind;
  browserName: string;
  browserVersion: string;
  nativeTabId: number;
  windowId?: number;
  groupId: number | null;
  targetId?: string;
  sessionId?: string;
  session: CdpSession | null;
  sessionPromise: Promise<CdpSession> | null;
  sessionDead: boolean;
  refs: Map<string, number>;
  console: ConsoleBuffer;
  listeners: Set<(method: string, params: unknown) => void>;
  url: string;
  title: string;
  active: boolean;
  createdAt: number;
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
    private readonly sendFn: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private readonly onEventFn: (handler: (method: string, params: unknown) => void) => () => void,
  ) {}

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.sendFn(method, params)) as T;
  }

  onEvent(handler: (method: string, params: unknown) => void): () => void {
    return this.onEventFn(handler);
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
  private tabSeq = 0;
  private currentTabKey: string | null = null;
  private lastTargetKey: string | null = null;
  private builtinInstanceId: string | null = null;
  private builtinError: string | null = null;
  /** 每个实例的「刚执行过 click/press_key」窗口，用于接管无 opener 的新标签页 */
  private readonly pendingNewTabUntil = new Map<string, number>();
  /** 最近自动接管的新标签页（供 click 结果提示） */
  private lastAdoptedTab: { instanceId: string; tab: string; at: number } | null = null;
  private readonly reloadedInstances = new Set<string>();

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
    pruneScreenshots(this.dirs);
    this.extensionStatus = seedExtension(this.env, this.dirs);
    const cfg = this.getToolConfig();
    this.bridge.start(cfg.bridgePort);
    this.logger.info(`[browser] 模块已初始化（扩展目录 ${this.dirs.extension}）`);
    // 启动阶段不触碰浏览器：扩展安装只在用户于「设置 → 浏览器」点击按钮或工具 action='setup' 时执行
  }

  async destroy(): Promise<void> {
    for (const record of this.tabs.values()) {
      record.console.dispose();
      record.listeners.clear();
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

  /** 扩展文件由 MOSS 播种；版本不一致时让扩展自行 reload（0.2.0+ 支持） */
  private maybeReloadExtension(info: BrowserInstanceInfo): void {
    const bundled = this.extensionStatus.version;
    if (!bundled || info.extensionVersion === bundled) return;
    if (this.reloadedInstances.has(info.id)) return;
    this.reloadedInstances.add(info.id);
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
    this.reloadedInstances.delete(instanceId);
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
        listener(payload.method, payload.params);
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
      groupId,
      session: null,
      sessionPromise: null,
      sessionDead: false,
      refs: new Map(),
      console: new ConsoleBuffer(),
      listeners: new Set(),
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
  }

  private removeTabByNative(instanceId: string, nativeTabId: number): void {
    const record = this.findTabByNative(instanceId, nativeTabId);
    if (!record) return;
    record.console.dispose();
    record.listeners.clear();
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
        console: new ConsoleBuffer(),
        listeners: new Set(),
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
      record.console.dispose();
      record.listeners.clear();
      this.tabs.delete(key);
      if (this.currentTabKey === key) this.currentTabKey = keep.key;
    }
  }

  private removeTabsOfInstance(instanceId: string): void {
    for (const [key, record] of Array.from(this.tabs.entries())) {
      if (record.instanceId !== instanceId) continue;
      record.console.dispose();
      record.listeners.clear();
      record.session = null;
      void this.detachRecord(record);
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
          ? await this.ensureExternalMossTab(resolved.bridgeId, cfg, marker, timeout)
          : null;
      const tab = created ?? (await this.createLegacyMossTab(resolved.bridgeId, marker, timeout, cfg));
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
      console: new ConsoleBuffer(),
      listeners: new Set(),
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
      await this.navigate(key, { url: options.url, timeoutMs: options.timeoutMs });
    } else {
      await this.refreshRecordInfo(record);
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
  ): Promise<{ tabId: number; windowId?: number; groupId: number | null; createdWindow: boolean } | null> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = await this.bridge.send(
          bridgeId,
          'windows.ensureMoss',
          {
            url: marker,
            active: true,
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
  ): Promise<{ tabId: number; windowId?: number; groupId: number | null }> {
    const created = await this.bridge.send(
      bridgeId,
      'tabs.create',
      { url: marker, active: true },
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
    const record = this.requireTab(tab);
    if (record.kind === 'cdp') {
      if (record.targetId) await this.cdp.activate(record.targetId);
    } else if (record.instanceId !== 'builtin' && record.nativeTabId >= 0) {
      try {
        await this.bridge.send(record.instanceId, 'tabs.activate', { tabId: record.nativeTabId }, 10_000);
      } catch {
        // 扩展不可用时尝试 CDP
      }
    } else if (record.targetId) {
      const cdp = this.builtin.getCdp();
      await cdp?.send('Target.activateTarget', { targetId: record.targetId });
    }
    record.active = true;
    this.currentTabKey = record.key;
    this.lastTargetKey = record.instanceId;
    return this.toTabInfo(record);
  }

  async closeTab(tab?: string): Promise<void> {
    const record = this.requireTab(tab);
    await this.detachRecord(record);
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
    record.console.dispose();
    record.listeners.clear();
    this.tabs.delete(record.key);
    if (this.currentTabKey === record.key) {
      const remaining = Array.from(this.tabs.values()).sort((a, b) => b.createdAt - a.createdAt)[0];
      this.currentTabKey = remaining?.key ?? null;
    }
  }

  private requireTab(tab?: string): TabRecord {
    const key = tab ?? this.currentTabKey;
    if (!key) throw new Error(t('browser.noTab'));
    const record = this.tabs.get(key);
    if (!record) throw new Error(t('browser.tabNotFound', { tab: key }));
    return record;
  }

  private async detachRecord(record: TabRecord): Promise<void> {
    if (record.kind === 'cdp') {
      if (record.sessionId) await this.cdp.detach(record.sessionId);
    } else if (record.kind === 'builtin' || record.instanceId === 'builtin') {
      if (record.sessionId) await this.builtin.detach(record.sessionId);
    } else if (record.nativeTabId >= 0) {
      try {
        await this.bridge.send(record.instanceId, 'debugger.detach', { tabId: record.nativeTabId }, 5000);
      } catch {
        // 浏览器已断开
      }
    }
    record.sessionId = undefined;
    record.session = null;
    record.sessionDead = false;
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
    if (record.kind === 'cdp') {
      const connection = this.cdp.getCdp();
      if (!connection || connection.isClosed) throw new Error(t('browser.cdpNotConnected'));
      if (!record.targetId) throw new Error(t('browser.targetNotFound', { tab: record.key }));
      const sessionId = await this.cdp.attach(record.targetId);
      record.sessionId = sessionId;
      record.sessionDead = false;
      const session = new RelaySession(
        (method, params) => {
          const conn = this.cdp.getCdp();
          if (!conn) throw new Error(t('browser.cdpNotConnected'));
          return conn.send(method, params, sessionId);
        },
        (handler) => {
          const conn = this.cdp.getCdp();
          if (!conn) return () => {};
          return conn.onEvent((method, params, eventSessionId) => {
            if (eventSessionId === sessionId) handler(method, params);
          });
        },
      );
      await enablePageDomains(session);
      record.session = session;
      record.console.attach(session);
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
        (method, params) => {
          if (!this.builtin.getCdp()) throw new Error(t('browser.builtinNotRunning'));
          return this.builtin.getCdp()!.send(method, params, sessionId);
        },
        (handler) => {
          const connection = this.builtin.getCdp();
          if (!connection) return () => {};
          return connection.onEvent((method, params, eventSessionId) => {
            if (eventSessionId === sessionId) handler(method, params);
          });
        },
      );
      await enablePageDomains(session);
      record.session = session;
      record.console.attach(session);
      return session;
    }

    if (record.nativeTabId < 0) throw new Error(t('browser.targetNotFound', { tab: record.key }));
    await this.bridge.send(record.instanceId, 'debugger.attach', { tabId: record.nativeTabId }, 10_000);
    record.sessionDead = false;
    const session = new RelaySession(
      (method, params) =>
        this.bridge.send(
          record.instanceId,
          'debugger.send',
          { tabId: record.nativeTabId, method, params },
          this.getToolConfig().timeoutMs,
        ),
      (handler) => {
        record.listeners.add(handler);
        return () => record.listeners.delete(handler);
      },
    );
    await enablePageDomains(session);
    record.session = session;
    record.console.attach(session);
    return session;
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
    return { tab: record.key, url: record.url, title: record.title };
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
    const record = this.requireTab(tab);
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
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    const cfg = this.getToolConfig();
    const tree = await buildSnapshot(session, Math.max(50, maxNodes ?? cfg.maxSnapshotNodes));
    record.refs = tree.refs;
    await this.refreshRecordInfo(record);
    this.currentTabKey = record.key;
    const header = `URL: ${record.url}\nTITLE: ${record.title}\n`;
    const body = tree.text || t('browser.snapshotEmpty');
    return {
      tab: record.key,
      url: record.url,
      title: record.title,
      text: `${header}\n${body}${tree.truncated ? `\n\n${t('browser.snapshotTruncated')}` : ''}`,
      refCount: tree.refCount,
      truncated: tree.truncated,
    };
  }

  async screenshot(tab: string | undefined, fullPage?: boolean): Promise<BrowserScreenshot> {
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    const cfg = this.getToolConfig();
    const shot = await captureScreenshot(session, fullPage === true, cfg.maxImageDimension);
    const path = newScreenshotPath(this.dirs, record.key);
    await Bun.write(path, shot.buffer);
    pruneScreenshots(this.dirs);
    await this.refreshRecordInfo(record);
    return {
      path,
      data: shot.buffer.toString('base64'),
      mimeType: 'image/png',
      ...(shot.width !== undefined ? { width: shot.width } : {}),
      ...(shot.height !== undefined ? { height: shot.height } : {}),
    };
  }

  async click(tab: string | undefined, options: BrowserClickOptions): Promise<BrowserPageInfo> {
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    const started = Date.now();
    this.pendingNewTabUntil.set(record.instanceId, started + 2500);
    await clickElement(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      ...(typeof options.x === 'number' ? { x: options.x } : {}),
      ...(typeof options.y === 'number' ? { y: options.y } : {}),
      ...(options.button ? { button: options.button } : {}),
      ...(options.clickCount !== undefined ? { clickCount: options.clickCount } : {}),
      ...(options.modifiers ? { modifiers: options.modifiers } : {}),
    }, record.refs);
    await sleep(350);
    await this.refreshRecordInfo(record);
    return this.withOpenedTab(this.pageResult(record), record.instanceId, started);
  }

  async hover(tab: string | undefined, options: BrowserHoverOptions): Promise<BrowserPageInfo> {
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    await hoverElement(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
    }, record.refs);
    return this.pageResult(record);
  }

  async typeText(tab: string | undefined, options: BrowserTypeOptions): Promise<BrowserPageInfo> {
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    await typeInto(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      text: options.text,
      ...(options.replace !== undefined ? { replace: options.replace } : {}),
      ...(options.submit !== undefined ? { submit: options.submit } : {}),
    }, record.refs);
    await this.refreshRecordInfo(record);
    return this.pageResult(record);
  }

  async pressKey(tab: string | undefined, options: BrowserPressKeyOptions): Promise<BrowserPageInfo> {
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    const started = Date.now();
    this.pendingNewTabUntil.set(record.instanceId, started + 2500);
    await pressKey(session, options.key, options.modifiers);
    await sleep(250);
    await this.refreshRecordInfo(record);
    return this.withOpenedTab(this.pageResult(record), record.instanceId, started);
  }

  async selectOption(tab: string | undefined, options: BrowserSelectOptions): Promise<BrowserPageInfo> {
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    await selectOption(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      values: options.values,
    }, record.refs);
    await this.refreshRecordInfo(record);
    return this.pageResult(record);
  }

  async scroll(tab: string | undefined, options: BrowserScrollOptions): Promise<BrowserPageInfo> {
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    await scrollPage(session, {
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.deltaX !== undefined ? { deltaX: options.deltaX } : {}),
      ...(options.deltaY !== undefined ? { deltaY: options.deltaY } : {}),
    }, record.refs);
    await this.refreshRecordInfo(record);
    return this.pageResult(record);
  }

  async drag(tab: string | undefined, options: BrowserDragOptions): Promise<BrowserPageInfo> {
    const record = this.requireTab(tab);
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
    const record = this.requireTab(tab);
    const session = await this.ensureTabSession(record);
    const cfg = this.getToolConfig();
    return evaluateExpression(session, options.expression, cfg.allowEvaluate);
  }

  async waitFor(tab: string | undefined, options: BrowserWaitOptions): Promise<BrowserPageInfo> {
    const record = this.requireTab(tab);
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

  async consoleLogs(tab: string | undefined, clear?: boolean): Promise<BrowserConsoleResult> {
    const record = this.requireTab(tab);
    await this.ensureTabSession(record);
    return { entries: record.console.list(clear === true), cleared: clear === true };
  }

  /** 供工具层读取内置 Chrome 的 CDP（测试/调试用） */
  getBuiltinCdp(): CdpConnection | null {
    return this.builtin.getCdp();
  }
}
