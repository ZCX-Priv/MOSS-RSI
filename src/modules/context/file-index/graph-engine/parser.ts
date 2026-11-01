// src/modules/context/file-index/graph-engine/parser.ts
// web-tree-sitter 封装：Parser.init（一次）+ 语言 wasm 懒加载缓存。
// 语法 wasm 来自 tree-sitter-wasm 预构建包（v2 布局：node_modules/tree-sitter-wasm/<lang>/）。
// wasm 定位策略：dist/vendor（构建产物）→ node_modules（开发模式），均支持。

import { Parser, Language } from 'web-tree-sitter';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 扩展名 → tree-sitter 语言名（tree-sitter-wasm 目录名） */
const LANG_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
};

/** 扩展名 → 语言名（未知扩展名返回 null） */
export function langOfExt(ext: string): string | null {
  return LANG_BY_EXT[ext] ?? null;
}

// ============================================================================
// wasm 路径定位
// ============================================================================

/** 本文件目录（src/modules/context/file-index/graph-engine 或 dist 内对应路径） */
const HERE = import.meta.dir;

function candidateRoots(): string[] {
  const roots: string[] = [];
  // 开发模式：src/modules/context/file-index/graph-engine → 上 5 层为项目根
  roots.push(join(HERE, '..', '..', '..', '..', '..'));
  // 编译产物：dist/server.js 内联路径不定 → import.meta.dir 的各级父目录向上找
  let cur = HERE;
  for (let i = 0; i < 6; i++) {
    cur = dirname(cur);
    roots.push(cur);
    roots.push(join(cur, 'dist'));
  }
  return roots;
}

function findFile(relSegments: string[]): string | null {
  for (const root of candidateRoots()) {
    const p = join(root, ...relSegments);
    try {
      if (existsSync(p)) return p;
    } catch {
      // 继续
    }
  }
  return null;
}

let coreWasmPath: string | null | undefined;

/** web-tree-sitter 核心 wasm 路径（定位失败为 null） */
function getCoreWasmPath(): string | null {
  if (coreWasmPath !== undefined) return coreWasmPath;
  coreWasmPath = findFile(['node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'])
    ?? findFile(['vendor', 'web-tree-sitter.wasm']);
  return coreWasmPath;
}

/** 语言 wasm 路径（tree-sitter-wasm 包内；定位失败为 null） */
function getLangWasmPath(lang: string): string | null {
  const fileName = `tree-sitter-${lang}.wasm`;
  return (
    // 开发模式：tree-sitter-wasm v2 布局（<lang>/…），v1（out/<lang>/…）兼容
    findFile(['node_modules', 'tree-sitter-wasm', lang, fileName])
    ?? findFile(['node_modules', 'tree-sitter-wasm', 'out', lang, fileName])
    // 构建产物：统一落在 out/<lang>/（见 scripts/build.mjs）
    ?? findFile(['vendor', 'tree-sitter-wasm', 'out', lang, fileName])
    ?? findFile(['vendor', 'tree-sitter-wasm', lang, fileName])
  );
}

// ============================================================================
// 解析器池
// ============================================================================

let initPromise: Promise<boolean> | null = null;
const langCache = new Map<string, Language>();
const parserCache = new Map<string, Parser>();
const loadFailures = new Set<string>();

/** 全局初始化（幂等；失败返回 false，图谱引擎按不可用降级） */
function ensureInit(): Promise<boolean> {
  if (!initPromise) {
    const core = getCoreWasmPath();
    if (!core) {
      initPromise = Promise.resolve(false);
      return initPromise;
    }
    initPromise = Parser.init({ locateFile: () => core })
      .then(() => true)
      .catch(() => false);
  }
  return initPromise;
}

/**
 * 取语言的 Parser（懒加载 wasm，LRU 简化为 Map + 上限淘汰）。
 * 语言不可用（wasm 缺失/加载失败）返回 null（调用方静默跳过该文件）。
 */
export async function getParser(lang: string): Promise<Parser | null> {
  if (!(await ensureInit())) return null;
  if (loadFailures.has(lang)) return null;
  const cached = parserCache.get(lang);
  if (cached) return cached;

  const wasmPath = getLangWasmPath(lang);
  if (!wasmPath) {
    loadFailures.add(lang);
    return null;
  }
  try {
    let language = langCache.get(lang);
    if (!language) {
      language = await Language.load(wasmPath);
      langCache.set(lang, language);
    }
    const parser = new Parser();
    parser.setLanguage(language);
    parserCache.set(lang, parser);
    // 简单上限淘汰（8 语言）
    if (parserCache.size > 8) {
      const oldest = parserCache.keys().next().value;
      if (oldest !== undefined) parserCache.delete(oldest);
    }
    return parser;
  } catch {
    loadFailures.add(lang);
    return null;
  }
}

/** AST 节点（tree-sitter Node 的结构子集） */
export interface ParseNode {
  type: string;
  childCount: number;
  namedChildCount: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  readonly text: string;
  child: (i: number) => ParseNode | null;
  childForFieldName: (name: string) => ParseNode | null;
  namedChild: (i: number) => ParseNode | null;
  parent: ParseNode | null;
  descendantsOfType: (types: string[], start?: unknown, end?: unknown) => ParseNode[];
}

/** 解析源码；语言不可用/解析失败返回 null */
export async function parseSource(lang: string, source: string): Promise<ParseNode | null> {
  const parser = await getParser(lang);
  if (!parser) return null;
  try {
    const tree = parser.parse(source);
    if (!tree) return null;
    return tree.rootNode as unknown as ParseNode;
  } catch {
    return null;
  }
}
