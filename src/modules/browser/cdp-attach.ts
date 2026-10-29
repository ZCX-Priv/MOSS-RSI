// src/modules/browser/cdp-attach.ts
// 外部 CDP 直连：附着到用户自行以 --remote-debugging-port 启动的 Chromium 浏览器 / Electron 应用。
// 与 BuiltinChromeManager 的区别：不负责启动进程，只负责“发现浏览器级 WebSocket → 连接 → 页面 target 操作”。
//
// 端点发现：
// - ws:// / wss://            直接作为浏览器级 WebSocket
// - http(s)://host:port       请求 /json/version 取 webSocketDebuggerUrl
// - host:port / 纯端口        补 http:// 后同上

import { t } from '../../core/i18n';
import type { Logger } from '../../core/types';
import { CdpConnection } from './cdp';
import type { BrowserCdpStatus } from './types';

const DISCOVERY_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 10_000;

interface TargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
  title?: string;
}

interface TargetListResult {
  targetInfos?: TargetInfo[];
}

interface VersionResult {
  product?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 端点规范化结果：ws 直接连接；http 需要先发现浏览器级 WS */
export interface NormalizedCdpEndpoint {
  kind: 'ws' | 'http';
  value: string;
  /** 用于状态展示与去重的规范形式 */
  display: string;
}

export function normalizeCdpEndpoint(input: string): NormalizedCdpEndpoint {
  const raw = input.trim();
  if (!raw) {
    const fallback = 'http://127.0.0.1:9222';
    return { kind: 'http', value: fallback, display: fallback };
  }
  if (/^\d+$/.test(raw)) {
    const value = `http://127.0.0.1:${raw}`;
    return { kind: 'http', value, display: value };
  }
  if (/^wss?:\/\//i.test(raw)) {
    return { kind: 'ws', value: raw, display: raw };
  }
  const value = (/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).replace(/\/+$/, '');
  return { kind: 'http', value, display: value };
}

/** 通过 /json/version 读取浏览器级 WebSocket 地址 */
async function discoverWsUrl(httpBase: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const resp = await fetch(`${httpBase}/json/version`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`GET /json/version 返回 HTTP ${resp.status}`);
    const data = (await resp.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof data.webSocketDebuggerUrl !== 'string' || !data.webSocketDebuggerUrl) {
      throw new Error('GET /json/version 未返回 webSocketDebuggerUrl');
    }
    return data.webSocketDebuggerUrl;
  } finally {
    clearTimeout(timer);
  }
}

export interface CdpBrowserManagerDeps {
  logger: Logger;
  /** 每次实时读取配置的默认端点（支持热更新） */
  getDefaultEndpoint: () => string;
}

export class CdpBrowserManager {
  private readonly deps: CdpBrowserManagerDeps;
  private cdp: CdpConnection | null = null;
  private endpoint = '';
  private resolvedUrl: string | null = null;
  private product: string | null = null;
  private version: string | null = null;
  private targetCount = 0;
  private lastError: string | null = null;

  constructor(deps: CdpBrowserManagerDeps) {
    this.deps = deps;
  }

  getStatus(): BrowserCdpStatus {
    const connected = this.isConnected();
    return {
      connected,
      endpoint: this.endpoint || this.deps.getDefaultEndpoint(),
      resolvedUrl: this.resolvedUrl,
      product: this.product,
      version: this.version,
      targetCount: connected ? this.targetCount : 0,
      error: this.lastError,
    };
  }

  isConnected(): boolean {
    return this.cdp !== null && !this.cdp.isClosed;
  }

  getCdp(): CdpConnection | null {
    return this.cdp;
  }

  /** 连接（或复用）外部 CDP 端点；失败抛错并记录 error */
  async connect(endpoint?: string): Promise<BrowserCdpStatus> {
    const normalized = normalizeCdpEndpoint(endpoint?.trim() || this.deps.getDefaultEndpoint());
    if (this.isConnected() && this.endpoint === normalized.display) {
      return this.getStatus();
    }

    await this.disconnect();
    this.endpoint = normalized.display;
    this.lastError = null;

    try {
      const wsUrl =
        normalized.kind === 'ws' ? normalized.value : await discoverWsUrl(normalized.value);
      const cdp = await CdpConnection.connect(wsUrl, CONNECT_TIMEOUT_MS);
      this.cdp = cdp;
      this.resolvedUrl = wsUrl;

      const info = await cdp.send<VersionResult>('Browser.getVersion');
      this.product = typeof info.product === 'string' ? info.product : null;
      const match = /\/([\d.]+)/.exec(info.product ?? '');
      this.version = match ? match[1] : null;
      this.targetCount = (await this.listPageTargets()).length;

      this.deps.logger.info(`[browser] 已连接外部 CDP（${this.endpoint} → ${wsUrl}）`);
      return this.getStatus();
    } catch (err) {
      this.cdp = null;
      this.resolvedUrl = null;
      this.product = null;
      this.version = null;
      this.targetCount = 0;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`[browser] 连接外部 CDP 失败（${this.endpoint}）：${this.lastError}`);
      throw new Error(t('browser.cdpConnectFailed', { error: this.lastError }));
    }
  }

  async disconnect(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      try {
        cdp.close();
      } catch {
        // 连接可能已关闭
      }
    }
    this.resolvedUrl = null;
    this.product = null;
    this.version = null;
    this.targetCount = 0;
    this.lastError = null;
  }

  /** 列出页面 target（含 targetId/url/title） */
  async listPageTargets(): Promise<Array<{ targetId: string; url: string; title: string }>> {
    const cdp = this.cdp;
    if (!cdp || cdp.isClosed) return [];
    try {
      const list = await cdp.send<TargetListResult>('Target.getTargets');
      const targets = Array.isArray(list.targetInfos) ? list.targetInfos : [];
      const pages = targets
        .filter(
          (target): target is TargetInfo & { targetId: string } =>
            target.type === 'page' && typeof target.targetId === 'string',
        )
        .map((target) => ({
          targetId: target.targetId,
          url: typeof target.url === 'string' ? target.url : '',
          title: typeof target.title === 'string' ? target.title : '',
        }));
      this.targetCount = pages.length;
      return pages;
    } catch {
      return [];
    }
  }

  /** 找到 URL 前缀匹配的页面 target（建页后定位 marker） */
  async findPageTargetByPrefix(prefix: string, timeoutMs = 3000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pages = await this.listPageTargets();
      const hit = pages.find((page) => page.url.startsWith(prefix));
      if (hit) return hit.targetId;
      if (!this.isConnected()) return null;
      await sleep(150);
    }
    return null;
  }

  async createPageTarget(url: string): Promise<string> {
    const cdp = this.cdp;
    if (!cdp || cdp.isClosed) throw new Error(t('browser.cdpNotConnected'));
    const result = await cdp.send<{ targetId?: string }>('Target.createTarget', { url });
    if (!result.targetId) throw new Error(t('browser.tabCreateFailed'));
    this.targetCount += 1;
    return result.targetId;
  }

  async attach(targetId: string): Promise<string> {
    const cdp = this.cdp;
    if (!cdp || cdp.isClosed) throw new Error(t('browser.cdpNotConnected'));
    return cdp.attach(targetId);
  }

  async detach(sessionId: string): Promise<void> {
    await this.cdp?.detach(sessionId);
  }

  async activate(targetId: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp || cdp.isClosed) return;
    await cdp.send('Target.activateTarget', { targetId }).catch(() => undefined);
  }

  async closeTarget(targetId: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp || cdp.isClosed) return;
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    this.targetCount = Math.max(0, this.targetCount - 1);
  }
}
