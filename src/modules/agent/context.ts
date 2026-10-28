// src/modules/agent/context.ts
// 工具描述注入（工具 schema 构建）。
// 系统提示词构建已迁入 context 引擎（compiler/system-prompt.ts：静态前缀 + 缓存对齐布局）。

import type { UnifiedTool } from '../llm/types';
import type { ToolRegistry } from '../contracts';

/** 代码模式 wire 过滤选项（按完整工具名，MCP 用 mcp__server__tool） */
export interface BuildToolsOptions {
  /** 只暴露这些工具（ptc 模式：仅 run_code） */
  includeOnly?: ReadonlySet<string>;
  /** 排除这些工具（代码模式关闭时排除 run_code） */
  exclude?: ReadonlySet<string>;
}

/**
 * 把 ToolRegistry 中的工具 schema 转换为 UnifiedTool 数组，供 LLM 注入。
 * 同时注入 MCP 工具（若 MCPManager 已注册）。
 */
export function buildTools(
  toolRegistry: ToolRegistry | null,
  mcpTools?: Array<{
    server: string;
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
  }>,
  opts: BuildToolsOptions = {},
): UnifiedTool[] {
  const tools: UnifiedTool[] = [];
  const allowed = (name: string): boolean =>
    (!opts.includeOnly || opts.includeOnly.has(name)) && (!opts.exclude || !opts.exclude.has(name));

  // 内置工具
  if (toolRegistry) {
    for (const t of toolRegistry.listSchemas()) {
      if (!allowed(t.name)) continue;
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      });
    }
  }

  // MCP 工具（用 mcp__server__tool 前缀，避免命名冲突；title 附加到描述）
  if (mcpTools) {
    for (const t of mcpTools) {
      const toolName = `mcp__${t.server}__${t.name}`;
      if (!allowed(toolName)) continue;
      const titleSuffix = t.title && t.title !== t.name ? ` "${t.title}"` : '';
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: `[MCP:${t.server}${titleSuffix}] ${t.description ?? t.name}`,
          parameters: t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
        },
      });
    }
  }

  return tools;
}
