// webui/src/lib/tool-name.ts
// 工具名展示层格式化（纯函数，无依赖）。
// 传输层 MCP 工具名固定为 mcp__<server>__<tool>（函数名协议不允许 "."），
// UI 统一展示为 mcp.<server>.<tool>。

const MCP_TOOL_PREFIX = 'mcp__';

/** 工具名 → 展示名：mcp__server__tool → mcp.server.tool；其余原样返回 */
export function formatToolDisplayName(name: string): string {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return name;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  if (!rest) return name;
  const sep = rest.indexOf('__');
  if (sep <= 0) return `mcp.${rest}`;
  return `mcp.${rest.slice(0, sep)}.${rest.slice(sep + 2)}`;
}
