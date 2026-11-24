// src/modules/mcp/client.ts
// 单服务器 MCP Client 封装：动态 import @modelcontextprotocol/sdk。
//
// 支持三种传输：
//   - stdio  (StdioClientTransport)
//   - http   (StreamableHTTPClientTransport, 2025-03-26 新标准)
//   - sse    (SSEClientTransport, 旧标准)
// 当 http 连接失败时，自动回退到 sse 重试一次（兼容旧 MCP server）。
//
// SDK 入口分布：
//   - Client                                @modelcontextprotocol/sdk/client
//   - StdioClientTransport                  @modelcontextprotocol/sdk/client/stdio
//   - StreamableHTTPClientTransport         @modelcontextprotocol/sdk/client/streamableHttp
//   - SSEClientTransport                    @modelcontextprotocol/sdk/client/sse

import { t } from '../../core/i18n';
import type { EventBus, Logger } from '../../core/types';

// ============================================================================
// 类型定义
// ============================================================================

export interface ServerConfig {
  /** 传输类型：stdio | http | sse */
  transport: 'stdio' | 'http' | 'sse';
  /** 是否启用（缺省 true；禁用的服务器不连接、不注入 LLM 工具集） */
  enabled?: boolean;
  /** stdio: 命令；http/sse: URL */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** 自定义请求头（http / sse 传输） */
  headers?: Record<string, string>;
  /** 市场来源（仅通过 MCP 市场安装的服务器携带，用于识别「已安装/重新配置」） */
  market?: {
    source: 'mcpmarket' | 'official' | 'modelscope';
    id: string;
    version?: string;
    /** 市场图标（管理面板优先展示） */
    iconUrl?: string;
  };
}

/** MCP 市场安装阶段（前端进度面板只展示阶段，不展示伪造百分比） */
export type McpInstallPhase =
  | 'prepare'
  | 'start'
  | 'download'
  | 'install'
  | 'connect'
  | 'done'
  | 'error';

export interface McpInstallProgressPayload {
  source?: 'mcpmarket' | 'official' | 'modelscope';
  id?: string;
  server?: string;
  phase: McpInstallPhase;
  detail?: string;
  /** 一批真实 stderr 日志（可多行） */
  log?: string;
  /** 已下载的 npm tarball 去重计数 */
  downloaded?: number;
  error?: string;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; uri: string; mimeType?: string; text?: string; blob?: string }
  >;
  isError?: boolean;
  /** MCP structured output（2025-06-18 规范 structuredContent），存在时优先解析 */
  structured?: unknown;
}

export interface McpClientEntry {
  client: McpClient;
  config: ServerConfig;
  status: 'connected' | 'disconnected' | 'error';
}

/** MCP elicitation 请求（Form 模式） */
export interface McpElicitRequest {
  message: string;
  /** JSON Schema（默认 { message: string } 形式） */
  requestedSchema?: Record<string, unknown>;
}

/** MCP elicitation 结果（SDK ElicitResult 兼容） */
export type McpElicitOutcome =
  | { action: 'accept'; content: Record<string, string | number | boolean> }
  | { action: 'decline' }
  | { action: 'cancel' };

/** MCP sampling 请求（SDK CreateMessageRequest 兼容） */
export interface McpSamplingRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  model?: string;
  maxTokens: number;
  systemPrompt?: string;
  temperature?: number;
  includeContext?: string;
}

/** MCP sampling 结果（SDK CreateMessageResult 兼容） */
export interface McpSamplingResult {
  role: 'assistant';
  model: string;
  content: { type: 'text'; text: string };
  stopReason: 'endturn' | 'max_tokens' | 'stop_sequence' | 'other';
}

// ============================================================================
// MCP SDK 客户端的最小化类型契约
// ----------------------------------------------------------------------------
// 不直接依赖 SDK 类型（避免版本差异），定义与 SDK Client 行为兼容的最小接口。
// ============================================================================

