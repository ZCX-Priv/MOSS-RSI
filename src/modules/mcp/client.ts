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
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
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
  // 仅作占位，具体构造由 SDK 完成
}

interface McpSdkModule {
  Client?: new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }) => McpSdkClient;
  StdioClientTransport?: new (opts: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
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
}

export class McpClient {
  private sdkClient: McpSdkClient | null = null;
  private tools: McpToolInfo[] = [];
  private readonly name: string;
  private readonly config: ServerConfig;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  /** 实际使用的传输（http 可能回退为 sse） */
  private effectiveTransport: 'stdio' | 'http' | 'sse' | null = null;
  /** 模块级钩子（sampling 全局；由 manager 创建时注入） */
  private readonly hooks?: McpClientHooks;
  /** 当前 callTool 的 elicitation 桥（动态槽位；callTool 开始设置、结束清理） */
  private elicitationBridge: ((req: McpElicitRequest) => Promise<McpElicitOutcome>) | null = null;

  constructor(name: string, config: ServerConfig, logger: Logger, eventBus: EventBus, hooks?: McpClientHooks) {
    this.name = name;
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.hooks = hooks;
  }

  async connect(): Promise<void> {
    // 分别从子路径动态 import（SDK 不存在根 index.js）
    const clientMod = (await import('@modelcontextprotocol/sdk/client')) as McpSdkModule;
    const Client = clientMod.Client;
    if (!Client) {
      throw new Error(t('mcp.sdkClientNotFound'));
    }

    let transport: McpSdkTransport;
    if (this.config.transport === 'stdio') {
      transport = await this.createStdioTransport();
      this.effectiveTransport = 'stdio';
    } else if (this.config.transport === 'http') {
      // 尝试新标准 StreamableHTTP，失败则自动回退到 SSE
      try {
        transport = await this.createHttpTransport();
        this.effectiveTransport = 'http';
      } catch (err) {
        this.logger.warn(t('mcp.httpFallbackSse', { name: this.name }), {
          error: err instanceof Error ? err.message : String(err),
        });
        transport = await this.createSseTransport();
        this.effectiveTransport = 'sse';
      }
    } else if (this.config.transport === 'sse') {
      transport = await this.createSseTransport();
      this.effectiveTransport = 'sse';
    } else {
      throw new Error(t('mcp.unknownTransport', { transport: this.config.transport }));
    }

    // 创建 client 实例（elicitation 始终声明——agent 通道支持，无桥时 decline；sampling 按钩子注入声明）
    this.sdkClient = new Client(
      { name: 'moss', version: '1.1.0' },
      { capabilities: this.buildCapabilities() },
    );
    this.registerClientHandlers();

    // 连接（http 若失败也尝试回退 SSE）
    try {
      await this.sdkClient.connect(transport);
    } catch (err) {
      if (this.config.transport === 'http' && this.effectiveTransport === 'http') {
        // http connect 失败，回退 SSE
        this.logger.warn(t('mcp.httpConnectFailedRetrySse', { name: this.name }), {
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sdkClient.close().catch(() => {});
        this.sdkClient = null;
        transport = await this.createSseTransport();
        this.effectiveTransport = 'sse';
        this.sdkClient = new Client(
          { name: 'moss', version: '1.1.0' },
          { capabilities: this.buildCapabilities() },
        );
        this.registerClientHandlers();
        await this.sdkClient.connect(transport);
      } else {
        throw err;
      }
    }

    this.logger.info(t('mcp.clientConnected', { name: this.name }), {
      transport: this.config.transport,
      effective: this.effectiveTransport,
    });

    // 列出工具
    await this.refreshTools();
  }

  async disconnect(): Promise<void> {
    if (this.sdkClient) {
      try {
        await this.sdkClient.close();
      } catch {
        // 静默
      }
      this.sdkClient = null;
      this.tools = [];
      this.effectiveTransport = null;
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
    const result = await this.sdkClient.callTool(
      {
        name: toolName,
        arguments: args as Record<string, unknown>,
      },
      // resultSchema：传 undefined，交由 SDK 使用默认 CallToolResultSchema
      undefined,
      {
        timeout: opts?.timeoutMs,
        signal: opts?.signal,
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
  private registerClientHandlers(): void {
    if (!this.sdkClient) return;
    // elicitation：动态桥（callTool 期间设置；无桥时 decline）
    if (this.sdkClient.setElicitationHandler) {
      this.sdkClient.setElicitationHandler(async req => {
        if (this.elicitationBridge) {
          return await this.elicitationBridge(req);
        }
        return { action: 'decline' as const };
      });
    }
    // sampling：全局钩子（manager 注入；内部含 allowSampling 检查）
    if (this.hooks?.onSampling && this.sdkClient.setSamplingHandler) {
      this.sdkClient.setSamplingHandler(async req => {
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
    // 合并环境变量：继承当前进程 + 用户配置 + UTF-8 引导（避免子进程 GBK 输出乱码）
    const env = {
      ...process.env,
      ...this.config.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    } as Record<string, string>;
    if (process.platform !== 'win32') {
      env.LANG = env.LANG ?? 'zh_CN.UTF-8';
      env.LC_ALL = env.LC_ALL ?? 'zh_CN.UTF-8';
    }
    return new StdioTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env,
    });
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
