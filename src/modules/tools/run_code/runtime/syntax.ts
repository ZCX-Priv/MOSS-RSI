// src/modules/tools/run_code/runtime/syntax.ts
// 程序源码的结构扫描与错误定位：
//   1. scanStructure：在交给 Bun.Transpiler 之前检查括号/字符串/注释/模板/正则是否配对，
//      给出「第 X 行第 Y 列」与代码片段（转译器的 AggregateError 只有 Parse error，没有位置）；
//   2. splitTopLevelChunks + locateChunkFailure：转译器仍失败时，按顶层语句二分定位到出错语句；
//   3. formatSourceExcerpt：生成带行号与 caret 的片段。
//
// 这是轻量结构扫描，不是完整 TS 解析器：它只负责「括号/引号层面」的确定性问题。

export interface SyntaxIssue {
  /** 1 基行号（相对程序自身，不是包裹后的源码） */
  line: number;
  /** 1 基列号 */
  column: number;
  message: string;
  /** 带行号与 caret 的代码片段 */
  excerpt: string;
  hint?: string;
}

export interface TopLevelChunk {
  startLine: number;
  endLine: number;
  text: string;
}

type StackEntry =
  | { kind: 'paren' | 'bracket' | 'brace'; char: '(' | '[' | '{'; line: number; column: number }
  | { kind: 'template'; line: number; column: number }
  | { kind: 'templateExpr'; line: number; column: number };

interface Cursor {
  line: number;
  column: number;
}

/** 括号字符的人类可读名（保留原字符，避免把 } 写成 {） */
function describe(char: '(' | '[' | '{' | ')' | ']' | '}'): string {
  return `'${char}'`;
}

/** 是否允许 `/` 开始正则（上一个有效 token 类别） */
function canStartRegex(kind: 'value' | 'punct' | 'keyword' | 'none'): boolean {
  return kind !== 'value';
}

const REGEX_ALLOWING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

/** 生成带行号与 caret 的代码片段（默认前后 2 行） */
export function formatSourceExcerpt(
  source: string,
  line: number,
  column: number,
  radius = 2,
): string {
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.length === 0) return '';
  const target = Math.min(Math.max(line, 1), lines.length);
  const from = Math.max(1, target - radius);
  const to = Math.min(lines.length, target + radius);
  const width = String(to).length;
  const rows: string[] = [];
  for (let i = from; i <= to; i++) {
    const marker = i === target ? '>' : ' ';
    rows.push(`${marker} ${String(i).padStart(width)} | ${lines[i - 1] ?? ''}`);
    if (i === target) {
      const caretColumn = Math.max(1, column);
      const prefix = `  ${' '.repeat(width)} | `;
      rows.push(`${prefix}${' '.repeat(caretColumn - 1)}^`);
    }
  }
  return rows.join('\n');
}