interface McpSdkClient {
  connect(transport: unknown, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  setElicitationHandler?(handler: (req: McpElicitRequest) => Promise<McpElicitOutcome>): void;
  setSamplingHandler?(handler: (req: McpSamplingRequest) => Promise<McpSamplingResult>): void;
  listTools(): Promise<{
    tools: Array<{
      name: string;
      title?: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    }>;
  }>;
  callTool(
    req: { name: string; arguments?: Record<string, unknown> },
    // SDK 1.30 签名：callTool(params, resultSchema?, options?)
    // 第 2 参是「结果校验 schema」，请求选项必须放第 3 位；
    // 错放第 2 位会让 SDK 对选项对象执行 safeParse → 运行时 TypeError。
    resultSchema?: unknown,
    options?: { timeout?: number; signal?: AbortSignal; resetTimeoutOnProgress?: boolean },
  ): Promise<{
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; uri?: string; blob?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
}

interface McpSdkTransport {
  // 仅作占位，具体构造由 SDK 完成；close 用于超时/中止时清理子进程
  close?(): Promise<void>;
  /** stdio 子进程 stderr（仅在 stderr: 'pipe' 时存在） */
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): void } | null;
}

interface McpSdkModule {
  Client?: new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }) => McpSdkClient;
  StdioClientTransport?: new (opts: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: 'pipe' | 'inherit' | 'overlapped';
  }) => McpSdkTransport;
  StreamableHTTPClientTransport?: new (
    url: URL,
    opts?: { requestInit?: { headers?: Record<string, string> } },
  ) => McpSdkTransport;
  SSEClientTransport?: new (
    url: URL,
    opts?: { requestInit?: { headers?: Record<string, string> } },
  ) => McpSdkTransport;
}

// ============================================================================
// McpClient
// ============================================================================

export interface McpClientHooks {
  /** sampling：MCP 服务器借用本地 LLM 生成（config.mcp.allowSampling 控制是否注入） */
  onSampling?: (req: McpSamplingRequest) => Promise<McpSamplingResult>;
  /** 非主动断开导致的连接关闭（子进程退出 / 远端断连），供 manager 触发自动重连 */
  onUnexpectedClose?: () => void;
  /** stdio 子进程 stderr（市场安装 verbose 模式用于实时日志） */
  onStderr?: (chunk: string) => void;
  /** 连接阶段（manager 转换为 mcp:install:progress 事件） */
  onPhase?: (phase: 'connect' | 'done') => void;
}

/** 连接超时默认值：stdio 首次启动 npx/uvx 需要下载依赖，SDK 默认 60s 不够 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 180_000;

export type McpTransportKind = 'stdio' | 'http' | 'sse';

/**
 * 远端传输尝试顺序：配置声明的传输优先，失败后尝试另一种。
 * 市场/手工配置的 transport 可能与真实端点不符（典型：标成 sse 但实际是 streamable-http）。
 */
export function transportAttempts(kind: McpTransportKind): McpTransportKind[] {
  if (kind === 'stdio') return ['stdio'];
  return kind === 'sse' ? ['sse', 'http'] : ['http', 'sse'];
}

function transportLabel(kind: McpTransportKind): string {
  return kind === 'http' ? 'streamable-http' : kind;
}

