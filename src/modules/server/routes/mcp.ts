// src/modules/server/routes/mcp.ts
// MCP 管理路由（列表 / 调用 / 连接 / 服务器定义 CRUD）

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import type { MCPManager } from '../../contracts';
import { ErrorCode } from '../../../core/error-codes';

export function createListMcpServersHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const mgr = services.tryResolve<MCPManager>('mcp.manager');
    if (!mgr) {
      return { status: 200, body: { servers: [] } };
    }
    return { status: 200, body: { servers: mgr.listServers() } };
  };
}

export function createListMcpToolsHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const mgr = services.tryResolve<MCPManager>('mcp.manager');
    if (!mgr) {
      return { status: 200, body: { tools: [] } };
    }
    const serverName = (req.query.server as string) || undefined;
    return { status: 200, body: { tools: mgr.listTools(serverName) } };
  };
}

export function createCallMcpToolHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const mgr = services.tryResolve<MCPManager>('mcp.manager');
    if (!mgr) {
      return { status: 503, body: { error: ErrorCode.MCP_MANAGER_UNAVAILABLE } };
    }
    const body = req.body as { server?: string; tool?: string; arguments?: unknown } | undefined;
    if (!body?.server || !body?.tool) {
      return { status: 400, body: { error: ErrorCode.MCP_SERVER_AND_TOOL_REQUIRED } };
    }
    try {
      const result = await mgr.callTool(body.server, body.tool, body.arguments ?? {});
      return { status: 200, body: result };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createConnectMcpServerHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const mgr = services.tryResolve<MCPManager>('mcp.manager');
    if (!mgr) {
      return { status: 503, body: { error: ErrorCode.MCP_MANAGER_UNAVAILABLE } };
    }
    const body = req.body as { server?: string } | undefined;
    if (!body?.server) {
      return { status: 400, body: { error: ErrorCode.MCP_SERVER_REQUIRED } };
    }
    try {
      await mgr.connect(body.server);
      return { status: 200, body: { connected: true, server: body.server } };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createDisconnectMcpServerHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const mgr = services.tryResolve<MCPManager>('mcp.manager');
    if (!mgr) {
      return { status: 503, body: { error: ErrorCode.MCP_MANAGER_UNAVAILABLE } };
    }
    const body = req.body as { server?: string } | undefined;
    if (!body?.server) {
      return { status: 400, body: { error: ErrorCode.MCP_SERVER_REQUIRED } };
    }
    try {
      await mgr.disconnect(body.server);
      return { status: 200, body: { disconnected: true, server: body.server } };
    } catch (err) {
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/** POST /api/mcp/servers — 新建服务器定义（body: { name, ...ServerConfig }） */
export function createCreateMcpServerHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const mgr = services.tryResolve<MCPManager>('mcp.manager');
    if (!mgr) {
      return { status: 503, body: { error: ErrorCode.MCP_MANAGER_UNAVAILABLE } };
    }
    const body = req.body as { name?: string } & Record<string, unknown> | undefined;
    if (!body?.name) {
      return { status: 400, body: { error: ErrorCode.MCP_SERVER_REQUIRED } };
    }
    const { name, ...def } = body;
    try {
      // 写盘成功即返回；后台连接（首次 npx/uvx 启动可能较慢，不能阻塞添加请求）
      await mgr.createServer(name, def, { connect: false });
      if ((def as { enabled?: boolean }).enabled !== false) {
        void mgr.connect(name).catch(() => {});
      }
      return { status: 201, body: { created: true, server: name } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/** PUT /api/mcp/servers/:name — 更新服务器定义（含 enabled 切换；body: ServerConfig） */
export function createUpdateMcpServerHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const mgr = services.tryResolve<MCPManager>('mcp.manager');
    if (!mgr) {
      return { status: 503, body: { error: ErrorCode.MCP_MANAGER_UNAVAILABLE } };
    }
    const name = params?.name;
    if (!name) {
      return { status: 400, body: { error: ErrorCode.MCP_SERVER_REQUIRED } };
    }
    try {
      // 部分更新在 manager 内与现有定义合并（如仅切换 enabled）；写盘后立即返回
      await mgr.updateServer(name, req.body, { connect: false });
      const body = req.body as { enabled?: unknown } | undefined;
      if (body?.enabled !== false) {
        void mgr.connect(name).catch(() => {});
      }
      return { status: 200, body: { updated: true, server: name } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

/** DELETE /api/mcp/servers/:name — 删除服务器定义 */
export function createDeleteMcpServerHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const mgr = services.tryResolve<MCPManager>('mcp.manager');
    if (!mgr) {
      return { status: 503, body: { error: ErrorCode.MCP_MANAGER_UNAVAILABLE } };
    }
    const name = params?.name;
    if (!name) {
      return { status: 400, body: { error: ErrorCode.MCP_SERVER_REQUIRED } };
    }
    try {
      await mgr.deleteServer(name);
      return { status: 200, body: { deleted: true, server: name } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}
