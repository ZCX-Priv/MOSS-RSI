// src/modules/mcp/stdio.ts
// MOSS 对外 MCP Server（stdio 传输）。
//
// 由 `moss mcp` 子命令启动，供 Claude Desktop / Cursor / VS Code 等客户端以 command
// 方式本地接入（无需端口与 token，以当前用户身份运行）。
//
// 关键约束：stdio 传输下 stdout 只允许承载 MCP 协议消息（每行一个 JSON-RPC）。
// 任何日志/调试输出都必须走 stderr —— 由 CLI 的 cmdMcp() 在启动内核前完成 console 改道。
//
// 工具投影与调用逻辑与 HTTP 端点（expose.ts）完全共用，保证两个入口暴露的工具集与
// 安全策略一致（白名单 + 危险/交互型工具一律不暴露）。

import type { ModuleContext } from '../../core/types';
import { collectExposedTools, registerToolHandlers, type ExposureDeps, type SdkServer } from './expose';

interface SdkStdioTransport {
  close(): Promise<void>;
}

/** stdio 版 MOSS MCP 服务器：一个进程一个客户端连接 */
export class McpStdioServer {
  private server: SdkServer | null = null;
  private transport: SdkStdioTransport | null = null;

  constructor(private readonly deps: ExposureDeps) {}

  /** 建立 stdio 连接（只允许调用一次） */
  async listen(): Promise<void> {
    if (this.server) throw new Error('mcp stdio server already listening');

    const { Server } = (await import('@modelcontextprotocol/sdk/server/index.js')) as unknown as {
      Server: new (info: unknown, opts: unknown) => SdkServer;
    };
    const { StdioServerTransport } = (await import('@modelcontextprotocol/sdk/server/stdio.js')) as unknown as {
      StdioServerTransport: new () => SdkStdioTransport;
    };
    const { ListToolsRequestSchema, CallToolRequestSchema } = (await import(
      '@modelcontextprotocol/sdk/types.js'
    )) as { ListToolsRequestSchema: unknown; CallToolRequestSchema: unknown };

    const server = new Server(
      { name: 'moss', version: '1.1.0' },
      { capabilities: { tools: {} } },
    );
    registerToolHandlers(server, this.deps, { ListToolsRequestSchema, CallToolRequestSchema });

    const transport = new StdioServerTransport();
    // Protocol.connect() 内部已调用 transport.start()，此处不可重复调用
    await server.connect(transport);

    this.server = server;
    this.transport = transport;
    this.deps.logger.info('mcp stdio server listening', {
      tools: collectExposedTools(this.deps).length,
    });
  }

  /** 关闭连接（客户端断开 / 进程退出） */
  async close(): Promise<void> {
    await this.transport?.close().catch(() => {});
    await this.server?.close().catch(() => {});
    this.transport = null;
    this.server = null;
  }
}

/** 从内核上下文构造并启动 stdio MCP 服务器（供 CLI 使用） */
export async function startMcpStdio(ctx: ModuleContext): Promise<McpStdioServer> {
  const server = new McpStdioServer({
    config: ctx.config,
    services: ctx.services,
    logger: ctx.logger,
    sessionId: 'mcp-stdio',
  });
  await server.listen();
  return server;
}