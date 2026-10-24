// src/modules/server/routes/computer.ts
// GET  /api/computer/status     - 驱动/连接/暂停状态 + 最近活动
// GET  /api/computer/windows    - 窗口列表（面板目标选择器）
// GET  /api/computer/screenshot - 面板实时画面（PNG 字节）
// POST /api/computer/install    - 安装 cua-driver（仅 Windows；用户显式触发）
// POST /api/computer/control    - pause / resume / reconnect

import { readFileSync } from 'node:fs';
import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ConfigService, ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { ComputerCapture, ComputerService, ComputerWindowInfo } from '../../contracts';

/** 默认截图长边上限（与 computer 工具默认值一致） */
const DEFAULT_MAX_IMAGE_DIMENSION = 1280;

function resolveComputer(services: ServiceRegistry): ComputerService | null {
  return services.tryResolve<ComputerService>(ServiceNames.COMPUTER);
}

function computerMaxImageDimension(config: ConfigService): number {
  try {
    const tools = config.getAppConfig().tools as Record<string, Record<string, unknown>>;
    const value = tools.computer?.maxImageDimension;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_MAX_IMAGE_DIMENSION;
  } catch {
    return DEFAULT_MAX_IMAGE_DIMENSION;
  }
}

/** 从 cua list_windows 结果中提取窗口数组（structured 优先，text JSON 兜底） */
function extractWindows(structured: unknown, text: string): ComputerWindowInfo[] {
  let data: unknown = structured;
  if (!data) {
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) data = JSON.parse(trimmed);
    } catch {
      // 非 JSON 文本：返回空列表
    }
  }
  if (!data || typeof data !== 'object') return [];

  const record = data as Record<string, unknown>;
  const rawList = Array.isArray(record.windows)
    ? record.windows
    : Array.isArray(data)
      ? data
      : [];
  const windows: ComputerWindowInfo[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const windowId = typeof w.window_id === 'number' ? w.window_id : undefined;
    const pid = typeof w.pid === 'number' ? w.pid : undefined;
    if (windowId === undefined || pid === undefined) continue;
    // 过滤 cua 自己的合成光标覆盖层（实现细节；截图会被驱动拒绝）
    const appName = typeof w.app_name === 'string' ? w.app_name : '';
    const title = typeof w.title === 'string' ? w.title : '';
    if (appName === 'cua-driver.exe' || title.startsWith('Cua.AgentCursorOverlay')) continue;
    const bounds =
      w.bounds && typeof w.bounds === 'object'
        ? (() => {
            const b = w.bounds as Record<string, unknown>;
            const x = typeof b.x === 'number' ? b.x : 0;
            const y = typeof b.y === 'number' ? b.y : 0;
            const width = typeof b.width === 'number' ? b.width : 0;
            const height = typeof b.height === 'number' ? b.height : 0;
            return { x, y, width, height };
          })()
        : undefined;
    windows.push({
      window_id: windowId,
      pid,
      ...(typeof w.app_name === 'string' ? { app_name: w.app_name } : {}),
      ...(typeof w.title === 'string' ? { title: w.title } : {}),
      ...(bounds ? { bounds } : {}),
      ...(typeof w.is_on_screen === 'boolean' ? { is_on_screen: w.is_on_screen } : {}),
      ...(typeof w.z_index === 'number' || w.z_index === null ? { z_index: w.z_index as number | null } : {}),
    });
  }
  return windows;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** GET /api/computer/status?sessionId= */
export function createComputerStatusHandler(
  services: ServiceRegistry,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveComputer(services);
    if (!service) {
      return { status: 503, body: { error: 'computer service unavailable' } };
    }
    const sessionId = (req.query.sessionId ?? '').trim() || undefined;
    return {
      status: 200,
      body: {
        ...service.getStatus(),
        activities: service.getActivities(sessionId),
      },
    };
  };
}

/** GET /api/computer/windows?onScreenOnly=1 */
export function createComputerWindowsHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveComputer(services);
    if (!service) {
      return { status: 503, body: { error: 'computer service unavailable' } };
    }
    const onScreenOnly = req.query.onScreenOnly !== '0';
    try {
      const result = await service.callTool(
        'list_windows',
        { on_screen_only: onScreenOnly },
        { source: 'panel', sessionLabel: 'moss_panel', timeoutMs: 20_000 },
      );
      return {
        status: 200,
        body: { windows: extractWindows(result.structured, result.text) },
      };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/** GET /api/computer/screenshot?target=desktop|window&pid=&windowId=&maxDimension= */
export function createComputerScreenshotHandler(
  services: ServiceRegistry,
  config: ConfigService,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveComputer(services);
    if (!service) {
      return { status: 503, body: { error: 'computer service unavailable' } };
    }

    const target = (req.query.target ?? 'desktop').trim();
    const requestedMax = parseNumber(req.query.maxDimension);
    const maxDimension =
      requestedMax !== undefined && requestedMax >= 0
        ? requestedMax
        : computerMaxImageDimension(config);

    try {
      let capture: ComputerCapture;
      if (target === 'window') {
        const pid = parseNumber(req.query.pid);
        const windowId = parseNumber(req.query.windowId);
        if (pid === undefined || windowId === undefined) {
          return { status: 400, body: { error: 'pid and windowId are required for target=window' } };
        }
        capture = await service.captureWindow(pid, windowId, { maxImageDimension: maxDimension });
      } else if (target === 'desktop') {
        capture = await service.captureDesktop({ maxImageDimension: maxDimension });
      } else {
        return { status: 400, body: { error: 'target must be desktop or window' } };
      }

      const file = readFileSync(capture.path);
      return {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(file.length),
          'Cache-Control': 'no-store',
        },
        body: new Uint8Array(file),
      };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/** POST /api/computer/install */
export function createComputerInstallHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const service = resolveComputer(services);
    if (!service) {
      return { status: 503, body: { error: 'computer service unavailable' } };
    }
    const result = await service.install();
    return { status: result.ok ? 200 : 500, body: result };
  };
}

/** POST /api/computer/control { action: 'pause' | 'resume' | 'reconnect' } */
export function createComputerControlHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveComputer(services);
    if (!service) {
      return { status: 503, body: { error: 'computer service unavailable' } };
    }
    const body = (req.body ?? {}) as { action?: unknown };
    const action = typeof body.action === 'string' ? body.action : '';

    try {
      if (action === 'pause') {
        service.setPaused(true);
      } else if (action === 'resume') {
        service.setPaused(false);
      } else if (action === 'reconnect') {
        await service.reconnect();
      } else {
        return { status: 400, body: { error: 'action must be pause, resume or reconnect' } };
      }
      return { status: 200, body: service.getStatus() };
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}
