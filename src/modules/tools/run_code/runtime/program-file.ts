// src/modules/tools/run_code/runtime/program-file.ts
// 超级PTC 临时程序模块：把「函数体式程序」写成可被 Bun 原生加载的 ESM 模块。
//
// 设计要点：
//   - 只提升程序开头的 import（ESM 语言要求 import 位于模块顶层）；
//   - 相对静态导入重写为 file:// 绝对路径，保证以 cwd 为基准解析；
//   - 临时目录放在 {cwd}/.cache/moss-ptc（.cache 已被文件监控忽略）；
//   - 每次运行独立目录，运行结束由 host 清理；启动后清理过期残留。

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export interface ProgramFile {
  /** 本次运行独占的临时目录 */
  dir: string;
  /** 生成的 program.ts 绝对路径 */
  path: string;
  /** 生成文件行号 - lineOffset = 原程序行号 */
  lineOffset: number;
}

export interface SplitImportsResult {
  /** 程序开头（注释/空行/import）原样文本 */
  head: string;
  /** 去掉开头 import 后的程序主体 */
  body: string;
  /** 主体第一行在原程序中的行号（1 基） */
  bodyStartLine: number;
}

/** 生成模块头部（与 body 之间的固定行数由 headerLines 计算） */
const MODULE_HEADER_LINES = [
  'const __moss_ctx = (globalThis as Record<string, unknown>).__moss_ptc_ctx as Record<string, unknown>;',
  'const { tools, ui, console, process, fetch, Bun, sleep, now, importModule, require } = __moss_ctx;',
  'const __dirname = __moss_ctx.cwd as string;',
  'const __filename = __moss_ctx.filename as string;',
  '',
  'export default async function __moss_program_main__(): Promise<unknown> {',
];

/**
 * 拆分程序开头的 import 与主体。
 * 只识别「开头连续出现的 import 声明」；程序中间的 import 保持原样，交给 Bun 报语法错误。
 */
export function splitLeadingImports(source: string): SplitImportsResult {
  const lines = source.split(/\r\n|\r|\n/);
  let index = 0;
  let headEnd = 0;

  while (index < lines.length) {
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();

    if (trimmed === '' || trimmed.startsWith('//')) {
      index += 1;
      headEnd = index;
      continue;
    }

    if (trimmed.startsWith('/*')) {
      // 多行块注释：一直跳到 */ 所在行，避免后续 import 被误判为主体代码
      let end = index;
      let closed = false;
      while (end < lines.length) {
        if ((lines[end] ?? '').includes('*/')) {
          closed = true;
          end += 1;
          break;
        }
        end += 1;
      }
      index = end;
      headEnd = end;
      if (!closed) break;
      continue;
    }

    if (!isImportDeclarationStart(trimmed)) break;

    // 多行 import：按括号/引号状态找到语句结束行
    let end = index;
    let depth = 0;
    let quote: '"' | "'" | '`' | null = null;
    let escaped = false;
    let done = false;

    for (; end < lines.length && !done; end += 1) {
      const text = lines[end] ?? '';
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i] as string;
        if (quote) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === quote) {
            quote = null;
          }
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          continue;
        }
        if (ch === '/' && text[i + 1] === '/') break;
        if (ch === '{' || ch === '(' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      }
      const lineTrimmed = text.trim();
      if (depth === 0 && quote === null && isImportStatementEnd(lineTrimmed)) {
        done = true;
      }
    }

    if (!done) {
      // 没找到结尾：把剩余内容都当作 head，交给 Bun 报语法错误
      headEnd = lines.length;
      break;
    }
    index = end;
    headEnd = end;
  }

  const head = lines.slice(0, headEnd).join('\n');
  const body = lines.slice(headEnd).join('\n');
  return { head, body, bodyStartLine: headEnd + 1 };
}

