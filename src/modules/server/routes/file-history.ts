// src/modules/server/routes/file-history.ts
// GET  /api/file-history/:sessionId          —— 列出某会话的文件历史
// POST /api/file-history/:sessionId/undo     —— 撤销最近 N 步（body: { steps?: number }）
// POST /api/file-history/:sessionId/restore  —— 恢复指定条目（body: { entryId: string }）

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import { ServiceNames } from '../../../core/types';
import type { ServiceRegistry } from '../../../core/types';
import type { FileHistoryService } from '../../contracts';

function resolveFileHistory(services: ServiceRegistry): FileHistoryService | null {
  return services.tryResolve<FileHistoryService>(ServiceNames.FILE_HISTORY);
}

/** GET /api/file-history/:sessionId —— 列出某会话的文件历史 */
export function createListFileHistoryHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) {
      return { status: 400, body: { error: 'sessionId is required' } };
    }
    const fh = resolveFileHistory(services);
    if (!fh) {
      return { status: 503, body: { error: 'file-history service unavailable' } };
    }
    const entries = fh.listHistory(sessionId);
    // files：按文件聚合的净差异（面板主视图）；entries：逐条历史（卡片底部时间线）
    const files = fh.listNetChanges(sessionId);
    return { status: 200, body: { sessionId, entries, count: entries.length, files } };
  };
}

/** POST /api/file-history/:sessionId/undo —— 撤销最近 N 步 */
export function createUndoFileHistoryHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) {
      return { status: 400, body: { error: 'sessionId is required' } };
    }
    const fh = resolveFileHistory(services);
    if (!fh) {
      return { status: 503, body: { error: 'file-history service unavailable' } };
    }
    const body = (req.body ?? {}) as { steps?: number };
    const steps = Math.min(Math.max(Math.floor(body.steps ?? 1), 1), 20);
    const result = await fh.undo(sessionId, steps);
    return { status: 200, body: { sessionId, ...result } };
  };
}

/** POST /api/file-history/:sessionId/restore —— 恢复指定条目 */
export function createRestoreFileHistoryHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) {
      return { status: 400, body: { error: 'sessionId is required' } };
    }
    const fh = resolveFileHistory(services);
    if (!fh) {
      return { status: 503, body: { error: 'file-history service unavailable' } };
    }
    const body = (req.body ?? {}) as { entryId?: string };
    if (!body.entryId || typeof body.entryId !== 'string') {
      return { status: 400, body: { error: 'entryId is required' } };
    }
    const result = await fh.restore(sessionId, body.entryId);
    return { status: 200, body: { sessionId, entryId: body.entryId, ...result } };
  };
}
