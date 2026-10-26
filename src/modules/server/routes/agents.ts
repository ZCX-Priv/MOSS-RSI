// src/modules/server/routes/agents.ts
// Agent 管理 CRUD 路由
// GET    /api/agents         —— 列出所有 Agent + 默认 id
// POST   /api/agents         —— 创建 Agent
// GET    /api/agents/:id     —— 获取 Agent 详情
// PATCH  /api/agents/:id     —— 更新 Agent
// DELETE /api/agents/:id     —— 删除 Agent
// PUT    /api/agents/default —— 设置默认 Agent

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { AgentRegistry, AgentDetail } from '../../subagent/types';
import { ErrorCode } from '../../../core/error-codes';

function resolveRegistry(services: ServiceRegistry): AgentRegistry | null {
  return services.tryResolve<AgentRegistry>(ServiceNames.AGENT_REGISTRY);
}

export function createListAgentsHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const reg = resolveRegistry(services);
    if (!reg) {
      return { status: 200, body: { agents: [], default: '' } };
    }
    const agents = reg.list();
    const defaultAgent = reg.getDefault();
    return { status: 200, body: { agents, default: defaultAgent.id } };
  };
}

export function createCreateAgentHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const reg = resolveRegistry(services);
    if (!reg) {
      return { status: 503, body: { error: ErrorCode.AGENT_REGISTRY_UNAVAILABLE } };
    }
    const body = (req.body ?? {}) as {
      name?: string;
      description?: string;
      systemPrompt?: string;
      model?: string;
      tools?: string[];
      icon?: string;
      maxTurns?: number;
      maxTokens?: number;
    };
    if (!body.name) {
      return { status: 400, body: { error: ErrorCode.AGENT_NAME_REQUIRED } };
    }
    const agent = reg.create({
      name: body.name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      model: body.model,
      tools: body.tools,
      icon: body.icon,
      maxTurns: body.maxTurns,
      maxTokens: body.maxTokens,
    });
    return { status: 201, body: agent };
  };
}

export function createGetAgentHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.AGENT_ID_REQUIRED } };
    }
    const reg = resolveRegistry(services);
    if (!reg) {
      return { status: 503, body: { error: ErrorCode.AGENT_REGISTRY_UNAVAILABLE } };
    }
    const agent = reg.get(id);
    if (!agent) {
      return { status: 404, body: { error: ErrorCode.AGENT_NOT_FOUND } };
    }
    return { status: 200, body: agent };
  };
}

export function createUpdateAgentHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.AGENT_ID_REQUIRED } };
    }
    const reg = resolveRegistry(services);
    if (!reg) {
      return { status: 503, body: { error: ErrorCode.AGENT_REGISTRY_UNAVAILABLE } };
    }
    const body = (req.body ?? {}) as Partial<AgentDetail>;
    const agent = reg.update(id, body);
    if (!agent) {
      return { status: 404, body: { error: ErrorCode.AGENT_NOT_FOUND_OR_BUILTIN } };
    }
    return { status: 200, body: agent };
  };
}

export function createDeleteAgentHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.AGENT_ID_REQUIRED } };
    }
    const reg = resolveRegistry(services);
    if (!reg) {
      return { status: 503, body: { error: ErrorCode.AGENT_REGISTRY_UNAVAILABLE } };
    }
    const deleted = reg.remove(id);
    if (!deleted) {
      return {
        status: 404,
        body: { error: ErrorCode.AGENT_NOT_FOUND_BUILTIN_DEFAULT },
      };
    }
    return { status: 200, body: { deleted: true } };
  };
}

export function createSetDefaultAgentHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const reg = resolveRegistry(services);
    if (!reg) {
      return { status: 503, body: { error: ErrorCode.AGENT_REGISTRY_UNAVAILABLE } };
    }
    const body = (req.body ?? {}) as { id?: string };
    if (!body.id) {
      return { status: 400, body: { error: ErrorCode.ID_REQUIRED } };
    }
    const ok = reg.setDefault(body.id);
    if (!ok) {
      return { status: 404, body: { error: ErrorCode.AGENT_NOT_FOUND } };
    }
    return { status: 200, body: { default: body.id } };
  };
}
