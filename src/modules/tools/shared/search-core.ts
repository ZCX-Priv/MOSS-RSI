// src/modules/tools/shared/search-core.ts
// grep / glob 工具共享搜索基础设施：
//  - TYPE_MAP：文件类型名 → glob 后缀映射
//  - GitignoreMatcher：.gitignore / .ignore 规则解析与匹配
//  - walkFiles：异步目录遍历（gitignore 剪枝 / 隐藏文件开关 / 上限保护 / 可取消）
//  - readFileHead + isBinaryBufferHead：只读前 N 字节做二进制检测
//  - toDisplayPath：cwd 内路径相对化（token 优化）
// 注意：本目录位于 builtin/ 平级（loader 只扫 builtin/ 与 custom 目录，不会误加载）。

import { open, readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { Glob } from 'bun';
import { classifyBufferHead } from '../../../utils/fs';

// ============================================================================
// TYPE_MAP：类型名 → 扩展名数组
// ============================================================================

const TYPE_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ts: ['ts', 'tsx', 'mts', 'cts'],
  js: ['js', 'jsx', 'mjs', 'cjs'],
  py: ['py'],
  rust: ['rs'],
  go: ['go'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  cs: ['cs'],
  rb: ['rb'],
  php: ['php'],
  swift: ['swift'],
  md: ['md', 'markdown'],
  json: ['json'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  css: ['css'],
  scss: ['scss', 'sass'],
  less: ['less'],
  html: ['html', 'htm'],
  vue: ['vue'],
  svelte: ['svelte'],
  sh: ['sh', 'bash', 'zsh'],
  bat: ['bat', 'cmd'],
  sql: ['sql'],
  xml: ['xml'],
  astro: ['astro'],
  graphql: ['graphql', 'gql'],
});

/** 支持的类型名清单（用于错误提示） */
export const SUPPORTED_TYPES: readonly string[] = Object.keys(TYPE_MAP).sort();

/**
 * 类型名 → glob 后缀模式数组（如 'ts' 得到 ts/tsx/mts/cts 四种扩展名的通配模式）。
 * 未知类型返回 null（调用方应报错并列出支持的类型）。
 */
export function typeToGlobs(type: string): string[] | null {
  const exts = TYPE_MAP[type];
  if (!exts) return null;
  return exts.map(ext => `**/*.${ext}`);
}

// ============================================================================
// GitignoreMatcher：.gitignore / .ignore 规则匹配
// ============================================================================

interface IgnoreRule {
  /** 编译后的匹配器（Bun.Glob；无 '/' 规则匹配单段路径段，含 '/' 规则匹配整条相对路径） */
  glob: Glob;
  /** 否定规则（! 前缀） */
  negated: boolean;
  /** 目录规则（尾部 /）：仅对目录生效（含作为路径中间段的目录） */
  dirOnly: boolean;
  /** 含 '/'（除尾部外）：相对 .gitignore 所在目录锚定；否则匹配任意层级段 */
  anchored: boolean;
}

/** 单条 gitignore 规则文本 → 规则对象；无法解析（注释/空行）返回 null */
function parseIgnoreLine(line: string): IgnoreRule | null {
  // 去尾部空白（gitignore 语义：行尾空格忽略，除非转义；此处取实用近似）
  let s = line.replace(/\s+$/, '');
  if (s === '' || s.startsWith('#')) return null;

  let negated = false;
  if (s.startsWith('!')) {
    negated = true;
    s = s.slice(1);
    if (s === '') return null;
  }

  let dirOnly = false;
  if (s.endsWith('/')) {
    dirOnly = true;
    s = s.slice(0, -1);
    if (s === '') return null;
  }

  // 前导 / 表示锚定根；去掉前导后，含 '/'（除尾部外）同样锚定
  const hadLeadingSlash = s.startsWith('/');
  if (hadLeadingSlash) s = s.slice(1);
  if (s === '') return null;

  // 前导 / 或规则中含 '/'（除尾部外）→ 整条路径锚定匹配；否则逐段匹配任意层级
  const anchored = hadLeadingSlash || s.includes('/');
  return { glob: new Glob(s), negated, dirOnly, anchored };
}

/**
 * 一份 .gitignore（或 .ignore）文本的规则集。
 * decide() 返回三态：true=忽略 / false=显式保留（否定规则命中）/ null=无规则命中。
 */
export class GitignoreMatcher {
  private readonly rules: readonly IgnoreRule[];

  private constructor(rules: IgnoreRule[]) {
    this.rules = rules;
  }

  /** 解析一段 ignore 文本；无有效规则时返回 null（调用方可跳过压栈） */
  static parse(text: string): GitignoreMatcher | null {
    const rules: IgnoreRule[] = [];
    for (const line of text.split(/\r?\n/)) {
      const rule = parseIgnoreLine(line);
      if (rule) rules.push(rule);
    }
    return rules.length > 0 ? new GitignoreMatcher(rules) : null;
  }

  /** 读取目录下的 .gitignore / .ignore（优先 .gitignore）；无或无有效规则返回 null */
  static async fromDir(absDir: string): Promise<GitignoreMatcher | null> {
    for (const name of ['.gitignore', '.ignore']) {
      let text: string;
      try {
        text = await readFile(`${absDir}/${name}`, 'utf8');
      } catch {
        continue;
      }
      const m = GitignoreMatcher.parse(text);
      if (m) return m;
    }
    return null;
  }

  /** 三态判定：true 忽略 / false 显式保留 / null 无命中 */
  decide(relPath: string, isDir: boolean): boolean | null {
    let result: boolean | null = null;
    const segments = relPath.split('/');
    for (const rule of this.rules) {
      if (this.ruleMatches(rule, segments, relPath, isDir)) {
        result = !rule.negated;
      }
    }
    return result;
  }

  private ruleMatches(rule: IgnoreRule, segments: string[], relPath: string, isDir: boolean): boolean {
    if (rule.anchored) {
      // 含 '/' 规则：整条相对路径匹配（目录规则只对目录本身生效）
      if (rule.dirOnly && !isDir) return false;
      return rule.glob.match(relPath);
    }
    // 无 '/' 规则：匹配任意层级的同名段
    // basename 段按实际 isDir 判定；中间段必为目录
    for (let i = 0; i < segments.length; i++) {
      const isLast = i === segments.length - 1;
      const segIsDir = isLast ? isDir : true;
      if (rule.dirOnly && !segIsDir) continue;
      if (rule.glob.match(segments[i])) return true;
    }
    return false;
  }
}

// ============================================================================
// 目录遍历
// ============================================================================

/** 无条件跳过的目录名（.git 即使 noIgnore=true 也永远跳过） */
export const ALWAYS_SKIP_DIRS = new Set(['.git']);

/** 无 .gitignore 时的兜底忽略目录（noIgnore=true 时仍跳过 .git，其余放行） */
export const DEFAULT_IGNORES = new Set([
  'node_modules', 'dist', 'build', '.next', '.cache',
  '.turbo', 'coverage', '.nyc_output', '.idea', '.vscode', '.svelte-kit',
]);

export interface WalkEntry {
  /** 相对 root 的路径（/ 分隔） */
  rel: string;
  /** 绝对路径 */
  abs: string;
  /** 文件/目录名 */
  name: string;
  /** 是否目录（includeDirs=true 时目录也会产出） */
  isDir: boolean;
}

export interface WalkOptions {
  /** 取消信号；每批产出前检查 */
  signal?: AbortSignal;
  /** 不尊重 .gitignore/.ignore 与 DEFAULT_IGNORES（.git 仍永远跳过） */
  noIgnore?: boolean;
  /** 包含隐藏文件/目录（默认跳过 . 开头；ignore 规则文件本身始终读取） */
  dot?: boolean;
  /** 目录也作为 entry 产出（供 glob 目录匹配） */
  includeDirs?: boolean;
  /** 深度上限（默认 32） */
  maxDepth?: number;
  /** 产出条目上限（默认 50_000），超限停止 */
  maxFiles?: number;
}

/**
 * 异步遍历 root 下所有条目（AsyncGenerator 流式产出，调用方可提前 break 终止遍历）。
 * 每层目录读取 .gitignore/.ignore 构建规则栈（子目录继承父目录规则，深层覆盖浅层）；
 * 目录命中忽略规则 → 整树剪枝（与 git 行为一致：被排除目录内的否定规则不再生效）。
 */
export async function* walkFiles(root: string, opts: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const { signal, noIgnore = false, dot = false, includeDirs = false } = opts;
  const maxDepth = opts.maxDepth ?? 32;
  const maxFiles = opts.maxFiles ?? 50_000;
  let produced = 0;

  /** 栈顶（数组尾）为最深层 matcher；评估时从深到浅取第一个非 null 决定 */
  const evaluate = (rel: string, isDir: boolean): boolean => {
    if (isDir && ALWAYS_SKIP_DIRS.has(rel.split('/').pop()!)) return true;
    if (isDir && !noIgnore && DEFAULT_IGNORES.has(rel.split('/').pop()!)) return true;
    if (!noIgnore) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const r = stack[i].decide(rel, isDir);
        if (r !== null) return r;
      }
    }
    return false;
  };

  const stack: GitignoreMatcher[] = [];

  async function* walk(dir: string, prefix: string, depth: number): AsyncGenerator<WalkEntry> {
    if (depth > maxDepth) return;
    if (signal?.aborted) return;

    let matcher: GitignoreMatcher | null = null;
    try {
      matcher = await GitignoreMatcher.fromDir(dir);
    } catch {
      matcher = null;
    }
    if (matcher) stack.push(matcher);
    try {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (signal?.aborted) return;
        if (produced >= maxFiles) return;
        const name = entry.name;
        const rel = prefix ? `${prefix}/${name}` : name;
        const isHidden = name.startsWith('.');
        if (isHidden && !dot && name !== '.gitignore' && name !== '.ignore') {
          // 隐藏条目默认跳过；规则文件在 fromDir 中已读取，无需产出
          continue;
        }
        if (entry.isDirectory()) {
          if (evaluate(rel, true)) continue; // 整树剪枝
          if (includeDirs) {
            produced++;
            yield { rel, abs: `${dir}/${name}`, name, isDir: true };
          }
          yield* walk(`${dir}/${name}`, rel, depth + 1);
        } else if (entry.isFile()) {
          if (evaluate(rel, false)) continue;
          produced++;
          yield { rel, abs: `${dir}/${name}`, name, isDir: false };
        }
        // symlink / socket 等其他类型跳过（防 symlink 逃逸 cwd）
      }
    } finally {
      if (matcher) stack.pop();
    }
  }

  yield* walk(root, '', 0);
}

// ============================================================================
// 二进制检测（只读文件头部，避免全量读入）
// ============================================================================

/** 只读文件前 N 字节（检测二进制用；文件不存在时 throw，由调用方捕获） */
export async function readFileHead(abs: string, bytes = 8192): Promise<Buffer> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * 基于前 N 字节 Buffer 判定"非 UTF-8 文本"（grep 语义：binary 或 legacy-text 均跳过，
 * 与旧实现逐字节等价 —— NUL 字节或非法 UTF-8 即 true）。判定逻辑统一走 utils 层 classifyBufferHead。
 */
export function isBinaryBufferHead(buf: Buffer): boolean {
  return classifyBufferHead(buf) !== 'utf8';
}

// ============================================================================
// 显示路径（token 优化）
// ============================================================================

/** cwd 内路径 → 相对路径（/ 分隔）；cwd 外或异常 → 原绝对路径 */
export function toDisplayPath(abs: string, cwd: string): string {
  if (!cwd) return abs;
  const rel = relative(cwd, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return abs;
  return rel.split(sep).join('/');
}
