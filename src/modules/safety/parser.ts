// src/modules/safety/parser.ts
// 权限规则字符串解析器。
// 语法：ToolName | ToolName(content)
//   - content 中 ( ) \ 需转义为 \( \) \\
//   - ToolName() 与 ToolName(*) 归一化为工具级规则（等同 ToolName）
//   - terminal 支持三匹配器：exact（无通配）/ prefix（content 以 ":*" 结尾）/ wildcard（含未转义 *）

/** 解析后的规则值 */
export interface ParsedRule {
  toolName: string;
  /** undefined = 工具级规则（匹配该工具全部调用） */
  ruleContent?: string;
}

/** 转义规则内容中的特殊字符（序列化用） */
export function escapeRuleContent(content: string): string {
  return content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** 反转义规则内容 */
export function unescapeRuleContent(content: string): string {
  return content.replace(/\\(.)/g, '$1');
}

/**
 * 找到字符串中未转义的首个指定字符位置（-1 表示不存在）。
 * 转义判定：前导反斜杠数量为奇数则视为转义。
 */
function findFirstUnescapedChar(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ch) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * 找到字符串中未转义的最后一个指定字符位置（-1 表示不存在）。
 */
function findLastUnescapedChar(s: string, ch: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== ch) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * 解析规则字符串 "ToolName" 或 "ToolName(content)"。
 * 非法输入（括号不闭合等）返回 null，调用方应忽略该规则（fail-safe：坏规则不参与匹配）。
 */
export function parseRule(rule: string): ParsedRule | null {
  const trimmed = rule.trim();
  if (!trimmed) return null;
  const firstParen = findFirstUnescapedChar(trimmed, '(');
  // 无括号：纯工具名
  if (firstParen === -1) {
    if (/[()\\]/.test(trimmed)) return null; // 工具名含非法字符（未闭合括号等）
    return { toolName: trimmed };
  }
  const lastParen = findLastUnescapedChar(trimmed, ')');
  if (lastParen === -1 || lastParen < firstParen) return null;
  // 括号后还有残余字符（如 "a(b)c"）视为非法
  if (trimmed.slice(lastParen + 1).length > 0) return null;
  const toolName = trimmed.slice(0, firstParen);
  if (!toolName || /[()\\]/.test(toolName)) return null;
  const rawContent = trimmed.slice(firstParen + 1, lastParen);
  // 归一化：空内容或纯 * = 工具级规则
  if (rawContent === '' || unescapeRuleContent(rawContent) === '*') {
    return { toolName };
  }
  return { toolName, ruleContent: unescapeRuleContent(rawContent) };
}

/** 序列化回规则字符串（用于规则建议生成与持久化去重） */
export function serializeRule(parsed: ParsedRule): string {
  if (parsed.ruleContent === undefined) return parsed.toolName;
  return `${parsed.toolName}(${escapeRuleContent(parsed.ruleContent)})`;
}
