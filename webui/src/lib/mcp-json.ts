// webui/src/lib/mcp-json.ts
// MCP 服务器「JSON 粘贴导入」解析：把主流 Agent 客户端（Claude Desktop / Cursor /
// Claude Code / VS Code）的配置片段归一化为后端 createMcpServer 所需的定义。
//
// 支持的格式：
//   1. 原生单定义      { "name": "x", "transport": "stdio", "command": "npx", "args": [...] }
//   2. 原生 map        { "x": { "command": "npx", "args": [...] } }
//   3. 标准包裹片段    { "mcpServers": { "x": { "command": "npx" } } }   （Claude Desktop / Cursor）
//                      { "servers":    { "x": { "type": "stdio", "command": "npx" } } } （VS Code）
//   4. 以上任意形态的数组（批量添加；数组元素若为包裹对象同样解包）
//
// 字段兼容：客户端通用 `type` 作为 MOSS 私有 `transport` 的别名；
//   无 type/transport 时按 presence 推导（有 command → stdio，有 url → http）。

export type McpTransport = 'stdio' | 'http' | 'sse';

/** 归一化后的 server 定义（与 POST /api/mcp/servers 的 def 对齐） */
export interface ParsedMcpDef {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** 已知客户端使用的包裹键：Claude Desktop/Cursor/Claude Code 用 mcpServers；VS Code 用 servers */
const WRAPPER_KEYS = ['mcpServers', 'servers'] as const;

/** 把客户端 transport/type 字段值归一化为 MOSS 的 transport 三态；无法识别返回 null */
function normalizeTransport(raw: unknown): McpTransport | null {
  if (typeof raw !== 'string') return null;
  switch (raw.trim().toLowerCase()) {
    case 'stdio':
      return 'stdio';
    case 'sse':
      return 'sse';
    case 'http':
    case 'streamable-http':
    case 'streamablehttp':
      return 'http';
    default:
      return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 归一化单个 server 定义：原生格式（含 name/transport）或 map 值（name 取 key） */
export function normalizeMcpDef(value: unknown, nameFromKey?: string): ParsedMcpDef | null {
  if (!isPlainObject(value)) return null;
  const v = value;
  const name =
    typeof v.name === 'string' && v.name.trim() ? v.name.trim() : (nameFromKey ?? '').trim();
  if (!name) return null;
  const hasCommand = typeof v.command === 'string' && v.command.trim().length > 0;
  const hasUrl = typeof v.url === 'string' && v.url.trim().length > 0;
  // transport 解析顺序：显式 transport → 客户端 type 别名 → 由 command/url 推导
  const transport: McpTransport | null =
    normalizeTransport(v.transport) ?? normalizeTransport(v.type) ?? (hasCommand ? 'stdio' : hasUrl ? 'http' : null);
  if (!transport) return null;
  if (transport === 'stdio' && !hasCommand) return null;
  if (transport !== 'stdio' && !hasUrl) return null;

  const def: ParsedMcpDef = { name, transport };
  if (hasCommand) def.command = (v.command as string).trim();
  if (Array.isArray(v.args)) {
    const args = v.args.filter((a): a is string => typeof a === 'string');
    if (args.length > 0) def.args = args;
  }
  if (isPlainObject(v.env)) {
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.env)) {
      if (typeof val === 'string') env[k] = val;
    }
    if (Object.keys(env).length > 0) def.env = env;
  }
  if (hasUrl) def.url = (v.url as string).trim();
  if (isPlainObject(v.headers)) {
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.headers)) {
      if (typeof val === 'string') headers[k] = val;
    }
    if (Object.keys(headers).length > 0) def.headers = headers;
  }
  return def;
}

/** 若 obj 含包裹键（mcpServers/servers），解包其内部 map 为定义数组；否则返回 null */
function unwrapWrapper(obj: Record<string, unknown>): ParsedMcpDef[] | null {
  for (const key of WRAPPER_KEYS) {
    const inner = obj[key];
    if (isPlainObject(inner)) {
      const defs: ParsedMcpDef[] = [];
      for (const [name, val] of Object.entries(inner)) {
        const d = normalizeMcpDef(val, name);
        if (d) defs.push(d);
      }
      return defs;
    }
  }
  return null;
}

/** 处理一个对象：优先解包包裹层 → 其次单定义 → 最后 map */
function collectFromObject(obj: Record<string, unknown>, defs: ParsedMcpDef[]): void {
  const unwrapped = unwrapWrapper(obj);
  if (unwrapped) {
    defs.push(...unwrapped);
    return;
  }
  if (
    typeof obj.name === 'string' ||
    typeof obj.transport === 'string' ||
    typeof obj.type === 'string' ||
    typeof obj.command === 'string' ||
    typeof obj.url === 'string'
  ) {
    const d = normalizeMcpDef(obj);
    if (d) defs.push(d);
    return;
  }
  for (const [name, val] of Object.entries(obj)) {
    const d = normalizeMcpDef(val, name);
    if (d) defs.push(d);
  }
}

/**
 * 解析 JSON 粘贴内容为服务器定义数组；无法识别时返回空数组。
 * JSON 语法错误会由 JSON.parse 抛出，调用方负责捕获并提示。
 */
export function parseMcpJsonInput(raw: string): ParsedMcpDef[] {
  const parsed: unknown = JSON.parse(raw);
  const defs: ParsedMcpDef[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (isPlainObject(item)) {
        collectFromObject(item, defs);
      } else {
        const d = normalizeMcpDef(item);
        if (d) defs.push(d);
      }
    }
  } else if (isPlainObject(parsed)) {
    collectFromObject(parsed, defs);
  }
  return defs;
}
