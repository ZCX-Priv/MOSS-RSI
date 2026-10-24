// src/modules/browser/installer.ts
// 浏览器扩展自动安装器：通过 cua-driver 的 UI Automation 在现有 Chromium 浏览器
// （默认 profile）中打开扩展页，开启开发者模式并「加载已解压的扩展程序」。
//
// 设计背景：
// - Chrome Windows 自 33 起禁止本地 CRX 外部安装；Edge 注册表 external install 只接受商店 update_url。
// - 因此不依赖商店/native host 的自动安装只能走桌面 UI 自动化。
// - 首次启动执行一次；成功后写 ~/.moss/browser/install-state.json，后续启动跳过。
// - 任何一步失败都回退 manual，不反复骚扰用户。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ComputerService } from '../contracts';
import type { Environment, Logger } from '../../core/types';
import type { ComputerCallOptions } from '../computer/types';
import {
  clearBrowserDetectionCache,
  detectInstalledBrowsers,
  findExtensionInBrowserProfiles,
  type BrowserDirs,
  type ExtensionPresence,
  type InstalledBrowserInfo,
} from './paths';
import type {
  BrowserInstanceInfo,
  BrowserInstallerBrowser,
  BrowserInstallerState,
  BrowserInstallerStatus,
  BrowserToolConfig,
} from './types';

const CALL_OPTS: ComputerCallOptions = {
  sessionLabel: 'moss-browser-installer',
  sessionId: 'browser-installer',
  source: 'panel',
  timeoutMs: 30_000,
  action: 'browser-install',
  summary: '浏览器扩展自动安装',
};

interface WindowInfo {
  appName: string;
  pid: number;
  title: string;
  windowId: number;
  onScreen: boolean;
}

interface InstallMarkerEntry {
  state: 'installed' | 'already' | 'reloaded' | 'manual';
  extensionVersion: string;
  at: number;
  detail?: string;
}

interface InstallMarkerFile {
  version: 1;
  browsers: Record<string, InstallMarkerEntry>;
}

export interface BrowserInstallerDeps {
  env: Environment;
  logger: Logger;
  dirs: BrowserDirs;
  extensionDir: string;
  computer: ComputerService | null;
  getConfig: () => BrowserToolConfig;
  getInstances: () => BrowserInstanceInfo[];
  getExtensionVersion: () => string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从 cua 文本结果中解析窗口列表 */
function parseWindows(text: string): WindowInfo[] {
  const windows: WindowInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^-\s+(\S+)\s+\(pid\s+(\d+)\)\s+"(.*)"\s+\[window_id:\s*(\d+)\]/.exec(line.trim());
    if (!match) continue;
    windows.push({
      appName: match[1],
      pid: Number(match[2]),
      title: match[3],
      windowId: Number(match[4]),
      onScreen: !line.includes('[off-screen]'),
    });
  }
  return windows;
}

/** 从 get_window_state 文本中解析 snapshot id 与元素行 token */
function findElementToken(
  text: string,
  label: string,
  roles?: string[],
): string | null {
  const snapshotMatch = /snapshot_id=(\S+)/.exec(text);
  if (!snapshotMatch) return null;
  const snapshot = snapshotMatch[1];
  const lowered = label.toLowerCase();
  for (const line of text.split(/\r?\n/)) {
    if (!line.toLowerCase().includes(lowered)) continue;
    if (roles && roles.length > 0 && !roles.some((role) => line.includes(` ${role} `))) continue;
    const rowMatch = /^\s*(?:[-*]\s+)?\[(\d+)\]/.exec(line);
    if (rowMatch) return `${snapshot}:${rowMatch[1]}`;
  }
  return null;
}

/** 按候选标签逐个匹配，返回首个命中的元素 token */
function findElementTokenByLabels(
  text: string,
  labels: string[],
  roles?: string[],
): string | null {
  for (const label of labels) {
    const token = findElementToken(text, label, roles);
    if (token) return token;
  }
  return null;
}

/** 文件/文件夹选择对话框标题：绝不能当成浏览器页面窗口 */
const FILE_DIALOG_TITLE_PATTERN =
  /(选择文件夹|选择扩展目录|选择扩展程序目录|Select Folder|浏览文件夹|Choose Folder)/i;

/** 各语言的地址栏标签 */
const ADDRESS_BAR_LABELS = [
  '地址和搜索栏',
  'Address and search bar',
  '搜索或输入 Web 地址',
  'Search or enter web address',
  '地址栏',
  'Address bar',
];

/** 各语言的开发者模式标签（Edge：开发人员模式；Chrome：开发者模式） */
const DEV_MODE_LABELS = ['开发人员模式', '开发者模式', 'Developer mode'];

