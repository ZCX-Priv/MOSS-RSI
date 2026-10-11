// src/modules/context/file-index/shared/scanner.ts
// 增量扫描：复用 search-core 的 walkFiles（自带 .gitignore 剪枝 + 隐藏文件跳过）
// 遍历项目，产出与已知快照（pathKey → size/mtimeMs）的差异批次。
// "一次全量扫描 + 增量校正"的扫描侧实现。

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { walkFiles } from '../../../tools/shared/search-core';
import { shouldIgnorePath, type IgnoreGlobs } from './ignore';
import type { FileChangeBatch, FileEntry } from '../types';

/** pathKey：小写正斜杠相对路径（Windows 大小写不敏感） */
export function pathKey(rel: string): string {
  return rel.toLowerCase();
}

/** 常见文本扩展名（启发式分类；unknown 交由查询侧懒判定） */
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb', '.php', '.lua',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.cs', '.swift',
  '.md', '.markdown', '.txt', '.rst', '.adoc',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xml', '.svg',
  '.vue', '.svelte', '.astro', '.graphql', '.gql', '.sql', '.sh', '.bash', '.zsh',
  '.bat', '.cmd', '.ps1', '.env', '.gitignore', '.editorconfig', '.lock',
]);

/** 常见二进制扩展名 */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff',
  '.mp3', '.mp4', '.wav', '.flac', '.ogg', '.webm', '.avi', '.mkv', '.mov',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.zst',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
  '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.db', '.sqlite', '.sqlite3', '.jar', '.class', '.pyc', '.pyo',
]);

/** 扩展名 → kind 启发式分类 */
export function classifyByExt(ext: string): 'text' | 'binary' | 'unknown' {
  if (ext === '') return 'unknown';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'unknown';
}

/** 文件名 → 小写扩展名（含点；无扩展名为 ''） */
export function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx).toLowerCase();
}

export interface KnownSnapshot {
  /** pathKey → { size, mtimeMs } */
  entries: Map<string, { size: number; mtimeMs: number }>;
}

export interface ScanOptions {
  signal?: AbortSignal;
  customIgnore: IgnoreGlobs | null;
  /** 进度回调（已扫描条目数） */
  onProgress?: (count: number) => void;
}

/**
 * 全量遍历并与已知快照 diff。
 * - known 为空 Map → 全部 added（首次全量扫描）
 * - 已知但消失 → removed
 * - size/mtimeMs 变化 → modified
 */
export async function scanIncremental(
  root: string,
  known: KnownSnapshot | null,
  opts: ScanOptions,
): Promise<FileChangeBatch> {
  const added: FileEntry[] = [];
  const modified: FileEntry[] = [];
  const scannedKeys = new Set<string>();
  const statTasks: Array<{ rel: string; abs: string; name: string; isDir: boolean }> = [];
  let count = 0;

  for await (const entry of walkFiles(root, {
    signal: opts.signal,
    dot: false,
    includeDirs: true,
    maxFiles: 200_000,
  })) {
    // 双重兜底过滤：walkFiles 的 gitignore/DEFAULT_IGNORES 之外，
    // 再按索引专属黑名单（target/.venv/.moss 等）+ 自定义 glob 过滤，保证与 watcher 口径一致
    if (shouldIgnorePath(entry.rel, opts.customIgnore)) continue;
    scannedKeys.add(pathKey(entry.rel));
    statTasks.push({ rel: entry.rel, abs: entry.abs, name: entry.name, isDir: entry.isDir });
    count++;
    if (count % 500 === 0) opts.onProgress?.(count);
  }
  opts.onProgress?.(count);

  // 并发批量 stat（限流 64）
  const CONCURRENCY = 64;
  const entries: FileEntry[] = [];
  for (let i = 0; i < statTasks.length; i += CONCURRENCY) {
    if (opts.signal?.aborted) break;
    const batch = statTasks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async t => {
        try {
          const s = await stat(t.abs);
          return {
            rel: t.rel,
            name: t.name,
            ext: t.isDir ? '' : extOf(t.name),
            size: s.size,
            mtimeMs: s.mtimeMs,
            isDir: t.isDir,
            kind: t.isDir ? ('unknown' as const) : classifyByExt(extOf(t.name)),
          } satisfies FileEntry;
        } catch {
          return null; // 竞态消失（扫描期间被删）
        }
      }),
    );
    for (const r of results) if (r) entries.push(r);
  }

  // diff
  for (const e of entries) {
    const key = pathKey(e.rel);
    const prev = known?.entries.get(key);
    if (!prev) {
      added.push(e);
    } else if (prev.size !== e.size || prev.mtimeMs !== e.mtimeMs) {
      modified.push(e);
    }
  }
  const removed: string[] = [];
  if (known) {
    for (const key of known.entries.keys()) {
      if (!scannedKeys.has(key)) removed.push(key);
    }
  }

  return { added, modified, removed };
}

/** 单条目快速 stat（watcher 事件用：新增/变更的单文件） */
export async function statEntry(root: string, rel: string): Promise<FileEntry | null> {
  try {
    const s = await stat(join(root, rel));
    const name = rel.split('/').pop() ?? rel;
    const isDir = s.isDirectory();
    const ext = isDir ? '' : extOf(name);
    return {
      rel,
      name,
      ext,
      size: s.size,
      mtimeMs: s.mtimeMs,
      isDir,
      kind: isDir ? 'unknown' : classifyByExt(ext),
    };
  } catch {
    return null;
  }
}