/** 结构扫描：只检查括号/字符串/注释/模板/正则的配对。 */
export function scanStructure(source: string): { ok: true } | { ok: false; issue: SyntaxIssue } {
  const stack: StackEntry[] = [];
  let line = 1;
  let column = 1;
  let i = 0;
  let lastKind: 'value' | 'punct' | 'keyword' | 'none' = 'none';

  const issue = (message: string, atLine = line, atColumn = column, hint?: string): {
    ok: false;
    issue: SyntaxIssue;
  } => ({
    ok: false,
    issue: {
      line: atLine,
      column: atColumn,
      message,
      excerpt: formatSourceExcerpt(source, atLine, atColumn),
      ...(hint ? { hint } : {}),
    },
  });

  const advance = (): void => {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    i += 1;
  };

  /** 跳过引号字符串（单/双引号）；返回错误或 null */
  const skipQuoted = (quote: "'" | '"'): { ok: false; issue: SyntaxIssue } | null => {
    const startLine = line;
    const startColumn = column;
    advance(); // 开引号
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        advance();
        if (i < source.length) advance();
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        return issue(`${quote === "'" ? "'" : '"'} 字符串未闭合（起始于第 ${startLine} 行第 ${startColumn} 列）`, startLine, startColumn, '检查该字符串的结尾引号，或改用模板字符串');
      }
      if (ch === quote) {
        advance();
        return null;
      }
      advance();
    }
    return issue(`${quote === "'" ? "'" : '"'} 字符串未闭合（起始于第 ${startLine} 行第 ${startColumn} 列）`, startLine, startColumn, '检查该字符串的结尾引号');
  };

  /** 跳过正则字面量（/.../flags）；返回错误或 null */
  const skipRegex = (): { ok: false; issue: SyntaxIssue } | null => {
    const startLine = line;
    const startColumn = column;
    advance(); // 开 /
    let inClass = false;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        advance();
        if (i < source.length) advance();
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        return issue(`正则字面量未闭合（起始于第 ${startLine} 行第 ${startColumn} 列）`, startLine, startColumn, '检查 /.../ 的结尾，或把除法表达式拆开');
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        advance();
        // flags
        while (i < source.length && /[A-Za-z]/.test(source[i] as string)) advance();
        return null;
      }
      advance();
    }
    return issue(`正则字面量未闭合（起始于第 ${startLine} 行第 ${startColumn} 列）`, startLine, startColumn, '检查 /.../ 的结尾');
  };

  while (i < source.length) {
    const top = stack[stack.length - 1];
    const mode = top?.kind === 'template' ? 'template' : 'code';
    const ch = source[i] as string;

    if (mode === 'template') {
      if (ch === '\\') {
        advance();
        if (i < source.length) advance();
        continue;
      }
      if (ch === '`') {
        stack.pop();
        advance();
        // 回到 code 后，上一个有效 token 视为一个值（模板字符串是一个表达式）
        lastKind = 'value';
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        stack.push({ kind: 'templateExpr', line, column });
        advance();
        advance();
        lastKind = 'punct';
        continue;
      }
      advance();
      continue;
    }

    // ---- code 模式 ----
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      const startColumn = column;
      advance();
      advance();
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) advance();
      if (i >= source.length) {
        return issue(`块注释未闭合（起始于第 ${startLine} 行第 ${startColumn} 列）`, startLine, startColumn, '补上 */');
      }
      advance();
      advance();
      continue;
    }
    if (ch === "'" || ch === '"') {
      const failure = skipQuoted(ch);
      if (failure) return failure;
      lastKind = 'value';
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template', line, column });
      advance();
      lastKind = 'punct';
      continue;
    }
    if (ch === '/') {
      if (canStartRegex(lastKind)) {
        const failure = skipRegex();
        if (failure) return failure;
        lastKind = 'value';
        continue;
      }
      advance();
      lastKind = 'punct';
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({
        kind: ch === '(' ? 'paren' : ch === '[' ? 'bracket' : 'brace',
        char: ch,
        line,
        column,
      });
      advance();
      lastKind = 'punct';
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const expected: 'paren' | 'bracket' | 'brace' =
        ch === ')' ? 'paren' : ch === ']' ? 'bracket' : 'brace';
      if (expected === 'brace' && top?.kind === 'templateExpr') {
        stack.pop();
        advance();
        // 回到模板文本模式
        continue;
      }
      if (!top || top.kind !== expected) {
        if (!top) {
          return issue(`多余的 ${describe(ch)}（没有对应的开符号）`, line, column, '检查这一行的括号闭合');
        }
        if (top.kind === 'template' || top.kind === 'templateExpr') {
          return issue(`多余的 ${describe(ch)}（当前在模板字符串内部）`, line, column);
        }
        return issue(
          `多余的 ${describe(ch)}（最近的未闭合符号是第 ${top.line} 行第 ${top.column} 列的 ${describe(top.char)}）`,
          line,
          column,
          '括号不匹配通常出现在 ui.render/ui.box 的闭合处；建议把大段 UI 拆成变量再组装',
        );
      }
      stack.pop();
      advance();
      lastKind = expected === 'brace' ? 'punct' : 'value';
      continue;
    }

    // 标识符 / 关键字 / 数字：更新「上一个有效 token」类别，用于判定 / 是正则还是除法
    if (/[A-Za-z_$\u00A0-\uFFFF]/.test(ch) || (ch >= '0' && ch <= '9')) {
      let word = '';
      while (i < source.length && /[A-Za-z0-9_$\u00A0-\uFFFF]/.test(source[i] as string)) {
        word += source[i];
        advance();
      }
      lastKind = REGEX_ALLOWING_KEYWORDS.has(word) ? 'keyword' : 'value';
      continue;
    }

    advance();
    // 其余运算符/标点：允许其后的 / 作为正则起点
    lastKind = 'punct';
  }

  const leftover = stack[stack.length - 1];
  if (leftover) {
    if (leftover.kind === 'template') {
      return issue(`模板字符串未闭合（起始于第 ${leftover.line} 行第 ${leftover.column} 列）`, leftover.line, leftover.column, '补上结尾的反引号 `');
    }
    if (leftover.kind === 'templateExpr') {
      return issue(`模板字符串的 \${ 表达式未闭合（起始于第 ${leftover.line} 行第 ${leftover.column} 列）`, leftover.line, leftover.column, '补上 }');
    }
    const ch = leftover.char;
    return issue(`第 ${leftover.line} 行第 ${leftover.column} 列的 ${describe(ch)} 未闭合`, leftover.line, leftover.column, `补上 ${ch === '(' ? ')' : ch === '[' ? ']' : '}'}`);
  }

  return { ok: true };
}