/** 各语言的「加载已解压的扩展程序」标签（Chrome 145 中文为「加载未打包的扩展程序」） */
const LOAD_UNPACKED_LABELS = [
  '加载解压缩的扩展',
  '加载未打包的扩展程序',
  '加载已解压的扩展程序',
  'Load unpacked',
];

function addressBarToken(text: string): string | null {
  const token = findElementTokenByLabels(text, ADDRESS_BAR_LABELS, ['Edit', 'ComboBox']);
  return token;
}

/** 诊断用：概括窗口树（首行 + 行数 + 关键元素命中情况） */
function summarizeTree(text: string): string {
  const lines = text.split(/\r?\n/);
  const hasDev = DEV_MODE_LABELS.some((label) => text.includes(label));
  const hasLoad = LOAD_UNPACKED_LABELS.some((label) => text.includes(label));
  const doc = lines.find((line) => line.includes('Document ')) ?? '';
  return `${lines[0] ?? ''} | rows=${lines.length} dev=${hasDev} load=${hasLoad} ${doc.trim().slice(0, 160)}`;
}

export class BrowserExtensionInstaller {
  private readonly deps: BrowserInstallerDeps;
  private results: BrowserInstallerBrowser[] = [];
  private running = false;
  private checked = false;
  private current: string | null = null;
  private marker: InstallMarkerFile = { version: 1, browsers: {} };
  private readonly markerPath: string;

  constructor(deps: BrowserInstallerDeps) {
    this.deps = deps;
    this.markerPath = join(deps.dirs.root, 'install-state.json');
    this.marker = this.readMarker();
  }

  getStatus(): BrowserInstallerStatus {
    const config = this.deps.getConfig();
    const detected = detectInstalledBrowsers(this.deps.env);
    const bundledVersion = this.deps.getExtensionVersion() ?? '';
    const previous = new Map(this.results.map((item) => [item.id, item]));
    this.results = detected.map((browser) => {
      const prev = previous.get(browser.id);
      if (this.running && prev && prev.state === 'installing') return { ...prev };
      if (!this.running && prev && prev.state === 'failed') return { ...prev };

      const marker = this.marker.browsers[browser.executable.toLowerCase()];
      const presence = this.presenceFor(browser);
      if (presence.installed) {
        if (!presence.enabled) {
          return this.stateFor(
            browser,
            'manual',
            marker,
            `已安装但被停用（${presence.profile ?? '默认 profile'}），请在浏览器扩展页启用`,
          );
        }
        if (bundledVersion && presence.version && presence.version !== bundledVersion) {
          return this.stateFor(
            browser,
            'already',
            marker,
            `已安装 v${presence.version}，浏览器连接后自动重载到 v${bundledVersion}`,
          );
        }
        return this.stateFor(browser, 'already', marker);
      }
      // 未知浏览器无法读 profile：成功标记且版本一致时视为已安装
      if (
        !browser.userDataDir &&
        bundledVersion &&
        marker?.extensionVersion === bundledVersion &&
        (marker.state === 'installed' || marker.state === 'already' || marker.state === 'reloaded')
      ) {
        return this.stateFor(browser, 'skipped', marker);
      }
      if (marker?.state === 'manual') {
        return this.stateFor(browser, 'manual', marker);
      }
      if (marker?.state === 'installed') {
        return this.stateFor(browser, 'pending', marker, 'profile 中未检出扩展，启动时将自动重装');
      }
      return this.stateFor(browser, 'pending', marker);
    });
    return {
      enabled: config.autoInstallExtensions,
      running: this.running,
      checked: this.checked,
      current: this.current,
      browsers: this.results.map((item) => ({ ...item })),
    };
  }

  private stateFor(
    browser: InstalledBrowserInfo,
    state: BrowserInstallerState,
    marker?: InstallMarkerEntry,
    detail?: string,
  ): BrowserInstallerBrowser {
    const resolvedDetail = detail ?? marker?.detail;
    return {
      id: browser.id,
      name: browser.name,
      executable: browser.executable,
      state,
      ...(resolvedDetail ? { detail: resolvedDetail } : {}),
      ...(marker?.at ? { at: marker.at } : {}),
    };
  }

  private presenceFor(browser: InstalledBrowserInfo): ExtensionPresence {
    return findExtensionInBrowserProfiles(browser, this.deps.extensionDir);
  }

  private recordMarker(
    browser: InstalledBrowserInfo,
    state: InstallMarkerEntry['state'],
    extensionVersion: string,
    detail?: string,
  ): void {
    this.marker.browsers[browser.executable.toLowerCase()] = {
      state,
      extensionVersion,
      at: Date.now(),
      ...(detail ? { detail } : {}),
    };
  }

