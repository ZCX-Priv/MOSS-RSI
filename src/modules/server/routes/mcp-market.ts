// src/modules/server/routes/mcp-market.ts
// MCP 市场路由：搜索 / 详情 / 安装（默认数据源 mcpmarket，可切换 official / modelscope）
//
// 核心逻辑在 mcp/market.ts；本文件只做输入收敛、错误码映射与 HTTP 响应。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import { ErrorCode } from '../../../core/error-codes';
import {
  McpMarketError,
  type McpManualInstall,
  type McpMarketService,
  type McpMarketSource,
} from '../../mcp/market';

function resolveMarket(services: ServiceRegistry): McpMarketService | null {
  return services.tryResolve<McpMarketService>(ServiceNames.MCP_MARKET);
}

function readSource(raw: unknown): McpMarketSource | undefined {
  return typeof raw === 'string' && raw ? (raw as McpMarketSource) : undefined;
}

function errorResponse(err: unknown): HttpResponse {
  if (err instanceof McpMarketError) {
    switch (err.code) {
      case 'SOURCE_INVALID':
        return {
          status: 400,
          body: { error: ErrorCode.MCP_MARKET_SOURCE_INVALID, message: err.message },
        };
      case 'ENV_REQUIRED':
        return {
          status: 400,
          body: {
            error: ErrorCode.MCP_MARKET_ENV_REQUIRED,
            message: err.message,
            missing: Array.isArray(err.details?.missing) ? err.details.missing : [],
          },
        };
      case 'NAME_CONFLICT':
        return {
          status: 409,
          body: {
            error: ErrorCode.MCP_MARKET_NAME_CONFLICT,
            message: err.message,
            suggestedName: err.details?.suggestedName,
          },
        };
      case 'NAME_INVALID':
        return {
          status: 400,
          body: { error: ErrorCode.MCP_MARKET_NAME_INVALID, message: err.message },
        };
      case 'NOT_FOUND':
        return {
          status: 404,
          body: { error: ErrorCode.MCP_MARKET_NOT_FOUND, message: err.message },
        };
      case 'NO_INSTALL_OPTION':
        return {
          status: 400,
          body: { error: ErrorCode.MCP_MARKET_NO_OPTION, message: err.message },
        };
      case 'OPTION_INVALID':
        return {
          status: 400,
          body: { error: ErrorCode.MCP_MARKET_OPTION_INVALID, message: err.message },
        };
      case 'UPSTREAM_UNAVAILABLE':
        return {
          status: 502,
          body: { error: ErrorCode.MCP_MARKET_UNAVAILABLE, message: err.message },
        };
      case 'INSTALL_FAILED':
        return { status: 500, body: { error: err.message } };
    }
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

/** POST /api/mcp/market/query —— 搜索/浏览市场 */
export function createMcpMarketQueryHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const market = resolveMarket(services);
    if (!market) {
      return { status: 503, body: { error: ErrorCode.MCP_MARKET_UNAVAILABLE } };
    }
    const body = (req.body ?? {}) as {
      source?: unknown;
      keyword?: unknown;
      pageToken?: unknown;
      pageSize?: unknown;
    };
    try {
      const result = await market.query({
        source: readSource(body.source),
        keyword: typeof body.keyword === 'string' ? body.keyword : '',
        pageToken: typeof body.pageToken === 'string' ? body.pageToken : undefined,
        pageSize:
          typeof body.pageSize === 'number' && Number.isFinite(body.pageSize)
            ? body.pageSize
            : undefined,
      });
      return { status: 200, body: result };
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** POST /api/mcp/market/detail —— 拉取安装配置元数据 */
export function createMcpMarketDetailHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const market = resolveMarket(services);
    if (!market) {
      return { status: 503, body: { error: ErrorCode.MCP_MARKET_UNAVAILABLE } };
    }
    const body = (req.body ?? {}) as { source?: unknown; id?: unknown };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) {
      return { status: 400, body: { error: ErrorCode.MCP_SERVER_REQUIRED } };
    }
    try {
      const detail = await market.detail(readSource(body.source) ?? 'mcpmarket', id);
      return { status: 200, body: detail };
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** POST /api/mcp/market/install —— 写入服务器定义并托管 */
export function createMcpMarketInstallHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const market = resolveMarket(services);
    if (!market) {
      return { status: 503, body: { error: ErrorCode.MCP_MARKET_UNAVAILABLE } };
    }
    const body = (req.body ?? {}) as {
      source?: unknown;
      id?: unknown;
      optionIndex?: unknown;
      env?: unknown;
      name?: unknown;
      manual?: unknown;
    };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) {
      return { status: 400, body: { error: ErrorCode.MCP_SERVER_REQUIRED } };
    }
    const env =
      body.env && typeof body.env === 'object' && !Array.isArray(body.env)
        ? (Object.fromEntries(
            Object.entries(body.env as Record<string, unknown>).filter(
              ([, value]) => typeof value === 'string',
            ),
          ) as Record<string, string>)
        : undefined;
    const manual =
      body.manual && typeof body.manual === 'object' && !Array.isArray(body.manual)
        ? (body.manual as McpManualInstall)
        : undefined;
    try {
      // 写盘后立即返回；依赖下载/安装/连接进度通过 WS 实时推送
      const result = await market.install(
        {
          source: readSource(body.source),
          id,
          optionIndex:
            typeof body.optionIndex === 'number' && Number.isFinite(body.optionIndex)
              ? body.optionIndex
              : undefined,
          ...(env ? { env } : {}),
          ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
          ...(manual ? { manual } : {}),
        },
        { awaitConnect: false },
      );
      return { status: 200, body: result };
    } catch (err) {
      return errorResponse(err);
    }
  };
}
