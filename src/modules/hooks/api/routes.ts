// src/modules/hooks/api/routes.ts
// 钩子引擎 HTTP API：
//   GET    /api/hooks?cwd=            双作用域钩子列表（global + project 分组 + 可用事件）
//   POST   /api/hooks                 创建钩子（body: { name, event, matcher?, type, command?/modulePath?, timeout?, enabled?, scope }）
//   GET    /api/hooks/:id?cwd=        单条钩子
//   PATCH  /api/hooks/:id             更新钩子
//   DELETE /api/hooks/:id?cwd=        删除钩子
//   POST   /api/hooks/:id/test        测试触发（body: { cwd, sampleInput }）
//   GET    /api/hooks/history         执行历史（最新在前）

import type { HttpRequest, HttpResponse, RouteHandler } from '../../server/types';
import { ServiceNames } from '../../../core/types';
import type { HooksEngineServiceImpl } from '../service';
import { HOOK_EVENTS } from '../types';
import type { HookEvent, HookScope } from '../types';

type ServicesLike = { tryResolve: <T>(name: string) => T | null };

function resolveEngine(services: ServicesLike): HooksEngineServiceImpl | null {
  return services.tryResolve<HooksEngineServiceImpl>(ServiceNames.HOOKS_ENGINE);
}

function cwdFromQuery(req: HttpRequest): string {
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('cwd') || process.cwd();
}

function parseScope(v: unknown): HookScope {
  return v === 'project' ? 'project' : 'global';
}

function parseEvent(v: unknown): HookEvent | null {
  return typeof v === 'string' && (HOOK_EVENTS as readonly string[]).includes(v)
    ? (v as HookEvent)
    : null;
}

export function createListHooksHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'hooks engine unavailable' } };
    const cwd = cwdFromQuery(req);
    const list = engine.list(cwd);
    return {
      status: 200,
      body: {
        ...list,
        events: HOOK_EVENTS,
        scripts: {
          project: engine.scripts(cwd, 'project'),
          global: engine.scripts(cwd, 'global'),
        },
      },
    };
  };
}

export function createCreateHookHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'hooks engine unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return { status: 400, body: { error: 'name required' } };
    }
    const event = parseEvent(body.event);
    if (!event) return { status: 400, body: { error: `event must be one of ${HOOK_EVENTS.join(', ')}` } };
    const type = body.type === 'module' ? 'module' : 'terminal';
    try {
      const cwd = cwdFromQuery(req);
      const record = engine.upsert(cwd, parseScope(body.scope), {
        name: body.name.trim(),
        event,
        ...(typeof body.matcher === 'string' ? { matcher: body.matcher || null } : { matcher: null }),
        type,
        ...(typeof body.command === 'string' ? { command: body.command } : {}),
        ...(typeof body.modulePath === 'string' ? { modulePath: body.modulePath } : {}),
        ...(typeof body.timeout === 'number' ? { timeout: body.timeout } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
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

export function createGetHookHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'hooks engine unavailable' } };
    const record = engine.get(cwdFromQuery(req), id);
    if (!record) return { status: 404, body: { error: 'hook not found' } };
    return { status: 200, body: record };
  };
}

export function createUpdateHookHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'hooks engine unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const cwd = cwdFromQuery(req);
      const existing = engine.get(cwd, id);
      if (!existing) return { status: 404, body: { error: 'hook not found' } };
      const event = parseEvent(body.event ?? existing.event) ?? existing.event;
      const type = body.type === 'module' || body.type === 'terminal' ? body.type : existing.type;
      const record = engine.upsert(
        cwd,
        parseScope(body.scope ?? existing.scope),
        {
          name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : existing.name,
          event,
          ...(typeof body.matcher === 'string' ? { matcher: body.matcher || null } : { matcher: existing.matcher }),
          type,
          ...(typeof body.command === 'string' ? { command: body.command } : { command: existing.command }),
          ...(typeof body.modulePath === 'string' ? { modulePath: body.modulePath } : { modulePath: existing.modulePath }),
          ...(typeof body.timeout === 'number' ? { timeout: body.timeout } : { timeout: existing.timeout }),
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : { enabled: existing.enabled }),
        },
        id,
      );
      return { status: 200, body: record };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createDeleteHookHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'hooks engine unavailable' } };
    const ok = engine.delete(cwdFromQuery(req), id);
    if (!ok) return { status: 404, body: { error: 'hook not found' } };
    return { status: 200, body: { ok: true } };
  };
}

export function createTestHookHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'hooks engine unavailable' } };
    const body = (req.body ?? {}) as {
      cwd?: unknown;
      sessionId?: unknown;
      toolName?: unknown;
      toolInput?: unknown;
      prompt?: unknown;
    };
    const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : cwdFromQuery(req);
    const result = await engine.testFire(cwd, id, {
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(typeof body.toolName === 'string' ? { toolName: body.toolName } : {}),
      ...(body.toolInput && typeof body.toolInput === 'object'
        ? { toolInput: body.toolInput as Record<string, unknown> }
        : {}),
      ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
    });
    if (!result) return { status: 404, body: { error: 'hook not found' } };
    return { status: 200, body: result };
  };
}

export function createHookHistoryHandler(services: ServicesLike): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'hooks engine unavailable' } };
    return { status: 200, body: { history: engine.getHistory() } };
  };
}
