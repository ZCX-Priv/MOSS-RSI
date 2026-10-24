// src/modules/mcp/expose.ts
// MOSS 对外 MCP Server（Streamable HTTP，/mcp 端点，无状态模式）。
//
// 由 config.mcpServer.enabled 控制（默认关闭）；复用主端口的 authToken Bearer 鉴权
// （config.security.authToken 为空时回退环境变量 MOSS_AUTH_TOKEN；两者皆空则不鉴权）。
//
// 暴露范围（agent 级定位）：
//   · 始终暴露 agent 级工具集（moss_*，见 agent-tools.ts）——让别的 Agent 给 MOSS 派任务、
//     轮询进度、管理自动化、查看会话。
//   · MOSS 的内部工具（read/glob/grep/terminal/memory…）**默认不暴露**（它们是 MOSS 自己用的，
//     放出去等于把 MOSS 降级成工具代理）。逃生舱：config.mcpServer.exposeInternalTools=true
//     ＋ allowedTools 白名单；且仍需排除 requireConfirmation / destructiveHint / ask。
//
// 实现要点（均依据 @modelcontextprotocol/sdk 1.30.0 真实行为）：
// 1. 无状态：每个 POST 新建 transport + Server（SDK 明确要求 stateless transport 不可复用，
//    否则消息 ID 会跨客户端串号）。
// 2. 绝不主动 close：Protocol.connect() 会把 transport.onclose 换成自己的包装器，调用它会触发
//    Protocol._onclose()，而 _onclose() 会 abort 掉**仍在执行的请求处理器**，导致
//    tools/call 的响应被静默丢弃、SSE 流永不结束（客户端挂死）。响应就绪时 SDK 的
//    send() 会自行 cleanup SSE 流，实例随后可被 GC 回收，无需（也不应）手动 close。
// 3. 响应模式默认 SSE：立刻返回响应头并由 SDK 持续写 15s keep-alive 帧，长任务不会被
//    Bun.serve 的 idleTimeout 掐断（详见 core/types.ts 中 responseMode 的说明）。
//
// 采用 SDK 低层 Server API（setRequestHandler），inputSchema 直接使用 MOSS 的 JSON Schema
// （McpServer.registerTool 需要 zod，低层 API 无此限制）。

import type { ConfigService, Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { ToolRegistry } from '../contracts';
import type { Tool, ToolContext, ToolResult } from '../tools/types';
import { createAgentTools, type AgentTool } from './agent-tools';
import type { McpTaskRegistry } from './task-registry';

/** 最小化 SDK 类型契约（动态 import，避免版本差异） */
export interface SdkServer {
  setRequestHandler(schema: unknown, handler: (req: unknown, extra?: unknown) => Promise<unknown>): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface SdkTransport {
  onclose?: () => void;
  onerror?: (err: unknown) => void;
  handleRequest(req: Request): Promise<Response>;
}

/** 暴露层依赖（HTTP 端点与 stdio 入口共用） */
export interface ExposureDeps {
  config: ConfigService;
  services: ServiceRegistry;
  logger: Logger;
  /** 外部调用会话标识（HTTP 无状态 / stdio 长连接） */
  sessionId: string;
}

/** 已过滤 + 元数据规范化的对外工具描述（严格对齐 MCP spec 的 Tool） */
export interface ExposedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

// ============================================================================
// 共享：工具投影（HTTP / stdio 共用）
// ============================================================================

/** MOSS 工具清单里的 i18n 兄弟键（description_en 等）不是合法 JSON Schema 关键字，需剥离 */
const I18N_SCHEMA_KEY_RE = /^description_[a-z]{2}(?:-[a-z]{2})?$/i;

/**
 * 需要交互通道、外部客户端无法提供的工具：不暴露。
 * - ask：依赖 ctx.askUser（无通道时必然返回错误），外接客户端另有 elicitation 语义
 */
const INTERACTIVE_ONLY_TOOLS = new Set(['ask']);

/** 递归剥离 MOSS 私有的 i18n 键，保证 inputSchema 是标准 JSON Schema */
function stripI18nKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripI18nKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (I18N_SCHEMA_KEY_RE.test(key)) continue;
      out[key] = stripI18nKeys(val);
    }
    return out;
  }
  return value;
}

