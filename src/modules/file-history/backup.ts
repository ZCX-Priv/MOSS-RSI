// src/modules/file-history/backup.ts
// 内容寻址备份：sha256(content) 命名，同内容只存一份。
// 内容哈希天然去重，节省磁盘空间。

import { existsSync, readFileSync, copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface BackupResult {
  /** 内容 sha256（新文件为空字符串） */
  hash: string;
  /** 备份文件路径（新文件为 null） */
  backupPath: string | null;
  /** 是否实际创建了新备份（文件不存在或已存在相同内容备份则为 false） */
  created: boolean;
  /** 原文件大小（字节，新文件为 0） */
  bytes: number;
}

/**
 * 按内容哈希备份文件。
 * - 文件不存在 → 返回 hash='', backupPath=null, created=false（新文件无需备份）
 * - 文件存在 → 计算 sha256，若 backups/<hash>.bak 已存在则跳过（去重），否则 copyFileSync
 *
 * @param absPath 要备份的文件绝对路径
 * @param backupDir 备份目录（~/.moss/file-history/backups/）
 */
export function backupByHash(absPath: string, backupDir: string): BackupResult {
  // 1. 文件不存在：新文件，无需备份
  if (!existsSync(absPath)) {
    return { hash: '', backupPath: null, created: false, bytes: 0 };
  }

  // 2. 读取文件内容
  let buf: Buffer;
  let stat;
  try {
    stat = statSync(absPath);
    buf = readFileSync(absPath);
  } catch (err) {
    throw new Error(`backup: failed to read ${absPath}: ${err instanceof Error ? err.message : err}`);
  }

  // 3. 计算 sha256
  const hash = createHash('sha256').update(buf).digest('hex');
  const bytes = stat.size;

  // 4. 构造备份路径
  const backupPath = join(backupDir, `${hash}.bak`);

  // 5. 已存在则跳过（同内容只备份一次）
  if (existsSync(backupPath)) {
    return { hash, backupPath, created: false, bytes };
  }

  // 6. 创建备份目录（若不存在）
  try {
    mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    throw new Error(`backup: failed to mkdir ${backupDir}: ${err instanceof Error ? err.message : err}`);
  }

  // 7. 复制文件到备份路径
  try {
    copyFileSync(absPath, backupPath);
  } catch (err) {
    throw new Error(`backup: failed to copy ${absPath} → ${backupPath}: ${err instanceof Error ? err.message : err}`);
  }

  return { hash, backupPath, created: true, bytes };
}

/**
 * 从备份路径恢复文件。
 * 调用方需自行用 atomicWriteFile 写回原路径。
 *
 * @param backupPath 备份文件路径
 * @returns 备份文件内容 Buffer（不存在则抛错）
 */
export function readBackup(backupPath: string): Buffer {
  if (!existsSync(backupPath)) {
    throw new Error(`backup not found: ${backupPath}`);
  }
  return readFileSync(backupPath);
}

/**
 * 按内容哈希备份内存 Buffer（终端快照检测：磁盘已被终端命令改写，
 * "执行前内容"只存在于 filesys 读缓存中，无法用 backupByHash 读盘备份）。
 * 同内容与 backupByHash 共享 <hash>.bak 命名空间（天然去重）。
 */
export function backupBufferByHash(buf: Buffer, backupDir: string): BackupResult {
  const hash = createHash('sha256').update(buf).digest('hex');
  const bytes = buf.length;
  const backupPath = join(backupDir, `${hash}.bak`);
  if (existsSync(backupPath)) {
    return { hash, backupPath, created: false, bytes };
  }
  try {
    mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    throw new Error(`backup: failed to mkdir ${backupDir}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    writeFileSync(backupPath, buf);
  } catch (err) {
    throw new Error(`backup: failed to write ${backupPath}: ${err instanceof Error ? err.message : err}`);
  }
  return { hash, backupPath, created: true, bytes };
}
