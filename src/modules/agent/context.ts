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
  /**
   * 工具结果摘要开启时，为每个工具注入 resultMode 公共参数
   * （summary=先摘要后给模型（默认）/ original=原文完整返回）。
   * 关闭时不注入，模型无法选择。
   */
  injectResultMode?: boolean;
}

/** resultMode 参数 schema（注入到每个工具的 parameters.properties） */
const RESULT_MODE_PROPERTY = {
  type: 'string',
  enum: ['summary', 'original'],
  default: 'summary',
  description:
    '工具结果返回方式：summary = 先由摘要模型压缩后返回（默认）；original = 返回完整原文。' +
    '仅当上下文设置开启「工具结果摘要」时生效。',
};

/**
 * 克隆 schema 并注入 resultMode 参数（不修改注册表原对象）。
 * 原 schema 非对象或缺失时，构造一个只含 resultMode 的对象 schema。
 */
function withResultMode(schema: unknown): unknown {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const base = schema as Record<string, unknown>;
    const rawProps = base.properties;
    const properties =
      rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps)
        ? { ...(rawProps as Record<string, unknown>) }
        : {};
    if (!('resultMode' in properties)) {
      properties.resultMode = { ...RESULT_MODE_PROPERTY };
    }
    return {
      ...base,
      type: typeof base.type === 'string' ? base.type : 'object',
      properties,
    };
  }
  return { type: 'object', properties: { resultMode: { ...RESULT_MODE_PROPERTY } } };
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
          parameters: opts.injectResultMode ? withResultMode(t.inputSchema) : t.inputSchema,
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
      const parameters = t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true };
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: `[MCP:${t.server}${titleSuffix}] ${t.description ?? t.name}`,
          parameters: opts.injectResultMode ? withResultMode(parameters) : parameters,
        },
      });
    }
  }

  return tools;
}
