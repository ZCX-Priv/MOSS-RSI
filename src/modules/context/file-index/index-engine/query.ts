// src/modules/context/file-index/index-engine/query.ts
// 内存 glob 匹配：对索引引擎的内存文件列表直接匹配（毫秒级查询），
// 语义与 tools/glob 的 walkFiles 遍历路径完全一致（正/负模式、type 过滤、目录豁免）。

import { Glob } from 'bun';
import type { FileEntry } from '../types';

export interface FileQuery {
  positiveGlobs: readonly Glob[];
  negativeGlobs: readonly Glob[];
  typeGlobs: readonly Glob[] | null;
  includeDirs: boolean;
  sortBy: 'mtime' | 'path';
  offset: number;
  maxResults: number;
}

export interface FileQueryResult {
  /** 命中条目（已排序分页） */
  page: FileEntry[];
  /** 总命中数 */
  total: number;
  /** 是否因分页截断 */
  truncated: boolean;
}

/** 内存列表匹配（entries 值迭代） */
export function queryEntries(entries: Iterable<FileEntry>, q: FileQuery): FileQueryResult {
  const matched: FileEntry[] = [];
  for (const e of entries) {
    if (!q.positiveGlobs.some(g => g.match(e.rel))) continue;
    if (q.negativeGlobs.length > 0 && q.negativeGlobs.some(g => g.match(e.rel))) continue;
    if (q.typeGlobs && !e.isDir && !q.typeGlobs.some(g => g.match(e.rel))) continue;
    if (e.isDir && !q.includeDirs) continue;
    matched.push(e);
  }

  if (q.sortBy === 'mtime') {
    matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } else {
    matched.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  const total = matched.length;
  const truncated = total > q.offset + q.maxResults;
  return {
    page: matched.slice(q.offset, q.offset + q.maxResults),
    total,
    truncated,
  };
}

/**
 * 文本文件枚举（grep 加速用）：kind='text' 或 'unknown'（懒判定，
 * 读取侧二进制检测兜底），排除目录。
 */
export function* listTextFiles(entries: Iterable<FileEntry>): Generator<FileEntry> {
  for (const e of entries) {
    if (e.isDir) continue;
    if (e.kind === 'binary') continue;
    yield e;
  }
}
