// src/modules/server/routes/browser.ts
// GET  /api/browser/status                  - 桥接/实例/内置 Chrome/扩展/CfT/AI 标签页
// POST /api/browser/extension/open          - 打开扩展目录（引导用户加载已解压扩展）
// POST /api/browser/builtin                 - {action:'launch'|'close'} 启停内置 Chrome
// POST /api/browser/chrome-for-testing      - {action:'download'} 后台下载 Chrome for Testing

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { BrowserService } from '../../contracts';
import type { ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';

function resolveBrowser(services: ServiceRegistry): BrowserService | null {
  return services.tryResolve<BrowserService>(ServiceNames.BROWSER);
}

/** GET /api/browser/status */
export function createBrowserStatusHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const service = resolveBrowser(services);
    if (!service) return { status: 503, body: { error: 'browser service unavailable' } };
    return { status: 200, body: service.getStatus() };
  };
}

/** POST /api/browser/extension/open */
export function createBrowserOpenExtensionHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const service = resolveBrowser(services);
    if (!service) return { status: 503, body: { error: 'browser service unavailable' } };
    const result = await service.openExtensionDir();
    return { status: 200, body: result };
  };
}

/** POST /api/browser/builtin */
export function createBrowserBuiltinHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveBrowser(services);
    if (!service) return { status: 503, body: { error: 'browser service unavailable' } };
    const body = req.body;
    const action =
      body && typeof body === 'object' && typeof (body as { action?: unknown }).action === 'string'
        ? (body as { action: string }).action
        : '';
    if (action === 'launch') {
      await service.launchBuiltin();
      return { status: 200, body: service.getStatus() };
    }
    if (action === 'close') {
      await service.closeBuiltin();
      return { status: 200, body: service.getStatus() };
    }
    return { status: 400, body: { error: 'action must be launch or close' } };
  };
}

/** POST /api/browser/chrome-for-testing */
export function createBrowserChromeForTestingHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveBrowser(services);
    if (!service) return { status: 503, body: { error: 'browser service unavailable' } };
    const body = req.body;
    const action =
      body && typeof body === 'object' && typeof (body as { action?: unknown }).action === 'string'
        ? (body as { action: string }).action
        : '';
    if (action !== 'download') {
      return { status: 400, body: { error: 'action must be download' } };
    }
    // 后台下载：立即返回当前状态，进度由 /api/browser/status 轮询
    void service.startChromeForTestingDownload();
    return { status: 200, body: service.getStatus() };
  };
}

/** POST /api/browser/install - 手动重跑扩展自动安装 */
export function createBrowserInstallHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveBrowser(services);
    if (!service) return { status: 503, body: { error: 'browser service unavailable' } };
    const body = req.body;
    const action =
      body && typeof body === 'object' && typeof (body as { action?: unknown }).action === 'string'
        ? (body as { action: string }).action
        : '';
    if (action !== 'run') {
      return { status: 400, body: { error: 'action must be run' } };
    }
    void service.autoInstallExtensions(true).catch(() => undefined);
    return { status: 200, body: service.getStatus() };
  };
}
