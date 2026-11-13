// src/modules/rules/api/routes.ts
// 规则引擎 HTTP API：
//   GET    /api/rules?cwd=          双作用域规则列表（global + project 分组）
//   POST   /api/rules               创建规则（body: { name, description?, content, paths?, scope, enabled?, priority? }）
//   GET    /api/rules/:id?cwd=      单条规则
//   PATCH  /api/rules/:id           更新规则（body 含 cwd + scope + 字段；内容变化自动迁移哈希文件）
//   DELETE /api/rules/:id?cwd=      删除规则

import type { HttpRequest, HttpResponse, RouteHandler } from '../../server/types';
import { ServiceNames } from '../../../core/types';
import type { RulesEngineServiceImpl } from '../service';
import type { RuleScope } from '../types';

type ServicesLike = { tryResolve: <T>(name: string) => T | null };

function resolveEngine(services: ServicesLike): RulesEngineServiceImpl | null {
  return services.tryResolve<RulesEngineServiceImpl>(ServiceNames.RULES_ENGINE);
}

/** 从 query 解析 cwd（缺省服务进程 cwd） */
function cwdFromQuery(req: HttpRequest): string {
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('cwd') || process.cwd();
}

/** 校验 scope 字段 */
function parseScope(v: unknown): RuleScope {
  return v === 'project' ? 'project' : 'global';
}

export function createListRulesHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'rules engine unavailable' } };
    const cwd = cwdFromQuery(req);
    return { status: 200, body: { ...engine.list(cwd), dirs: engine.dirs(cwd) } };
  };
}

export function createCreateRuleHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'rules engine unavailable' } };
    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      content?: unknown;
      paths?: unknown;
      scope?: unknown;
      enabled?: unknown;
      priority?: unknown;
    };
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return { status: 400, body: { error: 'name required' } };
    }
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      return { status: 400, body: { error: 'content required' } };
    }
    try {
      const cwd = cwdFromQuery(req);
      const record = engine.upsert(cwd, parseScope(body.scope), {
        name: body.name.trim(),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        content: body.content,
        ...(Array.isArray(body.paths)
          ? { paths: body.paths.filter((p): p is string => typeof p === 'string') }
          : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
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

export function createGetRuleHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'rules engine unavailable' } };
    const record = engine.get(cwdFromQuery(req), id);
    if (!record) return { status: 404, body: { error: 'rule not found' } };
    return { status: 200, body: record };
  };
}

export function createUpdateRuleHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'rules engine unavailable' } };
    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      content?: unknown;
      paths?: unknown;
      scope?: unknown;
      enabled?: unknown;
      priority?: unknown;
    };
    try {
      const cwd = cwdFromQuery(req);
      const existing = engine.get(cwd, id);
      if (!existing) return { status: 404, body: { error: 'rule not found' } };
      const record = engine.upsert(
        cwd,
        parseScope(body.scope ?? existing.scope),
        {
          name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : existing.name,
          ...(typeof body.description === 'string' ? { description: body.description } : { description: existing.description }),
          content: typeof body.content === 'string' ? body.content : existing.content,
          ...(Array.isArray(body.paths)
            ? { paths: body.paths.filter((p): p is string => typeof p === 'string') }
            : { paths: existing.paths }),
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : { enabled: existing.enabled }),
          ...(typeof body.priority === 'number' ? { priority: body.priority } : { priority: existing.priority }),
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

/** DELETE /api/rules?cwd=&scope=all|global|project：批量清空规则 */
export function createClearRulesHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'rules engine unavailable' } };
    const url = new URL(req.url, 'http://localhost');
    const cwd = url.searchParams.get('cwd') || process.cwd();
    const raw = url.searchParams.get('scope');
    const scope: 'all' | 'global' | 'project' = raw === 'global' || raw === 'project' ? raw : 'all';
    const removed = engine.clear(cwd, scope);
    return { status: 200, body: { ok: true, removed } };
  };
}

export function createDeleteRuleHandler(services: ServicesLike): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'id required' } };
    const engine = resolveEngine(services);
    if (!engine) return { status: 503, body: { error: 'rules engine unavailable' } };
    const ok = engine.delete(cwdFromQuery(req), id);
    if (!ok) return { status: 404, body: { error: 'rule not found' } };
    return { status: 200, body: { ok: true } };
  };
}