/** 规范化 inputSchema：MCP 要求 type=object 的对象 schema；缺失/非法时兜底为空对象 schema */
function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  const stripped = stripI18nKeys(schema);
  if (stripped && typeof stripped === 'object' && !Array.isArray(stripped)) {
    const obj = stripped as Record<string, unknown>;
    const props = obj.properties;
    const hasProps = !!props && typeof props === 'object' && !Array.isArray(props);
    if (obj.type === 'object' || hasProps) {
      return { ...obj, type: 'object', properties: hasProps ? props : {} };
    }
  }
  return { type: 'object', properties: {} };
}

/** MOSS 注解 → MCP ToolAnnotations（只保留规范字段，丢弃 requireConfirmation 等内部字段） */
function toMcpAnnotations(annotations: Tool['annotations']): Record<string, unknown> | undefined {
  if (!annotations) return undefined;
  const out: Record<string, unknown> = {};
  if (annotations.readOnlyHint !== undefined) out.readOnlyHint = annotations.readOnlyHint;
  if (annotations.destructiveHint !== undefined) out.destructiveHint = annotations.destructiveHint;
  if (annotations.idempotentHint !== undefined) out.idempotentHint = annotations.idempotentHint;
  const openWorld = (annotations as { openWorldHint?: boolean }).openWorldHint;
  if (openWorld !== undefined) out.openWorldHint = openWorld;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 是否危险/需交互（外部无确认通道 → 一律不暴露） */
function isNonExposable(tool: Tool, toolsCfg: Record<string, { requireConfirmation?: boolean }> | undefined): boolean {
  if (INTERACTIVE_ONLY_TOOLS.has(tool.name)) return true;
  if (tool.annotations?.requireConfirmation === true) return true;
  if (tool.annotations?.destructiveHint === true) return true;
  if (toolsCfg?.[tool.name]?.requireConfirmation === true) return true;
  return false;
}

/** 投影单个工具为对外描述 */
function projectTool(tool: Tool): ExposedTool {
  const annotations = toMcpAnnotations(tool.annotations);
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: normalizeInputSchema(tool.inputSchema),
    ...(annotations ? { annotations } : {}),
  };
}

/**
 * 计算当前可暴露的工具集合（每次请求实时计算，支持工具热重载与配置热更新）。
 *
 * 两段式（agent 级定位的关键）：
 * 1. agent 级工具（moss_*）：始终暴露 —— 它们是「让别的 Agent 驱动 MOSS」的对外契约。
 * 2. 内部工具（MOSS 自己的 read/glob/terminal…）：仅当 config.mcpServer.exposeInternalTools
 *    为 true 时才考虑，且仍需通过启用/危险/白名单过滤。
 */
export function collectExposedTools(deps: ExposureDeps): ExposedTool[] {
  const out: ExposedTool[] = [];

  // 1. agent 级工具：不过滤（annotations 仅供客户端提示，不作为暴露门槛）
  for (const tool of resolveAgentTools(deps)) {
    const annotations = tool.annotations;
    out.push({
      name: tool.name,
      description: tool.description,
      inputSchema: normalizeInputSchema(tool.inputSchema),
      ...(annotations ? { annotations } : {}),
    });
  }

  // 2. 内部工具：默认关闭（逃生舱需显式开启，并受白名单约束）
  if (!internalToolsEnabled(deps)) return out;
  const registry = deps.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
  if (!registry) return out;
  const cfg = deps.config.getAppConfig();
  const allowed = cfg.mcpServer?.allowedTools ?? [];
  const toolsCfg = cfg.tools as Record<string, { requireConfirmation?: boolean }> | undefined;
  for (const tool of registry.list()) {
    if (!registry.isEnabled(tool.name)) continue;
    if (isNonExposable(tool, toolsCfg)) continue;
    if (allowed.length > 0 && !allowed.includes(tool.name)) continue;
    out.push(projectTool(tool));
  }
  return out;
}