  /** 首次启动自动安装；force=true 忽略标记重跑 */
  async run(force = false): Promise<BrowserInstallerStatus> {
    if (this.running) return this.getStatus();
    const config = this.deps.getConfig();
    if (!config.autoInstallExtensions && !force) return this.getStatus();
    clearBrowserDetectionCache();
    const browsers = detectInstalledBrowsers(this.deps.env, true);
    if (browsers.length === 0) {
      this.results = [];
      return this.getStatus();
    }
    this.running = true;
    this.marker = this.readMarker();
    this.results = browsers.map((browser) => ({
      id: browser.id,
      name: browser.name,
      executable: browser.executable,
      state: 'pending',
    }));
    try {
      const computerReady = await this.ensureComputer();
      for (const browser of browsers) {
        this.current = browser.name;
        await this.processBrowser(browser, computerReady);
      }
    } finally {
      this.current = null;
      this.running = false;
      this.checked = true;
      this.writeMarker();
    }
    return this.getStatus();
  }

  private async ensureComputer(): Promise<boolean> {
    const computer = this.deps.computer;
    if (!computer) return false;
    try {
      const status = computer.getStatus();
      if (status.installed && status.connection === 'connected') return true;
      await computer.ensureConnected();
      const after = computer.getStatus();
      return after.installed && after.connection === 'connected';
    } catch (err) {
      this.deps.logger.warn(
        `[browser] 自动安装扩展：cua-driver 不可用（${err instanceof Error ? err.message : String(err)}）`,
      );
      return false;
    }
  }

  private update(
    browser: InstalledBrowserInfo,
    state: BrowserInstallerState,
    detail?: string,
  ): void {
    const target = this.results.find((item) => item.id === browser.id);
    if (!target) return;
    target.state = state;
    target.detail = detail;
    target.at = Date.now();
  }

  private instanceFor(browser: InstalledBrowserInfo): BrowserInstanceInfo | undefined {
    const name = browser.name.toLowerCase();
    return this.deps
      .getInstances()
      .find((instance) => instance.kind === 'external' && instance.browserName.toLowerCase() === name);
  }

