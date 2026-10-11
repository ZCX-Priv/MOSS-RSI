// src/modules/file-history/trash.ts
// 应用内回收站（~/.moss/file-history/trash）：delete 工具在系统回收站不可用时的回退目标。
// 移动文件/目录到应用内回收站、清理过期 trash 项（超期自动清理，默认 7 天）。
// 撤回/undo 恢复不走本模块（从 file-history 备份恢复到原路径），此处仅负责"删得进、存得住、到期清"。

import {
  existsSync,
  mkdirSync,
  renameSync,
  cpSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';

/** trash 项保留天数（超期自动清理） */
export const TRASH_RETENTION_DAYS = 7;

/** trash 项元数据（sidecar .meta.json） */
interface TrashMeta {
  /** 原始绝对路径 */
  originalPath: string;
  /** 移入回收站的 ISO 8601 时间戳 */
  trashedAt: string;
}

export interface TrashEntry {
  /** 回收站内路径 */
  trashPath: string;
  /** 原始路径 */
  originalPath: string;
  /** 移入回收站的时间 */
  trashedAt: Date;
}

/** 生成时间戳后缀防冲突 */
function timestampSuffix(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** sidecar 元数据文件路径 */
function metaPathFor(trashPath: string): string {
  return `${trashPath}.meta.json`;
}

/** 写 sidecar 元数据 */
function writeMeta(trashPath: string, originalPath: string, trashedAt: Date): void {
  const meta: TrashMeta = {
    originalPath,
    trashedAt: trashedAt.toISOString(),
  };
  writeFileSync(metaPathFor(trashPath), JSON.stringify(meta, null, 2), 'utf-8');
}

/** 读 sidecar 元数据；不存在返回 null */
function readMeta(trashPath: string): TrashMeta | null {
  const p = metaPathFor(trashPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as TrashMeta;
  } catch {
    return null;
  }
}

/**
 * 移动文件/目录：同盘走 rename（零拷贝）；跨盘（EXDEV）回退为复制+删源。
 * Windows 跨盘符 / Unix 跨挂载点 rename 均不允许，必须回退。
 */
function moveEntry(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    // 跨盘回退：完整复制到目标，成功后再删源
    try {
      cpSync(src, dest, { recursive: true, force: true });
    } catch (copyErr) {
      // 复制失败（如中途磁盘满）：清理不完整副本后抛出原始错误
      try { rmSync(dest, { recursive: true, force: true }); } catch { /* 静默 */ }
      throw copyErr;
    }
    rmSync(src, { recursive: true, force: true });
  }
}

/**
 * 移动文件/目录到回收站，返回 trash 路径与元数据。
 * 同名冲突时追加时间戳后缀，仍冲突则继续追加序号。
 *
 * @param absPath 要移入回收站的文件/目录绝对路径
 * @param trashDir 回收站目录（~/.moss/file-history/trash）
 */
export function moveToTrash(absPath: string, trashDir: string): TrashEntry {
  mkdirSync(trashDir, { recursive: true });

  const base = basename(absPath);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;

  let trashName = base;
  let trashPath = join(trashDir, trashName);

  if (existsSync(trashPath)) {
    // 同名冲突：追加时间戳后缀
    trashName = `${stem}_${timestampSuffix()}${ext}`;
    trashPath = join(trashDir, trashName);
    // 仍冲突则追加序号
    let i = 1;
    while (existsSync(trashPath)) {
      trashName = `${stem}_${timestampSuffix()}_${i}${ext}`;
      trashPath = join(trashDir, trashName);
      i++;
    }
  }

  moveEntry(absPath, trashPath);
  const trashedAt = new Date();
  writeMeta(trashPath, absPath, trashedAt);

  return { trashPath, originalPath: absPath, trashedAt };
}

/**
 * 清理过期 trash 项（超 retentionDays 删除）。
 * 按 sidecar 中 trashedAt 判断；无 sidecar 则按文件 mtime。
 *
 * @param trashDir 回收站目录
 * @param retentionDays 保留天数，默认 7
 * @returns 已清理项数
 */
export function cleanupExpiredTrash(
  trashDir: string,
  retentionDays: number = TRASH_RETENTION_DAYS,
): number {
  if (!existsSync(trashDir)) return 0;

  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(trashDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    // 跳过 sidecar 元数据文件（随主项一起清理）
    if (entry.endsWith('.meta.json')) continue;

    const entryPath = join(trashDir, entry);
    const meta = readMeta(entryPath);
    let trashedAtMs: number;

    try {
      if (meta) {
        trashedAtMs = new Date(meta.trashedAt).getTime();
      } else {
        // 无元数据则按文件 mtime 判断
        trashedAtMs = statSync(entryPath).mtimeMs;
      }
      if (now - trashedAtMs > maxAgeMs) {
        rmSync(entryPath, { recursive: true, force: true });
        const metaPath = metaPathFor(entryPath);
        if (existsSync(metaPath)) {
          unlinkSync(metaPath);
        }
        removed++;
      }
    } catch {
      // 单项失败跳过，不影响其他项清理
    }
  }

  return removed;
}