/** 内部工具是否放行（默认 false：/mcp 只暴露 agent 级契约） */
function internalToolsEnabled(deps: ExposureDeps): boolean {
  try {
    return deps.config.getAppConfig().mcpServer?.exposeInternalTools === true;
  } catch {
    return false;
  }
}

/**
 * 解析 agent 级工具集（每次请求重建，开销可忽略）。
 * MCP 任务注册表在此**请求时**解析：mcp 模块在 server 模块之后初始化，
 * 构造期注入必然拿不到服务。
 */
function resolveAgentTools(deps: ExposureDeps): AgentTool[] {
  const registry = deps.services.tryResolve<McpTaskRegistry>(ServiceNames.MCP_TASK_REGISTRY);
  return createAgentTools(registry);
}

/** ToolResult → MCP CallToolResult（text/image + 可选 structuredContent） */
export function toCallToolResult(result: ToolResult): Record<string, unknown> {
  const content = result.content.map((c): Record<string, unknown> => {
    if (c.type === 'text') return { type: 'text', text: c.text };
    return { type: 'image', data: c.source.data, mimeType: c.source.mimeType };
  });
  const structured = (result.metadata as { structured?: unknown } | undefined)?.structured;
  return {
    content,
    ...(result.isError ? { isError: true } : {}),
    ...(structured !== undefined && structured !== null ? { structuredContent: structured } : {}),
  };
}