/**
 * 按顶层语句切块：只在括号深度为 0 且行尾是 `;` 或 `}` 时切分。
 * 保守策略：无法确定边界时合并，宁可少切也不误切。
 */
export function splitTopLevelChunks(source: string): TopLevelChunk[] {
  const lines = source.split(/\r\n|\r|\n/);
  const chunks: TopLevelChunk[] = [];
  let depth = 0;
  let startLine = 1;
  let inTemplate = false;
  let inBlockComment = false;

  const stripped = (text: string): string => {
    // 去掉行尾注释（只处理不在字符串里的 //；这里只用于判断行尾字符）
    let out = '';
    let quote: "'" | '"' | '`' | null = null;
    for (let k = 0; k < text.length; k++) {
      const c = text[k] as string;
      if (quote) {
        out += c;
        if (c === '\\') {
          out += text[k + 1] ?? '';
          k += 1;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c;
        out += c;
        continue;
      }
      if (c === '/' && text[k + 1] === '/') break;
      out += c;
    }
    return out.trim();
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] as string;
    for (let k = 0; k < text.length; k++) {
      const c = text[k] as string;
      const next = text[k + 1];
      if (inBlockComment) {
        if (c === '*' && next === '/') {
          inBlockComment = false;
          k += 1;
        }
        continue;
      }
      if (!inTemplate && c === '/' && next === '*') {
        inBlockComment = true;
        k += 1;
        continue;
      }
      if (!inTemplate && c === '/' && next === '/') break;
      if (c === '`') {
        inTemplate = !inTemplate;
        continue;
      }
      if (inTemplate) continue;
      if (c === "'" || c === '"') {
        // 跳过字符串
        let j = k + 1;
        while (j < text.length) {
          if (text[j] === '\\') {
            j += 2;
            continue;
          }
          if (text[j] === c) break;
          j += 1;
        }
        k = j;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    }
    if (inTemplate || inBlockComment) continue;
    const tail = stripped(text);
    if (depth === 0 && (tail.endsWith(';') || tail.endsWith('}'))) {
      chunks.push({
        startLine,
        endLine: i + 1,
        text: lines.slice(startLine - 1, i + 1).join('\n'),
      });
      startLine = i + 2;
    }
  }

  if (startLine <= lines.length) {
    const rest = lines.slice(startLine - 1).join('\n');
    if (rest.trim() !== '') {
      chunks.push({ startLine, endLine: lines.length, text: rest });
    }
  }
  return chunks;
}

/**
 * 二分定位第一个解析失败的顶层语句。
 * test 在候选代码非法时应抛错；返回命中的语句起始行与源码。
 */
export function locateChunkFailure(
  program: string,
  test: (candidate: string) => void,
): { line: number; chunk: string } | null {
  const chunks = splitTopLevelChunks(program);
  if (chunks.length === 0) return null;
  if (chunks.length === 1) {
    try {
      test(program);
      return null;
    } catch {
      return { line: 1, chunk: program };
    }
  }

  const fails = (count: number): boolean => {
    try {
      test(chunks.slice(0, count).map((chunk) => chunk.text).join('\n'));
      return false;
    } catch {
      return true;
    }
  };

  // 第一个 chunk 就失败 → 错误在第 1 个语句
  if (fails(1)) return { line: chunks[0]?.startLine ?? 1, chunk: chunks[0]?.text ?? program };

  let low = 1;
  let high = chunks.length;
  // 找到「前缀合法/非法」的边界：low 合法，high 非法（或全部合法）
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (fails(mid)) high = mid;
    else low = mid;
  }
  if (!fails(high)) return null;
  const chunk = chunks[high - 1];
  return chunk ? { line: chunk.startLine, chunk: chunk.text } : null;
}
