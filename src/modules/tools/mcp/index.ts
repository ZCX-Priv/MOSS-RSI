// tools/mcp/index.ts
// mcp 工具 execute 逻辑：统一 MCP 工具，按 action 分派。
//   list    —— 列出所有 MCP 服务器（含启用状态）及工具清单（可用 server 限定）
//   call    —— 转发到指定 MCP 服务器的指定工具
//   search  —— 搜索/浏览 MCP 市场（默认 mcpmarket，可切换 official / modelscope）
//   info    —— 查看市场条目详情（安装方式与必填 env）
//   install —— 按市场条目安装并托管（写入 ~/.moss/mcps/<name>.json）
// 元数据见同目录 tool.json。

import { t } from '../../../core/i18n';
import type { ToolContext, ToolResult } from '../types';
import type { MCPManager } from '../../contracts';
import {
  McpMarketError,
  type McpMarketService,
  type McpMarketSource,
} from '../../mcp/market';
import { ServiceNames } from '../../../core/types';

interface McpParams {
  action?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  source?: McpMarketSource;
  marketId?: string;
  env?: Record<string, string>;
  option?: number;
  keyword?: string;
  limit?: number;
  name?: string;
}

function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function textResult(text: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(metadata ? { metadata } : {}),
  };
}

/** action=list：列出 MCP 服务器及工具（可选 server 过滤） */
function runList(p: McpParams, ctx: ToolContext): ToolResult {
  const mgr = ctx.services.tryResolve<MCPManager>(ServiceNames.MCP_MANAGER);
  if (!mgr) {
    return errorText(`Error: ${t('tools.listMcpManagerUnavailable')}`);
  }

  try {
    const servers = mgr.listServers();
    const tools = mgr.listTools(p.server);

    const lines: string[] = [];
    lines.push(t('tools.listMcpServersHeader'));
    if (servers.length === 0) {
      lines.push(t('tools.listMcpNoServers'));
    } else {
      for (const s of servers) {
        const flag = s.enabled ? '' : ` [${t('tools.listMcpDisabledFlag')}]`;
        lines.push(`- ${s.name} [${s.status}${flag}] (${t('tools.listMcpToolCount', { count: s.toolCount })})`);
      }
    }
    lines.push('');
    lines.push(t('tools.listMcpToolsHeader'));
    if (tools.length === 0) {
      lines.push(t('tools.listMcpNoTools'));
    } else {
      const grouped = new Map<string, typeof tools>();
      for (const mcpTool of tools) {
        const arr = grouped.get(mcpTool.server) ?? [];
        arr.push(mcpTool);
        grouped.set(mcpTool.server, arr);
      }
      for (const [serverName, serverTools] of grouped) {
        lines.push(`[${serverName}]`);
        for (const tool of serverTools) {
          const title = tool.title ? ` "${tool.title}"` : '';
          const destructive = tool.annotations?.destructiveHint === true ? ` [${t('tools.listMcpDestructiveFlag')}]` : '';
          lines.push(`  - ${tool.name}${title}${destructive}: ${tool.description ?? t('tools.listMcpNoDescription')}`);
        }
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      metadata: { serverCount: servers.length, toolCount: tools.length },
    };
  } catch (err) {
    return errorText(t('tools.listMcpFailed', { message: err instanceof Error ? err.message : String(err) }));
  }
}

/** action=call：调用指定 MCP 服务器上的工具 */
async function runCall(p: McpParams, ctx: ToolContext): Promise<ToolResult> {
  if (!p.server || !p.tool) {
    return errorText(`Error: ${t('tools.useMcpServerRequired')}`);
  }

  const mgr = ctx.services.tryResolve<MCPManager>(ServiceNames.MCP_MANAGER);
  if (!mgr) {
    return errorText(`Error: ${t('tools.useMcpManagerUnavailable')}`);
  }

  // server 启用检查（disabled / 未定义 → 拒绝）
  if (mgr.isServerEnabled(p.server) !== true) {
    return errorText(`Error: ${t('tools.useMcpServerDisabled', { server: p.server })}`);
  }

  try {
    // 超时：优先 toolConfig.timeout（config.tools.mcp），回退 config.mcp.callTimeoutMs（120s）
    const timeoutMs =
      (typeof ctx.toolConfig?.timeout === 'number' ? ctx.toolConfig.timeout : undefined) ??
      120000;
    const result = await mgr.callTool(p.server, p.tool, p.arguments ?? {}, {
      timeoutMs,
      signal: ctx.signal,
    });
    // resource 完整数据收集（metadata 供前端渲染引用卡片）
    const resources = result.content
      .filter((c): c is Extract<typeof c, { type: 'resource' }> => c.type === 'resource')
      .map(c => ({ uri: c.uri, mimeType: c.mimeType, text: c.text, blob: c.blob }));
    const content = result.content.map(c => {
      if (c.type === 'text') {
        return { type: 'text' as const, text: c.text };
      }
      if (c.type === 'image') {
        return {
          type: 'image' as const,
          source: { data: c.data, mimeType: c.mimeType },
        };
      }
      // resource：正文给可读摘要，完整数据在 metadata.resources
      const resText = c.text ?? `[resource: ${c.uri} (${c.mimeType ?? 'unknown'})]`;
      return { type: 'text' as const, text: resText };
    });
    return {
      content,
      isError: result.isError,
      metadata: {
        server: p.server,
        tool: p.tool,
        ...(result.structured !== undefined ? { structured: result.structured } : {}),
        ...(resources.length > 0 ? { resources } : {}),
      },
    };
  } catch (err) {
    return errorText(t('tools.useMcpCallFailed', {
      server: p.server,
      tool: p.tool,
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

// ============================================================================
// MCP 市场（search / info / install）
// ============================================================================

function resolveMarket(ctx: ToolContext): McpMarketService | null {
  return ctx.services.tryResolve<McpMarketService>(ServiceNames.MCP_MARKET);
}

function marketSource(p: McpParams): McpMarketSource {
  return p.source ?? 'mcpmarket';
}

/** action=search：搜索/浏览 MCP 市场 */
async function runMarketSearch(p: McpParams, ctx: ToolContext): Promise<ToolResult> {
  const market = resolveMarket(ctx);
  if (!market) return errorText(`Error: ${t('tools.mcpMarketUnavailable', { message: 'service unavailable' })}`);
  const limit = Math.min(20, Math.max(1, typeof p.limit === 'number' ? Math.trunc(p.limit) : 12));
  const keyword = typeof p.keyword === 'string' ? p.keyword.trim() : '';
  try {
    const result = await market.query({
      source: marketSource(p),
      keyword,
      pageSize: limit,
    });
    if (result.items.length === 0) return textResult(t('tools.mcpMarketNoResults'));
    const lines = result.items.map((item) => {
      const version = item.version ? ` v${item.version}` : '';
      const desc = item.description ? ` — ${item.description}` : '';
      return `- ${item.name} [${item.source}:${item.id}]${version}${desc}`;
    });
    const next = result.nextPageToken ? `\n(nextPageToken: ${result.nextPageToken})` : '';
    return textResult(
      `${t('tools.mcpMarketSearchHeader', { source: result.source, count: result.items.length })}\n${lines.join('\n')}\n\n${t('tools.mcpMarketSearchHint')}${next}`,
      { source: result.source, count: result.items.length, nextPageToken: result.nextPageToken },
    );
  } catch (err) {
    return errorText(
      t('tools.mcpMarketUnavailable', {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** action=info：查看市场条目的安装方式与 env 要求 */
async function runMarketInfo(p: McpParams, ctx: ToolContext): Promise<ToolResult> {
  const market = resolveMarket(ctx);
  if (!market) return errorText(`Error: ${t('tools.mcpMarketUnavailable', { message: 'service unavailable' })}`);
  const marketId = typeof p.marketId === 'string' ? p.marketId.trim() : '';
  if (!marketId) return errorText(`Error: ${t('tools.mcpMarketIdRequired')}`);
  try {
    const detail = await market.detail(marketSource(p), marketId);
    const lines: string[] = [];
    lines.push(t('tools.mcpMarketInfoHeader', { source: detail.source }));
    lines.push(`name: ${detail.name}`);
    lines.push(`marketId: ${detail.id}`);
    lines.push(`installName: ${detail.installName}`);
    if (detail.version) lines.push(`version: ${detail.version}`);
    if (detail.homepage) lines.push(`homepage: ${detail.homepage}`);
    if (detail.obtainUrl) lines.push(`obtain: ${detail.obtainUrl}`);
    if (detail.description) lines.push(`description: ${detail.description}`);
    lines.push('');
    lines.push('install options:');
    for (const option of detail.installOptions) {
      const status = option.supported ? 'supported' : `unsupported (${option.unsupportedReason ?? '-'})`;
      lines.push(`  [${option.index}] ${option.label} — ${status}`);
      if (option.command) {
        const args = (option.args ?? []).join(' ');
        lines.push(`      command: ${option.command}${args ? ` ${args}` : ''}`);
      }
      if (option.url) lines.push(`      url: ${option.url}`);
      const editable = option.env.filter((field) => field.fixedValue === undefined);
      const required = editable.filter((field) => field.required).map((field) => field.name);
      const optional = editable.filter((field) => !field.required).map((field) => field.name);
      if (required.length > 0) lines.push(`      required env: ${required.join(', ')}`);
      if (optional.length > 0) lines.push(`      optional env: ${optional.join(', ')}`);
      for (const field of editable) {
        const flags = [field.required ? 'required' : 'optional', field.secret ? 'secret' : ''].filter(Boolean).join(', ');
        const desc = field.description ? ` — ${field.description}` : '';
        const def = field.default ? ` (default: ${field.default})` : '';
        lines.push(`        ${field.name} [${flags}]${def}${desc}`);
      }
    }
    if (detail.installOptions.every((option) => !option.supported)) {
      lines.push('');
      lines.push(t('tools.mcpMarketInfoNoOption'));
    }
    return textResult(lines.join('\n'), {
      source: detail.source,
      marketId: detail.id,
      installName: detail.installName,
      options: detail.installOptions.length,
    });
  } catch (err) {
    return errorText(
      t('tools.mcpMarketUnavailable', {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** action=install：安装市场条目并等待连接结果 */
async function runMarketInstall(p: McpParams, ctx: ToolContext): Promise<ToolResult> {
  const market = resolveMarket(ctx);
  if (!market) return errorText(`Error: ${t('tools.mcpMarketUnavailable', { message: 'service unavailable' })}`);
  const marketId = typeof p.marketId === 'string' ? p.marketId.trim() : '';
  if (!marketId) return errorText(`Error: ${t('tools.mcpMarketIdRequired')}`);
  const env =
    p.env && typeof p.env === 'object' && !Array.isArray(p.env)
      ? Object.fromEntries(
          Object.entries(p.env)
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => [key, value as string]),
        )
      : {};
  try {
    const result = await market.install(
      {
        source: marketSource(p),
        id: marketId,
        ...(typeof p.option === 'number' ? { optionIndex: p.option } : {}),
        env,
        ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name.trim() } : {}),
      },
      { awaitConnect: true },
    );
    let text = t('tools.mcpMarketInstallSuccess', { name: result.name, source: marketSource(p) });
    if (result.connected === false && result.error) {
      text += `\n${t('tools.mcpMarketInstalledDisconnected', { error: result.error })}`;
    }
    return textResult(text, { ...result, source: marketSource(p) });
  } catch (err) {
    if (err instanceof McpMarketError && err.code === 'ENV_REQUIRED') {
      const missing = Array.isArray(err.details?.missing)
        ? (err.details.missing as unknown[]).map(String)
        : [];
      return errorText(t('tools.mcpMarketMissingEnv', { names: missing.join(', ') }));
    }
    return errorText(
      t('tools.mcpMarketInstallFailed', {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = (params ?? {}) as McpParams;
    switch (p.action) {
      case 'list':
        return runList(p, ctx);
      case 'call':
        return runCall(p, ctx);
      case 'search':
        return runMarketSearch(p, ctx);
      case 'info':
        return runMarketInfo(p, ctx);
      case 'install':
        return runMarketInstall(p, ctx);
      default:
        return errorText('Error: action must be one of list, call, search, info, install');
    }
  },
};