/** 构造外部调用的 ToolContext：无用户交互通道，不触发本地确认链路 */
export function buildExternalToolContext(deps: ExposureDeps, signal?: AbortSignal): ToolContext {
  return {
    sessionId: deps.sessionId,
    cwd: process.cwd(),
    toolCallId: `${deps.sessionId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    emit: () => {
      // 外部通道不转发进度事件
    },
    logger: deps.logger,
    services: deps.services,
    ...(signal ? { signal } : {}),
  };
}

/** 单条工具调用的执行错误 → isError 结果（协议层仍返回 200 + result） */
function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

/** 注册 ListTools / CallTool handler（工具集合每次请求实时计算） */
export function registerToolHandlers(
  server: SdkServer,
  deps: ExposureDeps,
  schemas: { ListToolsRequestSchema: unknown; CallToolRequestSchema: unknown },
): void {
  server.setRequestHandler(schemas.ListToolsRequestSchema, async () => ({
    tools: collectExposedTools(deps).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }));

  server.setRequestHandler(schemas.CallToolRequestSchema, async (req, extra) => {
    const params = (req as { params?: { name?: string; arguments?: Record<string, unknown> } }).params;
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (typeof name !== 'string' || name.length === 0) {
      return toolError('Error: missing tool name');
    }

    // 1. agent 级工具优先（始终可用）
    const agentTool = resolveAgentTools(deps).find(t => t.name === name);
    if (agentTool) {
      try {
        const result = await agentTool.execute(args, deps);
        return toCallToolResult(result);
      } catch (err) {
        return toolError(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. 内部工具：仅逃生舱开启时可用，且必须仍在暴露集合内
    if (!internalToolsEnabled(deps)) {
      return toolError(`Error: unknown tool "${name}" (this MCP server exposes MOSS agent tools only)`);
    }
    if (!collectExposedTools(deps).some(t => t.name === name)) {
      return toolError(`Error: tool "${name}" is not exposed`);
    }
    const registry = deps.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
    if (!registry) {
      return toolError('Error: tool registry unavailable');
    }
    // 客户端取消（CancelledNotification）会 abort extra.signal → 透传给工具
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    try {
      const result = await registry.execute(name, args, buildExternalToolContext(deps, signal));
      return toCallToolResult(result);
    } catch (err) {
      return toolError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// ============================================================================
// HTTP 端点（Streamable HTTP，无状态）
// ============================================================================

/** SDK 支持的协议版本（与 types.js 的 SUPPORTED_PROTOCOL_VERSIONS 保持同步） */
const FALLBACK_PROTOCOL_VERSION = '2025-11-25';

export class McpExpose {
  private readonly config: ConfigService;
  private readonly services: ServiceRegistry;
  private readonly logger: Logger;

  constructor(deps: {
    config: ConfigService;
    services: ServiceRegistry;
    logger: Logger;
  }) {
    this.config = deps.config;
    this.services = deps.services;
    this.logger = deps.logger;
  }

  /** 当前是否启用对外暴露（实时读 config，热更新生效） */
  isEnabled(): boolean {
    return this.config.getAppConfig().mcpServer?.enabled === true;
  }

  private deps(): ExposureDeps {
    return {
      config: this.config,
      services: this.services,
      logger: this.logger,
      sessionId: 'mcp-http',
    };
  }

  // ---------------------------------------------------------------- 鉴权

  /**
   * 期望的 Bearer token：config.security.authToken 优先，空则回退环境变量
   * MOSS_AUTH_TOKEN（便于客户端用环境变量注入，不必把明文写进配置文件）。
   * 两者皆空 = 不鉴权（本地信任模式，与 http-router 一致）。
   */
  private expectedToken(): string {
    const cfg = this.config.getAppConfig();
    return cfg.security.authToken || process.env.MOSS_AUTH_TOKEN || '';
  }

  private checkAuth(req: Request): boolean {
    const expected = this.expectedToken();
    if (!expected) return true;
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    return token === expected;
  }

  // ------------------------------------------------------------ 安全校验

  /** 是否仅监听本机（本机绑定时浏览器无法跨源访问，可跳过 Origin 校验） */
  private isLocalBinding(): boolean {
    const cfg = this.config.getAppConfig();
    if (cfg.remote?.enabled) return false;
    if (cfg.security.bindLocalhostOnly) return true;
    const host = (cfg.server.host ?? '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '';
  }

  /**
   * Origin 校验（MCP 规范 MUST：防 DNS rebinding）。
   * 非本机绑定时：无 Origin（CLI/非浏览器）放行；有 Origin 时必须与请求 Host 同源。
   */
  private originAllowed(req: Request): boolean {
    const origin = req.headers.get('origin');
    if (!origin || origin === 'null') return true;
    if (this.isLocalBinding()) return true;
    const host = req.headers.get('host');
    if (!host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ 响应头

  /** CORS 头：/mcp 不走 http-router，需自行补齐，否则浏览器端 MCP 客户端会被同源策略拦截 */
  private corsHeaders(): Record<string, string> {
    return {
      // Bearer 鉴权（非 Cookie），通配 Origin 安全；Origin 白名单由 originAllowed 单独把关
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id',
      'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version, last-event-id',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }

  private jsonError(
    status: number,
    code: number,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...this.corsHeaders(),
        ...extraHeaders,
      },
    });
  }

  /** 给 transport 返回的 Response 注入 CORS 与协议版本头（不消费/不复制流） */
  private decorate(resp: Response, protocolVersion: string): Response {
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(this.corsHeaders())) {
      if (!headers.has(k)) headers.set(k, v);
    }
    if (!headers.has('mcp-protocol-version')) {
      headers.set('mcp-protocol-version', protocolVersion);
    }
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }

  /**
   * 解析本次请求协商到的协议版本（用于响应头）。
   * 优先请求头 mcp-protocol-version；否则从 initialize 请求体读取；都拿不到则回退最新版。
   */
  private async resolveProtocolVersion(req: Request, supported: string[]): Promise<string> {
    const header = req.headers.get('mcp-protocol-version');
    if (header && supported.includes(header)) return header;
    try {
      const data = (await req.clone().json()) as unknown;
      const msg = (Array.isArray(data) ? data[0] : data) as { params?: { protocolVersion?: unknown } };
      const version = msg?.params?.protocolVersion;
      if (typeof version === 'string' && supported.includes(version)) return version;
    } catch {
      // 非 JSON 请求体（transport 会自行返回解析错误）
    }
    return supported.includes(FALLBACK_PROTOCOL_VERSION) ? FALLBACK_PROTOCOL_VERSION : supported[0] ?? FALLBACK_PROTOCOL_VERSION;
  }

  // ------------------------------------------------------------ 入口

  /**
   * 处理 /mcp 端点请求。返回 null 表示路径不匹配（由调用方继续常规处理）。
   * 未启用时返回 404（不暴露端点存在性）。
   */
  async handleRequest(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') return null;

    if (!this.isEnabled()) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // origin 校验：不通过一律 403（含预检），避免 DNS rebinding 拿到响应
    if (req.method === 'POST' || req.method === 'OPTIONS') {
      if (!this.originAllowed(req)) {
        return this.jsonError(403, -32000, 'Forbidden: invalid Origin');
      }
    }

    // CORS 预检：不带凭据，先于鉴权放行
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: this.corsHeaders() });
    }

    if (!this.checkAuth(req)) {
      return this.jsonError(401, -32001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }

    // 无状态模式：不提供 GET（SSE 流）与 DELETE（会话终止）——规范允许直接回 405
    if (req.method !== 'POST') {
      return this.jsonError(405, -32000, 'Method not allowed.', {
        Allow: 'POST, GET, DELETE',
      });
    }

    try {
      return await this.handlePost(req);
    } catch (err) {
      this.logger.warn('mcp expose request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.jsonError(500, -32603, 'Internal error');
    }
  }

  /**
   * POST：无状态模式，每请求新建 transport + Server（SDK 推荐做法）。
   * 注意：不可在请求结束后 close transport / server（见文件头注释第 2 条）。
   */
  private async handlePost(req: Request): Promise<Response> {
    // 动态 import（SDK 缺失时不影响主流程）
    const { Server } = (await import('@modelcontextprotocol/sdk/server/index.js')) as {
      Server: new (info: unknown, opts: unknown) => SdkServer;
    };
    const { WebStandardStreamableHTTPServerTransport } = (await import(
      '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
    )) as {
      WebStandardStreamableHTTPServerTransport: new (opts: unknown) => SdkTransport;
    };
    const { ListToolsRequestSchema, CallToolRequestSchema, SUPPORTED_PROTOCOL_VERSIONS } = (await import(
      '@modelcontextprotocol/sdk/types.js'
    )) as {
      ListToolsRequestSchema: unknown;
      CallToolRequestSchema: unknown;
      SUPPORTED_PROTOCOL_VERSIONS: string[];
    };

    if (!this.services.tryResolve<McpTaskRegistry>(ServiceNames.MCP_TASK_REGISTRY)) {
      // 注册表未就绪只影响任务类工具（它们会返回可读错误），不阻断整个端点
      this.logger.warn('mcp expose: task registry unavailable (agent tools will report an error until ready)');
    }

    const protocolVersion = await this.resolveProtocolVersion(req, SUPPORTED_PROTOCOL_VERSIONS);

    // 响应模式：'json' 为兼容逃生舱（等待期间无字节下行，受 Bun idleTimeout 限制）；
    // 默认 'sse' —— 立刻回响应头 + SDK 15s keep-alive，长任务安全。
    const enableJsonResponse = this.config.getAppConfig().mcpServer?.responseMode === 'json';

    // 无状态：sessionIdGenerator 显式 undefined（不维持会话；SDK 要求每请求新建实例）
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse,
    });
    const server = new Server(
      { name: 'moss', version: '1.1.0' },
      { capabilities: { tools: {} } },
    );

    registerToolHandlers(server, this.deps(), { ListToolsRequestSchema, CallToolRequestSchema });

    await server.connect(transport);
    const response = await transport.handleRequest(req);
    return this.decorate(response, protocolVersion);
  }
}