  /** 轮询 profile，直到确认扩展真实安装（或桥接实例已连接） */
  private async waitForPresence(
    browser: InstalledBrowserInfo,
    timeoutMs: number,
  ): Promise<ExtensionPresence | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const presence = this.presenceFor(browser);
      if (presence.installed) return presence;
      if (this.instanceFor(browser)) {
        return {
          installed: true,
          enabled: true,
          version: null,
          extensionId: null,
          profile: null,
        };
      }
      await sleep(500);
    }
    return null;
  }

  private async processBrowser(
    browser: InstalledBrowserInfo,
    computerReady: boolean,
  ): Promise<void> {
    const bundledVersion = this.deps.getExtensionVersion() ?? '';
    const presence = this.presenceFor(browser);
    const instance = this.instanceFor(browser);
    const installedVersion = presence.version ?? instance?.extensionVersion ?? null;
    const installed = presence.installed || Boolean(instance);

    if (installed) {
      if (presence.installed && !presence.enabled) {
        const detail = `扩展已安装但被停用（${presence.profile ?? '默认 profile'}），请在浏览器扩展页启用`;
        this.update(browser, 'manual', detail);
        this.recordMarker(browser, 'manual', bundledVersion, detail);
        return;
      }
      if (!bundledVersion || !installedVersion || installedVersion === bundledVersion) {
        this.update(browser, 'already');
        this.recordMarker(browser, 'already', installedVersion ?? bundledVersion);
        return;
      }
      // 扩展已安装但版本较旧：连接中的实例会由 service 自动发送 extension.reload
      const detail = `已安装 v${installedVersion}，浏览器连接后自动重载到 v${bundledVersion}`;
      this.update(browser, 'already', detail);
      this.recordMarker(browser, 'already', installedVersion, detail);
      return;
    }

    if (!computerReady) {
      const detail = 'cua-driver 未安装或未连接；无法执行 UI 自动化安装';
      this.update(browser, 'manual', detail);
      this.recordMarker(browser, 'manual', bundledVersion, detail);
      return;
    }

    this.update(browser, 'installing', '正在打开扩展页');
    try {
      const loaded = await this.installUnpacked(browser);
      const verified = loaded ? await this.waitForPresence(browser, 10_000) : null;
      if (verified?.installed) {
        if (!verified.enabled) {
          const detail = `扩展已安装但被停用（${verified.profile ?? '默认 profile'}），请在浏览器扩展页启用`;
          this.update(browser, 'manual', detail);
          this.recordMarker(browser, 'manual', bundledVersion, detail);
          return;
        }
        this.update(browser, 'installed');
        this.recordMarker(browser, 'installed', bundledVersion);
        return;
      }
      // 未知浏览器没有 userDataDir：UI 自动化成功即视为安装完成
      if (loaded && !browser.userDataDir) {
        this.update(browser, 'installed');
        this.recordMarker(browser, 'installed', bundledVersion);
        return;
      }
      const detail = '扩展页已加载，但未能在浏览器 profile 中确认安装；请重启浏览器后重试';
      this.update(browser, 'manual', detail);
      this.recordMarker(browser, 'manual', bundledVersion, detail);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`[browser] 自动安装扩展到 ${browser.name} 失败: ${detail}`);
      this.update(browser, 'failed', detail);
      this.recordMarker(browser, 'manual', bundledVersion, detail);
    }
  }

  private async callComputer(
    tool: string,
    args: Record<string, unknown>,
    action: string,
  ): Promise<{ text: string; structured: unknown }> {
    const computer = this.deps.computer;
    if (!computer) throw new Error('cua-driver 不可用');
    const result = await computer.callTool(tool, args, { ...CALL_OPTS, action, summary: action });
    if (result.isError) throw new Error(result.text || `${tool} 失败`);
    return { text: result.text, structured: result.structured };
  }

  /**
   * 后台投递优先，遇到 background_unavailable 时再升级为前台。
   * cua-driver 对 Chromium WebUI 内容不会静默吞掉事件，而是返回 background_unavailable。
   */
  private async callWithDelivery(
    tool: string,
    args: Record<string, unknown>,
    action: string,
  ): Promise<{ text: string; structured: unknown }> {
    try {
      return await this.callComputer(tool, { ...args, delivery_mode: 'background' }, action);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/background/i.test(message)) throw err;
      return await this.callComputer(tool, { ...args, delivery_mode: 'foreground' }, `${action}-foreground`);
    }
  }

  private async listWindows(): Promise<WindowInfo[]> {
    const result = await this.callComputer('list_windows', { on_screen_only: false }, 'browser-install:list_windows');
    if (isRecord(result.structured)) {
      const raw = result.structured.windows;
      if (Array.isArray(raw)) {
        const parsed: WindowInfo[] = [];
        for (const item of raw) {
          if (!isRecord(item)) continue;
          const pid = typeof item.pid === 'number' ? item.pid : -1;
          const windowId = typeof item.window_id === 'number' ? item.window_id : -1;
          if (pid < 0 || windowId < 0) continue;
          parsed.push({
            appName: typeof item.app_name === 'string' ? item.app_name : '',
            pid,
            windowId,
            title: typeof item.title === 'string' ? item.title : '',
            onScreen: item.is_on_screen !== false,
          });
        }
        if (parsed.length > 0) return parsed;
      }
    }
    return parseWindows(result.text);
  }

  private async findBrowserWindow(
    browser: InstalledBrowserInfo,
    pids: Set<number> = new Set(),
  ): Promise<WindowInfo | null> {
    const deadline = Date.now() + 12_000;
    let fallback: WindowInfo | null = null;
    while (Date.now() < deadline) {
      const windows = await this.listWindows();
      const matching = windows.filter(
        (win) =>
          win.appName.toLowerCase() === browser.imageName.toLowerCase() &&
          (pids.size === 0 || pids.has(win.pid)) &&
          !FILE_DIALOG_TITLE_PATTERN.test(win.title) &&
          !/(要恢复页面|Restore pages|恢复页面)/i.test(win.title),
      );
      const extensionWindow = matching.find((win) =>
        /(扩展|Extensions|扩展程序)/i.test(win.title),
      );
      if (extensionWindow) return extensionWindow;
      if (!fallback && matching.length > 0) {
        fallback = matching.find((win) => win.onScreen) ?? matching[0];
      }
      await sleep(400);
    }
    return fallback;
  }

  /** 读取指定浏览器可执行文件对应的进程 id（排除 Chrome for Testing 等同名进程） */
  private async getBrowserPids(browser: InstalledBrowserInfo): Promise<Set<number>> {
    try {
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-Command',
          `Get-Process -Name '${browser.imageName.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower() -eq '${browser.executable.toLowerCase()}' } | Select-Object -ExpandProperty Id`,
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      const pids = new Set<number>();
      for (const line of text.split(/\r?\n/)) {
        const value = Number(line.trim());
        if (Number.isFinite(value) && value > 0) pids.add(value);
      }
      return pids;
    } catch {
      return new Set();
    }
  }

  private async refreshWindow(win: WindowInfo): Promise<boolean> {
    const windows = await this.listWindows();
    const sameId = windows.find((item) => item.windowId === win.windowId);
    const samePid = windows.find((item) => item.pid === win.pid);
    const next = sameId ?? samePid;
    if (!next) return false;
    win.windowId = next.windowId;
    win.pid = next.pid;
    win.title = next.title;
    win.appName = next.appName;
    return true;
  }

  private async windowState(
    win: WindowInfo,
    query?: string,
    maxElements = 4000,
  ): Promise<string> {
    const args = {
      pid: win.pid,
      window_id: win.windowId,
      include_screenshot: false,
      include_accessibility_tree: true,
      max_elements: maxElements,
      ...(query ? { query } : {}),
    };
    try {
      const result = await this.callComputer('get_window_state', args, 'browser-install:get_window_state');
      return result.text;
    } catch (err) {
      if (!/No window with window_id|No window/i.test(err instanceof Error ? err.message : String(err))) {
        throw err;
      }
      if (!(await this.refreshWindow(win))) {
        throw new Error('浏览器窗口已关闭或窗口 id 失效，请重试安装');
      }
      const result = await this.callComputer(
        'get_window_state',
        {
          pid: win.pid,
          window_id: win.windowId,
          include_screenshot: false,
          include_accessibility_tree: true,
          max_elements: maxElements,
          ...(query ? { query } : {}),
        },
        'browser-install:get_window_state-retry',
      );
      return result.text;
    }
  }

  private async clickToken(win: WindowInfo, token: string): Promise<void> {
    const click = (delivery: 'background' | 'foreground') =>
      this.callComputer(
        'click',
        { pid: win.pid, window_id: win.windowId, element_token: token, delivery_mode: delivery },
        'browser-install:click',
      );
    try {
      const result = await click('background');
      if (/(unverifiable|refused|suspected_noop|background)/i.test(result.text)) {
        await click('foreground');
      }
    } catch (err) {
      if (!/No window with window_id|No window/i.test(err instanceof Error ? err.message : String(err))) {
        if (!/background/i.test(err instanceof Error ? err.message : String(err))) throw err;
      }
      if (!(await this.refreshWindow(win))) {
        throw new Error('浏览器窗口已关闭或窗口 id 失效，请重试安装');
      }
      await click('foreground');
    }
  }

  /** 激活目标窗口：Chromium 内容在被遮挡时前台投递会报 foreground_unavailable */
  private async bringToFront(win: WindowInfo): Promise<void> {
    try {
      await this.callComputer(
        'bring_to_front',
        { pid: win.pid, window_id: win.windowId },
        'browser-install:bring-to-front',
      );
      await sleep(400);
    } catch (err) {
      this.deps.logger.warn(
        `[browser] 激活窗口失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 开发者模式开关：UIA TogglePattern 比普通点击可靠（普通点击可能只聚焦不切换） */
  private async toggleToken(win: WindowInfo, token: string): Promise<void> {
    try {
      const result = await this.callComputer(
        'click',
        {
          pid: win.pid,
          window_id: win.windowId,
          element_token: token,
          action: 'toggle',
          delivery_mode: 'background',
        },
        'browser-install:toggle',
      );
      if (/refused|unverifiable|not supported|failed/i.test(result.text)) {
        await this.clickToken(win, token);
      }
    } catch {
      await this.clickToken(win, token);
    }
  }

  private async openExtensionsPage(browser: InstalledBrowserInfo): Promise<Set<number>> {
    const wasRunning = await this.isBrowserRunning(browser);
    // 始终用 --new-window：已运行时命令行打开的 URL 可能只是后台标签页，无法读取 UIA
    try {
      Bun.spawn(
        [
          browser.executable,
          '--new-window',
          '--no-first-run',
          '--no-default-browser-check',
          '--force-renderer-accessibility',
          browser.extensionsUrl,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
    } catch (err) {
      throw new Error(`无法启动 ${browser.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(wasRunning ? 2000 : 3500);
    let pids = await this.getBrowserPids(browser);
    if (pids.size === 0) {
      await sleep(1500);
      pids = await this.getBrowserPids(browser);
    }
    return pids;
  }

  private async isBrowserRunning(browser: InstalledBrowserInfo): Promise<boolean> {
    try {
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-Command',
          `Get-Process -Name ${browser.imageName.replace(/\.exe$/i, '')} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty ProcessName`,
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      const output = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      return output.length > 0;
    } catch {
      return false;
    }
  }

  /** 在已打开的浏览器窗口里导航到扩展页（命令行 URL 在已运行浏览器中常被忽略） */
  private async navigateWindow(win: WindowInfo, url: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await this.windowState(win);
      const addressToken = addressBarToken(state);
      if (addressToken) {
        await this.callWithDelivery(
          'set_value',
          { pid: win.pid, element_token: addressToken, value: url },
          'browser-install:set-address',
        );
        await this.callWithDelivery(
          'press_key',
          { pid: win.pid, window_id: win.windowId, element_token: addressToken, key: 'return' },
          'browser-install:navigate',
        );
        await sleep(2200);
        return;
      }
      // Chromium 的无障碍树按需启用，首读可能只有外壳；稍等再读
      await sleep(700);
    }

    // 兜底：不依赖 UIA 的地址栏元素，直接 Ctrl+L 聚焦后输入
    this.deps.logger.info(`[browser] 地址栏元素不可读，改用键盘导航: ${url}`);
    await this.callWithDelivery(
      'hotkey',
      { pid: win.pid, window_id: win.windowId, keys: ['ctrl', 'l'] },
      'browser-install:focus-address',
    );
    await sleep(300);
    await this.callWithDelivery(
      'type_text',
      { pid: win.pid, window_id: win.windowId, text: url },
      'browser-install:type-address',
    );
    await this.callWithDelivery(
      'press_key',
      { pid: win.pid, window_id: win.windowId, key: 'return' },
      'browser-install:navigate-keyboard',
    );
    await sleep(2500);
  }

  /** 反复读取窗口树，直到出现指定按钮 */
  private async waitForButton(
    win: WindowInfo,
    labels: string[],
    query: string,
    attempts: number,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const text = await this.windowState(win, query);
      const token = findElementTokenByLabels(text, labels, ['Button', 'MenuItem']);
      if (token) return token;
      await sleep(500);
    }
    return null;
  }

  /** 打开扩展页并加载 unpacked 扩展（窗口失效时整体重试一次） */
  private async installUnpacked(browser: InstalledBrowserInfo): Promise<boolean> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.installUnpackedOnce(browser);
      } catch (err) {
        lastError = err;
        const detail = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn(
          `[browser] 安装 ${browser.name} 第 ${attempt + 1} 次尝试失败: ${detail}`,
        );
        await sleep(1200);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async installUnpackedOnce(browser: InstalledBrowserInfo): Promise<boolean> {
    // 上次失败可能残留文件夹选择对话框：先关闭，避免被误当成浏览器页面窗口
    const staleDialog = await this.findFolderDialog(250);
    if (staleDialog) {
      this.deps.logger.warn('[browser] 关闭上次残留的文件夹选择对话框');
      await this.callWithDelivery(
        'press_key',
        { pid: staleDialog.pid, window_id: staleDialog.windowId, key: 'escape' },
        'browser-install:dismiss-stale-folder',
      ).catch(() => undefined);
      await sleep(500);
    }
    const pids = await this.openExtensionsPage(browser);
    const extensionName = 'MOSS Browser Bridge';
    let win = await this.findBrowserWindow(browser, pids);
    if (!win) throw new Error('找不到浏览器扩展页窗口');
    this.deps.logger.info(`[browser] 安装器窗口: "${win.title}" ${win.appName} pid=${win.pid} window=${win.windowId}`);
    await this.bringToFront(win);
    await this.navigateWindow(win, browser.extensionsUrl);
    await sleep(1200);
    // 导航后窗口 id 可能变化：重新定位一次
    win = (await this.findBrowserWindow(browser, pids)) ?? win;

    // 已安装：扩展卡片已存在
    const initial = await this.windowState(win);
    this.deps.logger.info(`[browser] 扩展页状态: ${summarizeTree(initial)}`);
    if (initial.toLowerCase().includes(extensionName.toLowerCase())) return true;

    // 先找「加载已解压」按钮：Edge/Chrome 的开发者模式常已开启，
    // 此时不能再点开关，否则会把开发者模式关掉。
    let loadToken = await this.waitForButton(win, LOAD_UNPACKED_LABELS, '加载', 3);
    if (!loadToken) {
      const devText = await this.windowState(win);
      this.deps.logger.info(`[browser] 开发者模式查找: ${summarizeTree(devText)}`);
      const devToken = findElementTokenByLabels(devText, DEV_MODE_LABELS, [
        'Button',
        'Switch',
        'ToggleButton',
      ]);
      if (!devToken) throw new Error('未找到开发者模式开关（可能被浏览器策略禁用）');
      await this.toggleToken(win, devToken);
      await sleep(1000);
      loadToken = await this.waitForButton(win, LOAD_UNPACKED_LABELS, '加载', 10);
    }
    if (!loadToken) throw new Error('未找到「加载已解压的扩展程序」按钮（开发者模式可能被策略禁用）');
    await this.clickToken(win, loadToken);
    await sleep(1400);

    this.deps.logger.info(`[browser] 文件夹选择器目标路径: ${this.deps.extensionDir}`);
    await this.fillFolderPicker();
    await sleep(600);

    // 验证：profile 中真实存在 / 扩展已连接桥接 / 扩展页出现扩展卡片
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (this.presenceFor(browser).installed) return true;
      if (this.instanceFor(browser)) return true;
      const currentWin = await this.findBrowserWindow(browser, pids);
      if (currentWin) {
        win = currentWin;
        const text = await this.windowState(win, extensionName);
        if (text.toLowerCase().includes(extensionName.toLowerCase())) return true;
      }
      await sleep(800);
    }
    throw new Error('加载后未在浏览器中确认 MOSS Browser Bridge');
  }

  /** 查找 Windows 文件夹选择器（Edge「选择扩展目录」/ Chrome「选择文件夹」） */
  private async findFolderDialog(timeoutMs: number): Promise<WindowInfo | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const windows = await this.listWindows();
      const dialog = windows.find((win) => FILE_DIALOG_TITLE_PATTERN.test(win.title));
      if (dialog) return dialog;
      await sleep(300);
    }
    return null;
  }

  private async folderDialogAlive(dialog: WindowInfo): Promise<boolean> {
    const windows = await this.listWindows();
    return windows.some(
      (win) =>
        FILE_DIALOG_TITLE_PATTERN.test(win.title) &&
        (win.windowId === dialog.windowId || win.pid === dialog.pid),
    );
  }

  /** 判断对话框树中是否已出现扩展目录（面包屑或路径输入框） */
  private folderPathVisible(text: string): boolean {
    const normalized = text.replace(/\//g, '\\').toLowerCase();
    const wanted = this.deps.extensionDir.replace(/\//g, '\\').toLowerCase();
    const folderName = basename(wanted);
    return normalized.includes(wanted) || normalized.includes(`\\${folderName}`);
  }

  private async doubleClickToken(win: WindowInfo, token: string): Promise<void> {
    await this.callWithDelivery(
      'double_click',
      { pid: win.pid, window_id: win.windowId, element_token: token },
      'browser-install:double-click',
    );
  }

  /** 按用户目录层级逐级点进 .moss/browser/extension（用户名/盘符全部动态解析） */
  private async clickThroughFolderPicker(dialog: WindowInfo): Promise<void> {
    const home = this.deps.env.homeDir;
    const homeName = basename(home);
    const parentName = basename(dirname(home));
    const driveMatch = /^([A-Za-z]):/.exec(home);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : null;
    const driveLabels = drive
      ? [
          `本地磁盘 (${drive}:)`,
          `Local Disk (${drive}:)`,
          `System (${drive}:)`,
          `(${drive}:)`,
          `${drive}:`,
        ]
      : [];
    const steps: Array<{ label: string; labels: string[]; roles: string[] }> = [
      { label: '此电脑', labels: ['此电脑', 'This PC'], roles: ['TreeItem', 'ListItem', 'Button'] },
      ...(driveLabels.length > 0
        ? [
            {
              label: `${drive}:`,
              labels: driveLabels,
              roles: ['ListItem', 'TreeItem'],
            },
          ]
        : []),
      {
        label: parentName,
        labels: Array.from(new Set([parentName, 'Users', '用户'])),
        roles: ['ListItem', 'TreeItem'],
      },
      { label: homeName, labels: [homeName], roles: ['ListItem', 'TreeItem'] },
      { label: '.moss', labels: ['.moss'], roles: ['ListItem', 'TreeItem'] },
      { label: 'browser', labels: ['browser'], roles: ['ListItem', 'TreeItem'] },
      { label: 'extension', labels: ['extension'], roles: ['ListItem', 'TreeItem'] },
    ];

    for (const [index, step] of steps.entries()) {
      const state = await this.windowState(dialog);
      const token = findElementTokenByLabels(state, step.labels, step.roles);
      if (!token) throw new Error(`文件夹选择器未找到「${step.label}」`);
      if (index === 0) {
        await this.clickToken(dialog, token);
      } else {
        await this.doubleClickToken(dialog, token);
      }
      await sleep(700);
      if (!(await this.refreshWindow(dialog))) {
        // 双击可能直接确认并关闭对话框
        return;
      }
    }
  }

  /** 关闭残留的「文件夹名无效」提示 */
  private async dismissFolderErrorPrompt(dialog: WindowInfo): Promise<void> {
    const state = await this.windowState(dialog);
    if (!/(文件夹名无效|invalid folder name)/i.test(state)) return;
    const okToken = findElementTokenByLabels(state, ['确定', 'OK'], ['Button']);
    if (okToken) {
      await this.clickToken(dialog, okToken);
    } else {
      await this.callWithDelivery(
        'press_key',
        { pid: dialog.pid, window_id: dialog.windowId, key: 'return' },
        'browser-install:dismiss-folder-error',
      );
    }
    await sleep(500);
  }

  /**
   * 自动化 Windows 文件夹选择器：优先按用户目录逐级点进，失败再用路径输入/地址栏兜底。
   */
  private async fillFolderPicker(): Promise<void> {
    let dialog = await this.findFolderDialog(10_000);
    if (!dialog) throw new Error('未找到文件夹选择对话框');
    this.deps.logger.info(
      `[browser] 文件夹选择器: "${dialog.title}" pid=${dialog.pid} window=${dialog.windowId} target=${this.deps.extensionDir}`,
    );
    await this.bringToFront(dialog);
    await this.dismissFolderErrorPrompt(dialog);
    dialog = (await this.findFolderDialog(1500)) ?? dialog;

    // 1) 优先按用户目录逐级点击：此电脑 → C: → Users → 用户 → .moss → browser → extension
    let navigated = false;
    try {
      await this.clickThroughFolderPicker(dialog);
      navigated = true;
      this.deps.logger.info('[browser] 文件夹选择器已逐级点击进入扩展目录');
    } catch (err) {
      this.deps.logger.warn(
        `[browser] 逐级点击进入扩展目录失败，改用路径输入: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!(await this.folderDialogAlive(dialog))) return;
    dialog = (await this.findFolderDialog(1500)) ?? dialog;

    // 2) 逐级点击失败时：路径输入 + Return，再退到地址栏键盘
    if (!navigated) {
      const state = await this.windowState(dialog, '文件夹');
      const editToken =
        findElementToken(state, '文件夹:', ['Edit', 'ComboBox']) ??
        findElementToken(state, 'Folder:', ['Edit', 'ComboBox']) ??
        findElementToken(state, '文件夹名称', ['Edit', 'ComboBox']) ??
        findElementToken(state, 'Folder name', ['Edit', 'ComboBox']) ??
        findElementToken(state, '文件夹', ['Edit', 'ComboBox']);
      if (editToken) {
        try {
          await this.callWithDelivery(
            'set_value',
            { pid: dialog.pid, element_token: editToken, value: this.deps.extensionDir },
            'browser-install:set-folder',
          );
          await sleep(250);
          await this.callWithDelivery(
            'press_key',
            { pid: dialog.pid, window_id: dialog.windowId, element_token: editToken, key: 'return' },
            'browser-install:commit-folder-path',
          );
        } catch (err) {
          this.deps.logger.warn(
            `[browser] 文件夹路径 UIA 写入失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await sleep(900);
      }
      if (!(await this.folderDialogAlive(dialog))) return;
      dialog = (await this.findFolderDialog(1500)) ?? dialog;
      let currentState = await this.windowState(dialog);
      if (!this.folderPathVisible(currentState)) {
        this.deps.logger.info('[browser] 文件夹选择器未进入扩展目录，改用地址栏键盘输入');
        for (const keys of [['alt', 'd'], ['ctrl', 'l']]) {
          try {
            await this.callWithDelivery(
              'hotkey',
              { pid: dialog.pid, window_id: dialog.windowId, keys },
              'browser-install:focus-folder-address',
            );
            await sleep(250);
            await this.callWithDelivery(
              'type_text',
              { pid: dialog.pid, window_id: dialog.windowId, text: this.deps.extensionDir },
              'browser-install:type-folder-address',
            );
            await this.callWithDelivery(
              'press_key',
              { pid: dialog.pid, window_id: dialog.windowId, key: 'return' },
              'browser-install:navigate-folder-address',
            );
            await sleep(900);
            if (!(await this.folderDialogAlive(dialog))) return;
            currentState = await this.windowState(dialog);
            if (this.folderPathVisible(currentState)) break;
          } catch (err) {
            this.deps.logger.warn(
              `[browser] 文件夹地址栏兜底失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    // 3) 点击「选择文件夹」确认
    let currentState = await this.windowState(dialog);
    const selectToken =
      findElementToken(currentState, '选择文件夹', ['Button']) ??
      findElementToken(currentState, '选择扩展目录', ['Button']) ??
      findElementToken(currentState, 'Select Folder', ['Button']);
    if (selectToken) {
      await this.clickToken(dialog, selectToken);
    } else {
      await this.callWithDelivery(
        'press_key',
        { pid: dialog.pid, window_id: dialog.windowId, key: 'return' },
        'browser-install:confirm-folder-keyboard',
      );
    }
  }

  private readMarker(): InstallMarkerFile {
    try {
      const raw = JSON.parse(readFileSync(this.markerPath, 'utf8')) as Partial<InstallMarkerFile>;
      if (isRecord(raw.browsers)) {
        return { version: 1, browsers: raw.browsers as Record<string, InstallMarkerEntry> };
      }
    } catch {
      // 首次运行或文件损坏
    }
    return { version: 1, browsers: {} };
  }

  private writeMarker(): void {
    try {
      mkdirSync(this.deps.dirs.root, { recursive: true });
      writeFileSync(this.markerPath, JSON.stringify(this.marker, null, 2), 'utf8');
    } catch {
      // 标记写入失败不影响安装结果
    }
  }
}