export class McpClient {
  private sdkClient: McpSdkClient | null = null;
  /** 当前传输：超时/断连时显式 close，确保子进程被回收 */
  private transport: McpSdkTransport | null = null;
  /** 连接代次：超时后自增，迟到的连接完成会自行关闭，避免“超时后又变成已连接” */
  private connectGeneration = 0;
  private tools: McpToolInfo[] = [];
  private readonly name: string;
  private readonly config: ServerConfig;
  private readonly logger: Logger;
  /** 实际使用的传输（http 可能回退为 sse） */
  private effectiveTransport: 'stdio' | 'http' | 'sse' | null = null;
  /** 模块级钩子（sampling 全局；由 manager 创建时注入） */
  private readonly hooks?: McpClientHooks;
  /** 当前 callTool 的 elicitation 桥（动态槽位；callTool 开始设置、结束清理） */
  private elicitationBridge: ((req: McpElicitRequest) => Promise<McpElicitOutcome>) | null = null;
  /** 主动断开标记：区分管理器断开与子进程/连接意外关闭 */
  private manualClose = false;
  /** stdio 子进程 stderr 尾部（连接失败时附加到错误信息，最多 4KB） */
  private stderrTail = '';
  /** 外部取消标记：断开/删除服务器时立即中止进行中的连接 */
  private cancelled = false;
  /** 本次连接是否输出依赖下载/安装日志（仅市场安装首次连接开启） */
  private verbose = false;

  constructor(name: string, config: ServerConfig, logger: Logger, _eventBus: EventBus, hooks?: McpClientHooks) {
    this.name = name;
    this.config = config;
    this.logger = logger;
    this.hooks = hooks;
  }

