// src/modules/browser/builtin.ts
// 内置 Chrome：启动/关闭 MOSS 专用 profile 的 Chromium 系浏览器，直连 CDP，
// 并通过 --load-extension 加载 MOSS 扩展（用于创建 AI 标签组）。
//
// 关键点：
// - Chrome 136+ 要求 --remote-debugging-port 必须搭配非默认 --user-data-dir
// - Chrome 137+ 官方构建移除了 --load-extension；实测 Chrome 145 仍需
//   --disable-features=DisableLoadExtensionCommandLineSwitch 才能恢复该命令行加载
// - 扩展 SW 通过 Runtime.evaluate 注入 bridge 端口/token，再 reload 使配置生效

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment, Logger } from '../../core/types';
import { CdpConnection } from './cdp';
import type { BrowserDirs, ChromeExecutable } from './paths';
import type { BrowserBuiltinStatus } from './types';

const LAUNCH_TIMEOUT_MS = 20_000;
const EXTENSION_WAIT_MS = 8_000;

interface TargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
  title?: string;
}

interface TargetListResult {
  targetInfos?: TargetInfo[];
}

interface InjectionResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string };
}

export interface BuiltinChromeDeps {
  env: Environment;
  logger: Logger;
  dirs: BrowserDirs;
  extensionDir: string;
  /** 读取工具配置（每次调用实时读，支持热更新） */
  getOptions: () => {
    browserPath: string;
    bridgePort: number;
    bridgeToken: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BuiltinChromeManager {
  private readonly deps: BuiltinChromeDeps;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private cdp: CdpConnection | null = null;
  private running = false;
  private executable: string | null = null;
  private source: BrowserBuiltinStatus['source'] = null;
  private version: string | null = null;
  private extensionLoaded = false;
  private extensionId: string | null = null;
  private builtinTag: string | null = null;
  private lastError: string | null = null;

  constructor(deps: BuiltinChromeDeps) {
    this.deps = deps;
  }

  getCdp(): CdpConnection | null {
    return this.cdp;
  }

  /** 扩展 WS 已连接但 SW 探测失败时，由服务层补认（恢复分组能力） */
  adoptExtension(extensionId: string): void {
    this.extensionId = extensionId;
    this.extensionLoaded = true;
    if (this.lastError?.includes('未加载 MOSS 扩展')) this.lastError = null;
  }

  /** 本次启动注入扩展 storage 的唯一标记（用于区分外部同名扩展实例） */
  getBuiltinTag(): string | null {
    return this.builtinTag;
  }

  isRunning(): boolean {
    return this.running && this.cdp !== null && !this.cdp.isClosed;
  }

  getProfileDir(): string {
    return this.deps.dirs.profile;
  }

  getStatus(): BrowserBuiltinStatus {
    const running = this.isRunning();
    return {
      running,
      executable: this.executable,
      source: this.source,
      version: this.version,
      profileDir: this.deps.dirs.profile,
      extensionLoaded: running ? this.extensionLoaded : false,
      extensionId: running ? this.extensionId : null,
      error: this.lastError,
    };
  }

  /**
   * 启动内置浏览器。executableOverride 用于 CfT 兜底（不传时按配置/本机探测）。
   */
  async launch(
    resolved: ChromeExecutable,
  ): Promise<{ status: BrowserBuiltinStatus; extensionId: string | null }> {
    if (this.running && this.cdp && !this.cdp.isClosed) {
      return { status: this.getStatus(), extensionId: this.extensionLoaded ? this.extensionId : null };
    }
    await this.close();
    this.lastError = null;
    this.builtinTag = crypto.randomUUID();
    this.executable = resolved.executable;
    this.source = resolved.source;
    this.version = null;

    const portFile = join(this.deps.dirs.profile, 'DevToolsActivePort');
    try {
      rmSync(portFile, { force: true });
    } catch {
      // ignore
    }

    const options = this.deps.getOptions();
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${this.deps.dirs.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
      `--load-extension=${this.deps.extensionDir}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      'about:blank',
    ];
    this.deps.logger.info(`[browser] 启动内置 Chrome: ${resolved.executable}`);
    try {
      this.proc = Bun.spawn([resolved.executable, ...args], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    } catch (err) {
      this.lastError = `启动失败：${err instanceof Error ? err.message : String(err)}`;
      return { status: this.getStatus(), extensionId: null };
    }

    // 等待 DevToolsActivePort（Chrome 启动后会写入端口与 WS 路径）
    let port = 0;
    let wsPath = '';
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const text = await Bun.file(portFile).text().catch(() => '');
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length >= 2) {
          port = Number(lines[0]);
          wsPath = lines[1];
          if (Number.isFinite(port) && port > 0) break;
        }
      }
      if (this.proc.exitCode !== null) break;
      await sleep(250);
    }
    if (!port || !wsPath) {
      const exited = this.proc.exitCode !== null;
      this.lastError = exited
        ? '内置 Chrome 启动后立即退出：profile 可能被其他 Chrome 进程占用'
        : '内置 Chrome 启动超时（未生成 DevToolsActivePort）';
      await this.close();
      return { status: this.getStatus(), extensionId: null };
    }

    try {
      this.cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${wsPath}`, 10_000);
    } catch (err) {
      this.lastError = `CDP 连接失败：${err instanceof Error ? err.message : String(err)}`;
      await this.close();
      return { status: this.getStatus(), extensionId: null };
    }
    this.running = true;
    this.deps.logger.info(`[browser] 内置 Chrome 已就绪（CDP 端口 ${port}）`);
    try {
      const info = await this.cdp.send<{ product?: string }>('Browser.getVersion');
      const match = /\/([\d.]+)/.exec(info.product ?? '');
      if (match) this.version = match[1];
    } catch {
      // 版本读取失败不影响控制
    }

    // 扩展加载：先等 SW 出现；不可用时尝试 Extensions.loadUnpacked（旧版/特殊构建）
    let found = await this.findExtension(EXTENSION_WAIT_MS);
    if (!found) {
      const ok = await this.tryLoadUnpacked();
      if (ok) found = await this.findExtension(EXTENSION_WAIT_MS);
    }
    if (found) {
      this.extensionId = found.extensionId;
      this.extensionLoaded = true;
      await this.injectBridgeSettings(options.bridgePort, options.bridgeToken, found.sessionId);
      this.deps.logger.info(`[browser] 已加载扩展 ${found.extensionId}`);
    } else {
      this.extensionLoaded = false;
      this.extensionId = null;
      this.lastError = '内置 Chrome 已启动，但未加载 MOSS 扩展：AI 标签页将无法分组';
      this.deps.logger.warn(`[browser] ${this.lastError}`);
    }

    return { status: this.getStatus(), extensionId: this.extensionId };
  }

  async close(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      try {
        await cdp.send('Browser.close');
      } catch {
        // Chrome 可能已经退出
      }
      cdp.close();
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      const deadline = Date.now() + 5000;
      while (proc.exitCode === null && Date.now() < deadline) {
        await sleep(100);
      }
      if (proc.exitCode === null) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }
    }
    this.running = false;
    this.extensionLoaded = false;
    this.extensionId = null;
    this.builtinTag = null;
  }

  /** 查找 MOSS 扩展的 Service Worker target，并通过 Runtime.evaluate 确认 manifest.name */
  private async findExtension(timeoutMs: number): Promise<{ extensionId: string; sessionId: string } | null> {
    const cdp = this.cdp;
    if (!cdp) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let targets: TargetInfo[] = [];
      try {
        const list = await cdp.send<TargetListResult>('Target.getTargets');
        targets = Array.isArray(list.targetInfos) ? list.targetInfos : [];
      } catch {
        return null;
      }
      for (const target of targets) {
        if (target.type !== 'service_worker' || typeof target.targetId !== 'string') continue;
        if (typeof target.url !== 'string' || !target.url.startsWith('chrome-extension://')) continue;
        if (!target.url.endsWith('/background.js')) continue;
        try {
          const sessionId = await cdp.attach(target.targetId, 2000);
          const check = await cdp.send<InjectionResult>(
            'Runtime.evaluate',
            {
              expression:
                'JSON.stringify({id: chrome.runtime.id, name: chrome.runtime.getManifest().name})',
              returnByValue: true,
            },
            sessionId,
            2000,
          );
          const raw = check.result?.value;
          if (typeof raw === 'string') {
            const parsed = JSON.parse(raw) as { id?: unknown; name?: unknown };
            if (parsed.name === 'MOSS Browser Bridge' && typeof parsed.id === 'string') {
              return { extensionId: parsed.id, sessionId };
            }
          }
          await cdp.detach(sessionId);
        } catch {
          // 该 SW 不可调试或不是我们的扩展，继续
        }
      }
      await sleep(300);
    }
    return null;
  }

  /** 注入桥接端口/token，然后 reload 扩展使配置生效 */
  private async injectBridgeSettings(port: number, token: string, sessionId: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    const settings = JSON.stringify({
      mossBridge: {
        port,
        token,
        autoConnect: true,
        builtinTag: this.builtinTag ?? '',
      },
    });
    const expression = `chrome.storage.local.set(${settings}).then(() => true).catch(() => false)`;
    try {
      await cdp.send<InjectionResult>(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
        3000,
      );
      // 让 SW 重新读取 storage（top-level settings 只在启动时读取一次）
      await cdp.send<InjectionResult>(
        'Runtime.evaluate',
        { expression: 'setTimeout(() => chrome.runtime.reload(), 0); true', returnByValue: true },
        sessionId,
        2000,
      );
    } catch {
      // 注入失败时仍可能通过扩展默认端口自动连接
    }
  }

  /** Chrome 137+ 官方替代方案：Extensions.loadUnpacked（当前版本仅在 pipe 模式可用，失败时静默） */
  private async tryLoadUnpacked(): Promise<boolean> {
    const cdp = this.cdp;
    if (!cdp) return false;
    try {
      const result = await cdp.send<{ id?: string }>('Extensions.loadUnpacked', {
        path: this.deps.extensionDir,
      });
      if (typeof result.id === 'string') {
        this.deps.logger.info(`[browser] Extensions.loadUnpacked 成功: ${result.id}`);
        return true;
      }
    } catch {
      // 大多数版本通过 WS 不暴露 Extensions 域
    }
    return false;
  }

  /** 找到 URL 前缀匹配的 page target（内置实例建页后用 marker 定位） */
  async findPageTargetByPrefix(prefix: string, timeoutMs = 3000): Promise<string | null> {
    const cdp = this.cdp;
    if (!cdp) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const list = await cdp.send<TargetListResult>('Target.getTargets');
        const targets = Array.isArray(list.targetInfos) ? list.targetInfos : [];
        const hit = targets.find(
          (target) =>
            target.type === 'page' &&
            typeof target.targetId === 'string' &&
            typeof target.url === 'string' &&
            target.url.startsWith(prefix),
        );
        if (hit?.targetId) return hit.targetId;
      } catch {
        return null;
      }
      await sleep(150);
    }
    return null;
  }

  /** 列出所有 page target（建页前后差集兜底用） */
  async listPageTargets(): Promise<Array<{ targetId: string; url: string }>> {
    const cdp = this.cdp;
    if (!cdp) return [];
    try {
      const list = await cdp.send<TargetListResult>('Target.getTargets');
      const targets = Array.isArray(list.targetInfos) ? list.targetInfos : [];
      return targets
        .filter(
          (target): target is TargetInfo & { targetId: string } =>
            target.type === 'page' && typeof target.targetId === 'string',
        )
        .map((target) => ({ targetId: target.targetId, url: typeof target.url === 'string' ? target.url : '' }));
    } catch {
      return [];
    }
  }

  async attach(targetId: string): Promise<string> {
    if (!this.cdp) throw new Error('内置 Chrome 未运行');
    return this.cdp.attach(targetId);
  }

  async detach(sessionId: string): Promise<void> {
    await this.cdp?.detach(sessionId);
  }

  async createPageTarget(url: string): Promise<string> {
    if (!this.cdp) throw new Error('内置 Chrome 未运行');
    const result = await this.cdp.send<{ targetId?: string }>('Target.createTarget', { url });
    if (!result.targetId) throw new Error('创建标签页失败');
    return result.targetId;
  }
}