/** 是否以 import 声明开头（排除动态 import(...) 表达式） */
function isImportDeclarationStart(trimmed: string): boolean {
  if (!/^import\b/.test(trimmed)) return false;
  if (/^import\s*\(/.test(trimmed)) return false;
  if (/^import\s*\./.test(trimmed)) return false;
  return true;
}

/** import 语句是否已结束（支持无分号写法与行尾注释） */
function isImportStatementEnd(trimmed: string): boolean {
  const text = stripTrailingLineComment(trimmed);
  if (text === '') return false;
  if (text.endsWith(';')) return true;
  if (/\bfrom\s+['"][^'"]+['"]\s*;?$/.test(text)) return true;
  if (/^import\s+['"][^'"]+['"]\s*;?$/.test(text)) return true;
  return false;
}

/** 去掉引号外的行尾 // 注释（避免把 import 后面的说明当作语句未结束） */
function stripTrailingLineComment(text: string): string {
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') return text.slice(0, i).trim();
  }
  return text.trim();
}

/**
 * 重写 head 中的相对/绝对导入为 file:// URL。
 * 包名与 node: 协议保持不变。
 */
export function rewriteRelativeImports(head: string, cwd: string): string {
  const rewrite = (spec: string): string => {
    if (spec.startsWith('node:')) return spec;
    if (spec.startsWith('file:')) return spec;
    if (!spec.startsWith('.') && !isAbsolute(spec)) return spec;
    return pathToFileURL(resolve(cwd, spec)).href;
  };

  return head
    .replace(
      /(\bfrom\s*)(['"])([^'"]+)\2/g,
      (_match, prefix: string, quote: string, spec: string) => `${prefix}${quote}${rewrite(spec)}${quote}`,
    )
    .replace(
      /(\bimport\s*)(['"])([^'"]+)\2/g,
      (_match, prefix: string, quote: string, spec: string) => `${prefix}${quote}${rewrite(spec)}${quote}`,
    );
}

/**
 * 写入本次运行的临时模块，返回路径与行号偏移。
 * 优先 {cwd}/.cache/moss-ptc；不可写时回退 ~/.moss/tmp/ptc。
 */
export function prepareProgramFile(program: string, cwd: string): ProgramFile {
  const id = randomUUID();
  const { head, body, bodyStartLine } = splitLeadingImports(program);
  const rewrittenHead = rewriteRelativeImports(head, cwd);

  const headerLines = [...MODULE_HEADER_LINES];
  const content = [
    ...(rewrittenHead === '' ? [] : [rewrittenHead]),
    ...headerLines,
    body,
    '}',
    '',
  ].join('\n');

  const headLines = rewrittenHead === '' ? 0 : rewrittenHead.split(/\r\n|\r|\n/).length;
  const generatedBodyStart = headLines + MODULE_HEADER_LINES.length + 1;
  const lineOffset = generatedBodyStart - bodyStartLine;

  const candidates = [
    join(cwd, '.cache', 'moss-ptc', id),
    join(homedir(), '.moss', 'tmp', 'ptc', id),
  ];

  let lastError: unknown;
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'program.ts');
      writeFileSync(path, content, 'utf8');
      return { dir, path, lineOffset };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `无法创建超级PTC临时程序文件：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** 删除本次运行的临时目录（失败忽略，交给过期清理兜底） */
export function cleanupProgramFile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 文件句柄未释放等情况：下次启动时由过期清理兜底
  }
}

const sweptDirs = new Set<string>();

/** 清理 1 小时前的残留临时目录（每个 baseDir 只扫描一次） */
export function sweepStaleProgramDirs(baseDir: string, maxAgeMs = 60 * 60 * 1000): void {
  if (sweptDirs.has(baseDir)) return;
  sweptDirs.add(baseDir);
  try {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(baseDir, entry.name);
      try {
        const stat = statSync(full);
        if (now - stat.mtimeMs > maxAgeMs) {
          rmSync(full, { recursive: true, force: true });
        }
      } catch {
        // 单个目录失败不影响其他目录
      }
    }
  } catch {
    // 目录不存在或无权限：忽略
  }
}
