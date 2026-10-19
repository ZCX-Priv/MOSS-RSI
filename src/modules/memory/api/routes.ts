// src/modules/memory/api/routes.ts
// 记忆引擎 HTTP API：
//   GET    /api/memory/tree?cwd=        宫殿树（翼→房间→厅 + 计数）
//   GET    /api/memory?cwd=&wing=&room=&hall=&q=&limit=   记忆列表/搜索（q 走 BM25 + 包含回退）
//   POST   /api/memory                  创建记忆（body: { wing?, room, hall, verbatim, insight, tags?, importance?, pinned? }）
//   GET    /api/memory/:id?cwd=         单条记忆
//   PATCH  /api/memory/:id              更新记忆（body 含 cwd）
//   DELETE /api/memory/:id?cwd=         删除记忆
//   DELETE /api/memory?cwd=&scope=all|global|project  批量清空记忆
//   POST   /api/memory/distill          手动蒸馏（body: { sessionId, cwd }）

import type { HttpRequest, HttpResponse, RouteHandler } from '../../server/types';
import { ServiceNames } from '../../../core/types';
import type { MemoryEngineServiceImpl } from '../service';
import { MEMORY_HALLS } from '../types';
import type { MemoryHall } from '../types';

type ServicesLike = { tryResolve: <T>(name: string) => T | null };

interface AgentEngineLike {
  getSessionForContext(sessionId: string): {
    id: string;
    messages: unknown[];
    memoryState?: {
      l1InjectedAt?: string;
      lastRecallQuery?: string;
      excludeFromRecall?: string[];
      currentRecalled?: string[];
      lastDistilledIndex?: number;
    };
  } | null;
}

function resolveEngine(services: ServicesLike): MemoryEngineServiceImpl | null {
  return services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
}

function cwdFromQuery(req: HttpRequest): string {
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('cwd') || process.cwd();
}

function parseHall(v: unknown): MemoryHall | undefined {
  return typeof v === 'string' && (MEMORY_HALLS as readonly string[]).includes(v)
    ? (v as MemoryHall)
    : undefined;
}

export function createMemoryTreeHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'memory engine unavailable' } };
    return { status: 200, body: engine.palaceTree(cwdFromQuery(req)) };
  };
}

export function createListMemoryHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'memory engine unavailable' } };
    const url = new URL(req.url, 'http://localhost');
    const cwd = url.searchParams.get('cwd') || process.cwd();
    const wing = url.searchParams.get('wing') ?? undefined;
    const room = url.searchParams.get('room') ?? undefined;
    const hall = parseHall(url.searchParams.get('hall'));
    const q = url.searchParams.get('q') ?? '';
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

    let items;
    if (q !== '') {
      // BM25 检索优先；无结果回退关键词包含
      const searched = engine.search(cwd, q, {
        ...(wing ? { wing } : {}),
        ...(room ? { room } : {}),
        ...(hall ? { hall } : {}),
      }, limit);
      items = searched.length > 0 ? searched : engine.searchContains(cwd, q).slice(0, limit);
    } else {
      // 无查询：枚举全量记忆（全局 ∪ 项目），按元数据过滤后 updatedAt 降序
      items = engine.listMemories(
        cwd,
        {
          ...(wing ? { wing } : {}),
          ...(room ? { room } : {}),
          ...(hall ? { hall } : {}),
        },
        limit,
      );
    }
    return { status: 200, body: { items, count: items.length } };
  };
}

export function createCreateMemoryHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'memory engine unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const room = typeof body.room === 'string' ? body.room.trim() : '';
    const insight = typeof body.insight === 'string' ? body.insight : '';
    const hall = parseHall(body.hall);
    if (!room || !insight || !hall) {
      return { status: 400, body: { error: `room, insight and hall (one of ${MEMORY_HALLS.join(', ')}) are required` } };
    }
    try {
      const cwd = cwdFromQuery(req);
      const record = engine.save(cwd, {
        wing: typeof body.wing === 'string' && body.wing !== '' ? body.wing : engine.currentWing(cwd),
        room,
        hall,
        verbatim: typeof body.verbatim === 'string' ? body.verbatim : insight,
        insight,
        ...(Array.isArray(body.tags)
          ? { tags: body.tags.filter((t): t is string => typeof t === 'string') }
          : {}),
        ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
        ...(body.pinned === true ? { pinned: true } : {}),
      });
      return { status: 201, body: record };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createGetMemoryHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'memory engine unavailable' } };
    const record = engine.get(cwdFromQuery(req), id);
    if (!record) return { status: 404, body: { error: 'memory not found' } };
    return { status: 200, body: record };
  };
}

export function createUpdateMemoryHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'memory engine unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hall = parseHall(body.hall);
    try {
      const cwd = cwdFromQuery(req);
      const record = engine.update(cwd, id, {
        ...(typeof body.room === 'string' ? { room: body.room } : {}),
        ...(hall ? { hall } : {}),
        ...(typeof body.verbatim === 'string' ? { verbatim: body.verbatim } : {}),
        ...(typeof body.insight === 'string' ? { insight: body.insight } : {}),
        ...(Array.isArray(body.tags)
          ? { tags: body.tags.filter((t): t is string => typeof t === 'string') }
          : {}),
        ...(typeof body.importance === 'number' ? { importance: body.importance } : {}),
        ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
      });
      if (!record) return { status: 404, body: { error: 'memory not found' } };
      return { status: 200, body: record };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createDeleteMemoryHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'memory engine unavailable' } };
    const ok = engine.delete(cwdFromQuery(req), id);
    if (!ok) return { status: 404, body: { error: 'memory not found' } };
    return { status: 200, body: { ok: true } };
  };
}

export function createClearMemoryHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'memory engine unavailable' } };
    const url = new URL(req.url, 'http://localhost');
    const cwd = url.searchParams.get('cwd') || process.cwd();
    const raw = url.searchParams.get('scope');
    const scope: 'all' | 'global' | 'project' = raw === 'global' || raw === 'project' ? raw : 'all';
    const removed = engine.clear(cwd, scope);
    return { status: 200, body: { ok: true, removed } };
  };
}

export function createDistillMemoryHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'memory engine unavailable' } };
    const body = (req.body ?? {}) as { sessionId?: unknown; cwd?: unknown };
    if (typeof body.sessionId !== 'string' || body.sessionId === '') {
      return { status: 400, body: { error: 'sessionId required' } };
    }
    const agentEngine = services.tryResolve<AgentEngineLike>(ServiceNames.AGENT_ENGINE);
    const session = agentEngine?.getSessionForContext(body.sessionId);
    if (!session) return { status: 404, body: { error: 'session not found' } };
    const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : process.cwd();
    const result = await engine.distillNow(
      session as Parameters<MemoryEngineServiceImpl['distillNow']>[0],
      cwd,
    );
    return { status: 200, body: result };
  };
}
