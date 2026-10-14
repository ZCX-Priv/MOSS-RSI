// src/modules/context/file-index/shared/store.ts
// 索引数据目录管理：<项目>/.moss/file-index/{index-list,graph,sag}
// 落盘于项目文件夹内的 .moss（与记忆的 <项目>/.moss/memory 同源）；meta.json 记录原始 cwd 供排查。
// 系统作用域（__system__）无单一项目根 → 由 service 层跳过，不在此建库。

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

/** 系统作用域标记（本机全盘模式；无单一项目根，索引跳过） */
export const SYSTEM_SCOPE = '__system__';

export interface ProjectIndexDirs {
  /** 项目索引根目录 */
  root: string;
  indexList: string;
  graph: string;
  sag: string;
}

/** cwd → 稳定哈希（16 位十六进制；仅用于 meta.json 诊断记录） */
export function projectHash(cwd: string): string {
  const norm = normalize(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/**
 * 解析（并按需创建）项目索引目录结构，落盘于 <项目>/.moss/file-index。
 * 首次创建时写 meta.json（记录原始 cwd，供人工排查）。
 */
export function ensureProjectDirs(cwd: string): ProjectIndexDirs {
  const root = join(cwd, '.moss', 'file-index');
  const dirs: ProjectIndexDirs = {
    root,
    indexList: join(root, 'index-list'),
    graph: join(root, 'graph'),
    sag: join(root, 'sag'),
  };
  const metaFile = join(root, 'meta.json');
  if (!existsSync(metaFile)) {
    mkdirSync(dirs.indexList, { recursive: true });
    mkdirSync(dirs.graph, { recursive: true });
    mkdirSync(dirs.sag, { recursive: true });
    try {
      writeFileSync(
        metaFile,
        JSON.stringify({ cwd: normalize(cwd), createdAt: new Date().toISOString(), hash: projectHash(cwd) }, null, 2),
        'utf8',
      );
    } catch {
      // meta 写失败不阻断（只读目录等极端场景仍可纯内存运行）
    }
  }
  return dirs;
}

/** 目录大小（字节，递归；出错返回 0） */
export function dirSize(path: string): number {
  let total = 0;
  try {
    for (const entry of walkEntries(path)) {
      try {
        const s = statSync(entry);
        if (s.isFile()) total += s.size;
      } catch {
        // 单条目失败忽略
      }
    }
  } catch {
    return 0;
  }
  return total;
}

function* walkEntries(path: string): Generator<string> {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(path, e.name);
    if (e.isDirectory()) yield* walkEntries(full);
    else yield full;
  }
}

/** 删除项目索引数据（关闭引擎不删；仅手动重建/清理用） */
export function removeProjectIndex(cwd: string): void {
  const root = join(cwd, '.moss', 'file-index');
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 忽略删除失败
  }
}
