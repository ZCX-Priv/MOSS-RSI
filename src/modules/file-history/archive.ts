// src/modules/file-history/archive.ts
// 目录树 tar.gz 归档与解包：供 delete 工具目录备份与 undo 恢复使用。
// 基于 node-tar（纯 JS 实现，跨平台稳定，无原生编译依赖）。

import { mkdirSync, existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
// 注意：tar 必须动态 import —— 静态 import 会把 node polyfill（约 944KB）拉进启动闭包。

export interface ArchiveResult {
  /** 归档文件路径（~/.moss/file-history/backups/<entryId>.tar.gz） */
  archivePath: string;
  /** 归档文件大小（字节） */
  bytes: number;
}

/**
 * 将目录树打包为 tar.gz 归档。
 * 归档内保留顶层目录名（basename），解包时会重建该目录。
 *
 * @param absPath 要归档的目录绝对路径
 * @param archivePath 归档输出路径（.tar.gz）
 */
export async function archiveDirectory(
  absPath: string,
  archivePath: string,
): Promise<ArchiveResult> {
  // 确保目标目录存在
  mkdirSync(dirname(archivePath), { recursive: true });

  const parent = dirname(absPath);
  const name = basename(absPath);
  const tar = await import('tar');

  await tar.create(
    {
      gzip: true,
      file: archivePath,
      cwd: parent,
    },
    [name],
  );

  const bytes = statSync(archivePath).size;
  return { archivePath, bytes };
}

/**
 * 从 tar.gz 归档解包到目标目录。
 * 解包会在 destDir 下重建归档时的顶层目录。
 *
 * @param archivePath 归档文件路径（.tar.gz）
 * @param destDir 解包目标目录（通常为原目录的父目录）
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<void> {
  if (!existsSync(archivePath)) {
    throw new Error(`archive not found: ${archivePath}`);
  }
  mkdirSync(destDir, { recursive: true });
  const tar = await import('tar');
  await tar.extract({
    file: archivePath,
    cwd: destDir,
  });
}
