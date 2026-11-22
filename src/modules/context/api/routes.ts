// src/modules/context/api/routes.ts
// 上下文引擎 HTTP API：
//   GET  /api/context/:sessionId/stats            token 构成 / 缓存命中 / 压缩状态 / 系统上下文分段
//   GET  /api/context/:sessionId/compactions      压缩历史（含摘要全文）
//   GET  /api/context/:sessionId/compact-preview  手动压缩预览（确认框数据）
//   POST /api/context/:sessionId/compact          手动压缩（运行中 409；body: { focus? }）
//   GET  /api/context/summary-models              可选摘要模型列表

import type { HttpRequest, HttpResponse, RouteHandler } from '../../server/types';
import { ServiceNames } from '../../../core/types';
import type { ContextEngineServiceImpl } from './service';

type ServicesLike = { tryResolve: <T>(name: string) => T | null };

function resolveEngine(services: ServicesLike): ContextEngineServiceImpl | null {
  return services.tryResolve<ContextEngineServiceImpl>(ServiceNames.CONTEXT_ENGINE);
}

export function createContextStatsHandler(services: ServicesLike): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) return { status: 400, body: { error: 'sessionId required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'context engine unavailable' } };
    const stats = engine.getStats(sessionId);
    if (!stats) return { status: 404, body: { error: 'session not found' } };
    return { status: 200, body: stats };
  };
}

export function createContextCompactionsHandler(services: ServicesLike): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) return { status: 400, body: { error: 'sessionId required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'context engine unavailable' } };
    return { status: 200, body: { compactions: engine.getCompactions(sessionId) } };
  };
}

export function createCompactPreviewHandler(services: ServicesLike): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) return { status: 400, body: { error: 'sessionId required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'context engine unavailable' } };
    const preview = engine.previewCompact(sessionId);
    if (!preview) return { status: 404, body: { error: 'session not found' } };
    return { status: 200, body: preview };
  };
}

export function createManualCompactHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const sessionId = params?.sessionId;
    if (!sessionId) return { status: 400, body: { error: 'sessionId required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'context engine unavailable' } };

    const body = (req.body ?? {}) as { focus?: unknown };
    const focus =
      typeof body.focus === 'string' && body.focus.trim() !== '' ? body.focus.trim() : undefined;

    const result = await engine.manualCompact(sessionId, focus);
    if (result.ok) {
      return { status: 200, body: { ok: true, compaction: result.compaction } };
    }
    // 运行中 → 409 Conflict；其余按 400
    const busy = result.reason?.includes('running') ?? false;
    return {
      status: busy ? 409 : 400,
      body: { ok: false, error: result.reason ?? 'compaction failed' },
    };
  };
}

export function createSummaryModelsHandler(services: ServicesLike): RouteHandler {
  return async (_req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'context engine unavailable' } };
    return { status: 200, body: { models: engine.getSummaryModels() } };
  };
}