  /**
   * 连接 MCP 服务器。
   * @param timeoutMs 初始化请求超时（含 create/listTools）；缺省 180s，兼容 npx/uvx 首次下载依赖。
   *   超时会显式关闭 transport，避免孤儿进程。
   */
  async connect(timeoutMs?: number, opts?: { verbose?: boolean }): Promise<void> {
    this.cancelled = false;
    this.verbose = opts?.verbose === true;
    const budget = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(t('mcp.connectTimeout', { name: this.name, timeout: budget }))),
        // 外层只兜住 transport 创建等无超时步骤，让 SDK 的 initialize 超时先触发
        budget + 60_000,
      );
    });
    try {
      await Promise.race([this.connectInternal(budget), timeout]);
    } catch (err) {
      // 让迟到的连接完成失效，并强制关闭 transport
      this.connectGeneration += 1;
      await this.disconnect().catch(() => {});
      throw this.decorateError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 取消进行中的连接（断开/删除服务器时调用）。
   * 立即关闭 transport/client，让 connect() 尽快以错误结束，不再等待初始化超时。
   */
  async abortConnect(): Promise<void> {
    this.cancelled = true;
    this.connectGeneration += 1;
    await this.disconnect().catch(() => {});
  }

  /** 把最近的 stderr 输出附加到连接错误上，便于定位启动失败原因 */
  private decorateError(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    const tail = this.stderrTail.trim();
    return new Error(tail ? `${message}\n[stderr] ${tail}` : message);
  }

  /** 收集 stdio 子进程 stderr（保留尾部 4KB 诊断；verbose 时同时透传给 manager） */
  private attachStderr(transport: McpSdkTransport): void {
    const stream = transport.stderr;
    if (!stream) return;
    stream.on('data', (chunk: unknown) => {
      const text = String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-4096);
      this.hooks?.onStderr?.(text);
    });
  }

  private async connectInternal(timeoutMs: number): Promise<void> {
    this.manualClose = false;
    this.stderrTail = '';
    const generation = ++this.connectGeneration;
    if (this.cancelled) throw new Error('connect cancelled');
    // 分别从子路径动态 import（SDK 不存在根 index.js）
    const clientMod = (await import('@modelcontextprotocol/sdk/client')) as McpSdkModule;
    const Client = clientMod.Client;
    if (!Client) {
      throw new Error(t('mcp.sdkClientNotFound'));
    }
    if (
      this.config.transport !== 'stdio' &&
      this.config.transport !== 'http' &&
      this.config.transport !== 'sse'
    ) {
      throw new Error(t('mcp.unknownTransport', { transport: this.config.transport }));
    }

    const attempts = transportAttempts(this.config.transport);
    const failures: Array<{ transport: McpTransportKind; error: unknown; message: string }> = [];
    this.hooks?.onPhase?.('connect');

    for (const kind of attempts) {
      if (this.cancelled || generation !== this.connectGeneration) {
        throw new Error('connect cancelled');
      }

      let transport: McpSdkTransport;
      try {
        transport = await this.createTransportOfKind(kind);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ transport: kind, error: err, message });
        this.logger.warn(
          t('mcp.transportAttemptFailed', {
            transport: transportLabel(kind),
            error: message,
          }),
        );
        continue;
      }
      this.transport = transport;
      this.effectiveTransport = kind;

      // 每次尝试使用全新的 SDK Client，避免复用失败连接对象
      const client = new Client(
        { name: 'moss', version: '1.1.0' },
        { capabilities: this.buildCapabilities() },
      );
      this.sdkClient = client;
      this.registerClientHandlers(client);

      try {
        await client.connect(transport, { timeout: timeoutMs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ transport: kind, error: err, message });
        this.logger.warn(
          t('mcp.transportAttemptFailed', {
            transport: transportLabel(kind),
            error: message,
          }),
        );
        await client.close().catch(() => {});
        if (this.sdkClient === client) this.sdkClient = null;
        if (this.transport === transport) {
          this.transport = null;
          this.effectiveTransport = null;
        }
        if (this.cancelled || generation !== this.connectGeneration) {
          throw new Error('connect cancelled');
        }
        continue;
      }

      // 超时/取消后迟到的连接：立刻关闭本次拥有的 client，避免“超时后客户端又悄悄连上”
      if (this.cancelled || generation !== this.connectGeneration) {
        await client.close().catch(() => {});
        if (this.sdkClient === client) this.sdkClient = null;
        if (this.transport === transport) {
          this.transport = null;
          this.effectiveTransport = null;
        }
        throw new Error('connect aborted');
      }

      this.logger.info(t('mcp.clientConnected', { name: this.name }), {
        transport: this.config.transport,
        effective: this.effectiveTransport,
      });

      // 列出工具
      await this.refreshTools();
      this.hooks?.onPhase?.('done');
      return;
    }

    // 全部尝试失败
    if (this.config.transport === 'stdio') {
      const first = failures[0];
      throw first?.error ?? new Error('connect failed');
    }
    const attemptsLabel = attempts.map(transportLabel).join(' / ');
    const errorsLabel = failures
      .map((failure) => `${transportLabel(failure.transport)}: ${failure.message}`)
      .join(' | ');
    throw new Error(
      t('mcp.remoteAllAttemptsFailed', {
        attempts: attemptsLabel,
        errors: errorsLabel,
      }),
    );
  }

  /** 按传输类型创建 transport（远端回退循环使用） */
  private async createTransportOfKind(kind: McpTransportKind): Promise<McpSdkTransport> {
    if (kind === 'stdio') return this.createStdioTransport();
    if (kind === 'http') return this.createHttpTransport();
    return this.createSseTransport();
  }

  async disconnect(): Promise<void> {
    // 主动断开：onclose 不再触发“意外关闭”重连
    this.manualClose = true;
    const client = this.sdkClient;
    this.sdkClient = null;
    this.tools = [];
    this.effectiveTransport = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // 静默
      }
    }
    const transport = this.transport;
    this.transport = null;
    if (transport?.close) {
      try {
        await transport.close();
      } catch {
        // 已随 client.close 关闭时再关一次可能报错，忽略
      }
    }
  }

  getTools(): McpToolInfo[] {
    return this.tools;
  }

  getToolCount(): number {
    return this.tools.length;
  }

  getEffectiveTransport(): 'stdio' | 'http' | 'sse' | null {
    return this.effectiveTransport;
  }

  async refreshTools(): Promise<void> {
    if (!this.sdkClient) return;
    try {
      const result = await this.sdkClient.listTools();
      this.tools = (result.tools ?? []).map(tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }));
      this.logger.debug(t('mcp.toolsRefreshed', { name: this.name }), { count: this.tools.length });
    } catch (err) {
      this.logger.warn(t('mcp.listToolsFailed', { name: this.name }), {
        error: err instanceof Error ? err.message : String(err),
      });
      this.tools = [];
    }
  }

  /** 查询单个工具信息（含 annotations；未连接或不存在返回 null） */
  getTool(toolName: string): McpToolInfo | null {
    return this.tools.find(tool => tool.name === toolName) ?? null;
  }

  async callTool(
    toolName: string,
    args: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<McpToolResult> {
    if (!this.sdkClient) {
      throw new Error(t('mcp.clientNotConnected', { name: this.name }));
    }

    // 每次调用派生独立 signal：SDK 的 protocol 会在传入 signal 上
    // addEventListener('abort') 且请求结束后不移除（shared/protocol.js:737）。
    // 若把 run 级 signal 直传，同一次 run 里每次 MCP 调用都会留下一个死监听器；
    // 用户中止 run 时，这些已完成调用会与在途调用同帧发送 notifications/cancelled，
    // 在 Bun 的子进程 stdin 上叠加成 drain 监听器（MaxListenersExceededWarning）。
    const callCtl = new AbortController();
    const outer = opts?.signal;
    const forwardAbort = (): void => {
      callCtl.abort(outer?.reason);
    };
    if (outer) {
      // SDK 只监听 abort 事件，感知不到「传入即已中止」；不提前拒绝会挂到 timeout
      if (outer.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      outer.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
      const result = await this.sdkClient.callTool(
        {
          name: toolName,
          arguments: args as Record<string, unknown>,
        },
        // resultSchema：传 undefined，交由 SDK 使用默认 CallToolResultSchema
        undefined,
        {
          timeout: opts?.timeoutMs,
          signal: callCtl.signal,
          resetTimeoutOnProgress: true,
        },
      );

      // 归一化结果
      const content: McpToolResult['content'] = [];
      if (Array.isArray(result.content)) {
        for (const part of result.content) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text ?? '' });
          } else if (part.type === 'image') {
            content.push({
              type: 'image',
              data: part.data ?? '',
              mimeType: part.mimeType ?? 'image/png',
            });
          } else if (part.type === 'resource') {
            // MCP resource 类型：完整保留 uri/mimeType/text/blob（resource links）
            content.push({
              type: 'resource',
              uri: part.uri ?? '',
              mimeType: part.mimeType,
              text: part.text,
              blob: part.blob,
            });
          }
        }
      }
      return {
        content,
        isError: result.isError ?? false,
        // structured output（2025-06-18 规范）：完整透传
        structured: result.structuredContent,
      };
    } finally {
      outer?.removeEventListener('abort', forwardAbort);
    }
  }

  // ========================================================================
  // elicitation / sampling
  // ========================================================================

  /** 按钩子注入构造 ClientCapabilities（elicitation 始终声明；sampling 按配置） */
  private buildCapabilities(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = { elicitation: {} };
    if (this.hooks?.onSampling) capabilities.sampling = {};
    return capabilities;
  }

  /** 在 SDK client 上注册 elicitation / sampling handler（每次 new Client 后调用） */
  private registerClientHandlers(client: McpSdkClient): void {
    // 协议错误/连接关闭：必须兜底，否则 EventEmitter 的 error 事件可能逃逸成进程级异常
    client.onerror = (error: Error) => {
      this.logger.warn(t('mcp.clientError', { name: this.name }), {
        error: error.message,
      });
    };
    client.onclose = () => {
      this.logger.warn(t('mcp.clientClosed', { name: this.name }));
      // 非主动断开 → 子进程退出/远端断连，交给 manager 自动重连
      if (!this.manualClose) this.hooks?.onUnexpectedClose?.();
    };
    // elicitation：动态桥（callTool 期间设置；无桥时 decline）
    if (client.setElicitationHandler) {
      client.setElicitationHandler(async req => {
        if (this.elicitationBridge) {
          return await this.elicitationBridge(req);
        }
        return { action: 'decline' as const };
      });
    }
    // sampling：全局钩子（manager 注入；内部含 allowSampling 检查）
    if (this.hooks?.onSampling && client.setSamplingHandler) {
      client.setSamplingHandler(async req => {
        try {
          return await this.hooks!.onSampling!(req);
        } catch (err) {
          this.logger.warn(t('mcp.samplingFailed', { name: this.name }), {
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      });
    }
  }

  /** 设置当前 callTool 的 elicitation 桥（callTool 开始设置、finally 清理） */
  setElicitationBridge(bridge: ((req: McpElicitRequest) => Promise<McpElicitOutcome>) | null): void {
    this.elicitationBridge = bridge;
  }

  // ========================================================================
  // 传输构造
  // ========================================================================

  private async createStdioTransport(): Promise<McpSdkTransport> {
    const stdioMod = (await import('@modelcontextprotocol/sdk/client/stdio.js')) as McpSdkModule;
    const StdioTransport = stdioMod.StdioClientTransport;
    if (!StdioTransport) throw new Error(t('mcp.stdioTransportNotFound'));
    if (!this.config.command) throw new Error(t('mcp.stdioRequiresCommand'));
    // 合并环境变量：继承当前进程 + 用户配置 + UTF-8 引导（避免子进程 GBK 输出乱码）。
    // process.env 的值可能含 undefined，spawn 前必须过滤，否则子进程创建会直接失败。
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...this.config.env })) {
      if (typeof value === 'string') merged[key] = value;
    }
    merged.PYTHONUTF8 = '1';
    merged.PYTHONIOENCODING = 'utf-8';
    if (process.platform !== 'win32') {
      merged.LANG = merged.LANG ?? 'zh_CN.UTF-8';
      merged.LC_ALL = merged.LC_ALL ?? 'zh_CN.UTF-8';
    }
    // 市场安装首次连接：让 npx/npm 输出依赖解析与实际下载日志（非 TTY 默认会静默）
    const baseCommand = (this.config.command ?? '').toLowerCase().replace(/\.cmd$/i, '');
    if (this.verbose && (baseCommand === 'npx' || baseCommand === 'npm')) {
      merged.npm_config_loglevel = merged.npm_config_loglevel ?? 'http';
      merged.npm_config_update_notifier = merged.npm_config_update_notifier ?? 'false';
    }
    const transport = new StdioTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: merged,
      // 捕获 stderr 用于连接失败诊断（默认 inherit 会直接打到 MOSS 输出，拿不到内容）
      stderr: 'pipe',
    });
    this.attachStderr(transport);
    return transport;
  }

  private async createHttpTransport(): Promise<McpSdkTransport> {
    const httpMod = (await import('@modelcontextprotocol/sdk/client/streamableHttp.js')) as McpSdkModule;
    const HttpTransport = httpMod.StreamableHTTPClientTransport;
    if (!HttpTransport) throw new Error(t('mcp.httpTransportNotFound'));
    if (!this.config.url) throw new Error(t('mcp.httpRequiresUrl'));
    return new HttpTransport(new URL(this.config.url), {
      requestInit: { headers: this.config.headers },
    });
  }

  private async createSseTransport(): Promise<McpSdkTransport> {
    const sseMod = (await import('@modelcontextprotocol/sdk/client/sse.js')) as McpSdkModule;
    const SseTransport = sseMod.SSEClientTransport;
    if (!SseTransport) throw new Error(t('mcp.sseTransportNotFound'));
    if (!this.config.url) throw new Error(t('mcp.sseRequiresUrl'));
    return new SseTransport(new URL(this.config.url), {
      requestInit: { headers: this.config.headers },
    });
  }
}
