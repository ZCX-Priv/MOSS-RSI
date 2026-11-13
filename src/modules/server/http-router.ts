// src/modules/server/http-router.ts
// HTTP 路由装配：匹配、鉴权、请求体解析、分发。

import { t } from '../../core/i18n';
import type { HttpRequest, HttpResponse, Route, RouteHandler } from './types';
import type { ConfigService, Logger } from '../../core/types';
import { StaticAssets } from './static-assets';

interface CompiledRoute {
  method: string;
  pattern: string;
  /** 编译后的正则 */
  regex: RegExp;
  /** 参数名列表 */
  paramNames: string[];
  handler: RouteHandler;
  auth: boolean;
}

export class HttpRouter {
  private routes: CompiledRoute[] = [];
  private readonly config: ConfigService;
  private readonly logger: Logger;
  private readonly assets: StaticAssets;

  constructor(config: ConfigService, logger: Logger, assets: StaticAssets) {
    this.config = config;
    this.logger = logger;
    this.assets = assets;
  }

  addRoute(route: Route): void {
    const { regex, paramNames } = compilePattern(route.pattern);
    this.routes.push({
      method: route.method.toUpperCase(),
      pattern: route.pattern,
      regex,
      paramNames,
      handler: route.handler,
      auth: route.auth,
    });
    this.logger.debug(t('server.routeRegistered', { method: route.method.toUpperCase(), pattern: route.pattern }));
  }

  /**
   * 处理请求。返回 Response 对象供 Bun.serve fetch 回调使用。
   */
  async handle(method: string, url: string, headers: Record<string, string>, body: string): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }> {
    // 解析 URL
    const urlObj = parseUrl(url);
    const path = urlObj.pathname;

    // 1. 静态资源
    const asset = this.assets.tryServe(path);
    if (asset) {
      return asset;
    }

    // 2. API 路由
    if (path.startsWith('/api/')) {
      return await this.handleApi(method, url, path, urlObj.query, headers, body);
    }

    // 3. 根路径 / SPA fallback
    if (path === '/' || path === '') {
      const indexAsset = this.assets.tryServe('/');
      if (indexAsset) return indexAsset;
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<html><body><h1>MOSS</h1><p>WebUI not built. Run <code>npm run build:webui</code>.</p></body></html>',
      };
    }

    return {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: { error: 'Not Found', path },
    };
  }

  private async handleApi(
    method: string,
    url: string,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    // 请求体大小上限，防止内存耗尽（DoS）
    // 16MB：为「粘贴图片转附件」的 base64 载荷留出空间（原图上限约 12MB）
    const MAX_BODY_BYTES = 16 * 1024 * 1024;
    if (rawBody.length > MAX_BODY_BYTES) {
      return {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'Request body too large' },
      };
    }

    // 匹配路由
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const match = route.regex.exec(path);
      if (!match) continue;

      // 鉴权
      if (route.auth && !(await this.checkAuth(headers))) {
        return {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
          body: { error: 'Unauthorized' },
        };
      }

      // 构造 HttpRequest
      const params: Record<string, string> = {};
      try {
        route.paramNames.forEach((name, idx) => {
          params[name] = decodeURIComponent(match[idx + 1]);
        });
      } catch {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: { error: 'Invalid URL encoding in path parameter' },
        };
      }

      const body = parseBody(rawBody, headers['content-type'] ?? '');
      const req: HttpRequest = {
        method: method.toUpperCase(),
        // 必须保留完整 URL（含 query）：memory/rules/hooks 等路由通过 new URL(req.url) 读取查询参数，
        // 只传 pathname 会让 cwd/scope/origin/q 等过滤条件全部失效。
        url,
        path,
        query,
        headers,
        body,
        rawBody,
      };

      try {
        const resp: HttpResponse = await route.handler(req, params);
        return {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...(resp.headers ?? {}) },
          body: resp.body,
        };
      } catch (err) {
        this.logger.error(t('server.routeHandlerError', { method, path }), {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: { error: err instanceof Error ? err.message : 'Internal Server Error' },
        };
      }
    }

    return {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: { error: 'API endpoint not found', path, method },
    };
  }

  private async checkAuth(headers: Record<string, string>): Promise<boolean> {
    const cfg = this.config.getAppConfig();
    if (!cfg.security.authToken) return true; // 未设置 token 时无需鉴权
    const auth = headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    return token === cfg.security.authToken;
  }
}

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const parts: string[] = [];
  // 用正则切分：静态段 + :param 段交替
  const tokenRegex = /:([a-zA-Z_][a-zA-Z0-9_]*)|([^:]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(pattern)) !== null) {
    if (m[1] !== undefined) {
      // :param 段
      paramNames.push(m[1]);
      parts.push('([^/]+)');
    } else if (m[2] !== undefined) {
      // 静态段：转义正则特殊字符
      parts.push(m[2].replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    }
  }
  return { regex: new RegExp(`^${parts.join('')}$`), paramNames };
}

interface ParsedUrl {
  pathname: string;
  query: Record<string, string>;
}

function parseUrl(url: string): ParsedUrl {
  // Bun 环境有 URL，但为了简单直接解析
  try {
    const u = new URL(url, 'http://localhost');
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    return { pathname: u.pathname, query };
  } catch {
    // 简易 fallback
    const [path, qs] = url.split('?');
    const query: Record<string, string> = {};
    if (qs) {
      for (const pair of qs.split('&')) {
        const [k, v] = pair.split('=');
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
      }
    }
    return { pathname: path, query };
  }
}

function parseBody(raw: string, contentType: string): unknown {
  if (!raw) return null;
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  // 其他 content-type 直接返回原始字符串
  return raw;
}
