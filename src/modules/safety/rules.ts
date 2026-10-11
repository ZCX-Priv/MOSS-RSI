// src/modules/safety/rules.ts
// 权限规则匹配器。
// 三匹配器：exact（精确）/ prefix（":*" 结尾）/ wildcard（含 *）。
// 安全约束（源码级）：
//   1. 复合命令（含 && ; | 换行）仅允许 exact 规则匹配 —— 防 terminal(cd *) 放行 "cd / && format c:"
//   2. deny/ask 匹配前剥离全部前导环境变量 —— "FOO=bar rm" 仍被 deny(terminal(rm *)) 拦截
//   3. allow 匹配前仅剥离安全包装（timeout/time/nice/nohup + SAFE_ENV_VARS 白名单）；
//      PATH/LD_*/DYLD_*/PYTHONPATH/NODE_OPTIONS 绝不剥离（二进制劫持防护）

import { parseRule } from './parser';

/** 可在 allow 匹配前剥离的安全包装命令（前缀词） */
const SAFE_WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup']);

/** 可在 allow 匹配前剥离的安全环境变量白名单（小写） */
const SAFE_ENV_VARS = new Set(['node_env', 'rust_log', 'lang', 'lc_all', 'tz', 'editor', 'visual']);

/**
 * 绝不剥离的环境变量（二进制劫持防护）：
 * PATH / LD_* / DYLD_* 会改变解析到的可执行文件，PYTHONPATH / NODE_OPTIONS 可注入代码。
 */
const BINARY_HIJACK_VARS = /^(path|ld_|dyld_|pythonpath|node_options|perl5lib|rubyopt|java_tool_options)/i;

/** 从 params 提取终端命令（仅 terminal 类工具有 command 字段） */
function extractCommand(params: unknown): string | undefined {
  if (params && typeof params === 'object' && 'command' in params) {
    const cmd = (params as Record<string, unknown>).command;
    if (typeof cmd === 'string' && cmd.trim()) return cmd;
  }
  return undefined;
}

/** 从 params 提取写类工具的目标路径（path/dest/to/target 字段） */
export function extractTargetPaths(params: unknown): string[] {
  if (!params || typeof params !== 'object') return [];
  const obj = params as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['path', 'dest', 'to', 'target']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) out.push(v);
  }
  return out;
}

/** 判断是否复合命令（含命令分隔符） */
export function isCompoundCommand(command: string): boolean {
  return /[\n;&|]/.test(command);
}

/** 拆分复合命令为子命令段（供危险模式库逐段检测） */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/[\n;&|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 剥离全部前导环境变量赋值（deny/ask 匹配用）：
 * "FOO=bar Baz=qux rm -rf x" → "rm -rf x"
 */
export function stripAllLeadingEnvVars(command: string): string {
  let rest = command.trim();
  const envVarRe = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/;
  while (true) {
    const m = rest.match(envVarRe);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest;
}

/**
 * 剥离安全包装（allow 匹配用）：
 * "timeout 10 NODE_ENV=prod npm install" → "npm install"
 * 仅剥离 SAFE_WRAPPERS 前缀与 SAFE_ENV_VARS 白名单变量；劫持类变量绝不剥离。
 */
export function stripSafeWrappers(command: string): string {
  let rest = command.trim();
  let changed = true;
  const wrapperRe = new RegExp(`^(?:${Array.from(SAFE_WRAPPERS).join('|')})(?:[ \\t]+\\S+)*[ \\t]+`, 'i');
  const envRe = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)[ \t]+/;
  while (changed) {
    changed = false;
    const wm = rest.match(wrapperRe);
    if (wm) {
      rest = rest.slice(wm[0].length);
      changed = true;
      continue;
    }
    const em = rest.match(envRe);
    if (em && SAFE_ENV_VARS.has(em[1].toLowerCase()) && !BINARY_HIJACK_VARS.test(em[1])) {
      rest = rest.slice(em[0].length);
      changed = true;
    }
  }
  return rest;
}

/** 旧式前缀语法提取："git:*" → "git"（null=非前缀语法） */
function extractPrefix(ruleContent: string): string | null {
  const m = ruleContent.match(/^(.+):\*$/);
  return m ? m[1] : null;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 通配符匹配：* → .*。
 * 优化：模式为 "prefix *"（单个尾部 * 且前面是空格）时匹配 "prefix" 本身（尾部可选）。
 */
function matchWildcard(pattern: string, text: string): boolean {
  const starCount = (pattern.match(/\*/g) ?? []).length;
  try {
    if (starCount === 1 && pattern.endsWith(' *')) {
      // "git *" → ^git( .*)?$：同时匹配 "git" 与 "git add ..."
      const prefix = escapeForRegex(pattern.slice(0, -2));
      return new RegExp(`^${prefix}( .*)?$`, 's').test(text);
    }
    const regexSrc = pattern.split('*').map(escapeForRegex).join('.*');
    return new RegExp(`^${regexSrc}$`, 's').test(text);
  } catch {
    return false;
  }
}

/**
 * 匹配单条规则。
 * @param rule 规则字符串（ToolName 或 ToolName(content)）
 * @param toolName 实际工具名（mcp__server__tool 全名）
 * @param params 工具参数
 * @param cwd 工作目录（写类工具相对路径解析基准）
 * @param phase 匹配阶段：'restrictive'（deny/ask 规则，剥全部 env）| 'permissive'（allow 规则，剥安全包装）
 */
export function matchRule(
  rule: string,
  toolName: string,
  params: unknown,
  cwd: string,
  phase: 'restrictive' | 'permissive',
): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;

  // 工具级规则（无 content）：工具名精确或尾部 * 通配（如 mcp__github__*）
  if (parsed.ruleContent === undefined) {
    if (parsed.toolName === toolName) return true;
    if (parsed.toolName.endsWith('*') && toolName.startsWith(parsed.toolName.slice(0, -1))) return true;
    return false;
  }

  // MCP 工具：toolName 即 mcp__server__tool 全名，content 匹配该全名
  if (toolName.startsWith('mcp__')) {
    return matchWildcard(parsed.ruleContent, toolName) || parsed.ruleContent === toolName;
  }

  const command = extractCommand(params);
  if (command !== undefined) {
    // 安全约束：复合命令仅允许 exact 匹配完整字符串
    if (isCompoundCommand(command)) {
      return parsed.ruleContent === command.trim();
    }
    const effective = phase === 'restrictive' ? stripAllLeadingEnvVars(command) : stripSafeWrappers(command);
    const normalized = effective.trim();

    const prefix = extractPrefix(parsed.ruleContent);
    if (prefix !== null) {
      return normalized === prefix || normalized.startsWith(`${prefix} `);
    }
    if (parsed.ruleContent.includes('*')) {
      return matchWildcard(parsed.ruleContent, normalized);
    }
    return parsed.ruleContent === normalized;
  }

  // 写类工具路径匹配：规则 content 为 glob 模式（Bun.Glob；支持 ** 与绝对/相对）
  const targets = extractTargetPaths(params);
  if (targets.length === 0) return false;
  let glob: Bun.Glob;
  try {
    glob = new Bun.Glob(parsed.ruleContent);
  } catch {
    return false;
  }
  const normCwd = cwd.replace(/[\\/]+$/, '');
  for (const target of targets) {
    const isAbs = target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(target);
    const abs = isAbs ? target : `${normCwd}/${target}`;
    if (glob.match(abs) || glob.match(target)) return true;
  }
  return false;
}
