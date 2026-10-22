// src/utils/fs-atomic.ts
// 原子写入实现：tmp + fsync + rename，杜绝中断损坏。
// 零依赖纯函数层（仅依赖 node:fs/node:path 与 utils/encoding），core 与 modules 均可安全引用。
// 设计：
//   1. realpath 解析 symlink（防止 rename 替换 symlink 本身）
//   2. 同目录创建 tmp 文件（保证 rename 同文件系统）
//   3. fsync 刷盘（持久化保证，可选）
//   4. 保留原文件权限（POSIX stat → chmod）
//   5. 保留原文件 BOM（若原文件有 BOM 且新内容无 BOM，前置 \uFEFF）
//   6. rename 原子替换
//   7. EXDEV 回退（Windows 跨盘）：直接 writeFileSync + 清理 tmp

import {
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  statSync,
  realpathSync,
  chmodSync,
  openSync,
  readSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import {
  writeFile as writeFileAsync,
  rename as renameAsync,
  unlink as unlinkAsync,
} from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { hasUtf8Bom } from './encoding';

export interface AtomicWriteOptions {
  /** 是否 fsync 刷盘（默认 true，持久化保证） */
  fsync?: boolean;
  /** 是否保留原文件权限（POSIX，默认 true） */
  preserveMode?: boolean;
  /** 是否保留原文件 BOM（默认 true） */
  preserveBom?: boolean;
  /** 新建文件时的权限模式（默认 0o644） */
  mode?: number;
}

/**
 * 原子写入文件：tmp + fsync + rename。
 * 保证写入过程中断不会损坏原文件（原文件要么是旧内容，要么是新内容，不会是部分内容）。
 *
 * @param filePath 目标文件路径（可能为 symlink）
 * @param data 要写入的内容（string 或 Buffer）
 * @param options 选项
 */
export function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const {
    fsync = true,
    preserveMode = true,
    preserveBom = true,
    mode = 0o644,
  } = options;

  // 1. 解析 symlink：写入真实目标，避免 rename 替换 symlink 本身
  const realPath = resolveRealPath(filePath);

  // 2. 构造 tmp 文件路径（同目录，保证 rename 同文件系统）
  const tmpPath = buildTmpPath(realPath);

  // 3. 准备写入内容（BOM 保留逻辑）
  let contentToWrite: string | Buffer = data;
  if (preserveBom && typeof data === 'string') {
    const hadBom = existsSync(realPath) && (() => {
      try {
        return hasUtf8Bom(readHeadBytes(realPath, 3));
      } catch {
        return false;
      }
    })();
    const dataHasBom = data.charCodeAt(0) === 0xfeff;
    if (hadBom && !dataHasBom) {
      // 原文件有 BOM，新内容无 BOM → 前置 BOM
      contentToWrite = '\uFEFF' + data;
    }
  }

  // 4. 保留原文件权限
  const originalMode = preserveMode ? getOriginalMode(realPath) : null;

  try {
    // 5. 写入 tmp 文件
    writeFileSync(tmpPath, contentToWrite, { mode: originalMode ?? mode });

    // 6. fsync 刷盘（持久化保证）
    if (fsync) {
      let fd: number | null = null;
      try {
        fd = openSync(tmpPath, 'r');
        fsyncSync(fd);
      } catch {
        // fsync 失败不致命（某些文件系统不支持），继续
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* 静默 */ }
        }
      }
    }

    // 7. 保留原文件权限（writeFileSync mode 参数在某些平台不可靠，显式 chmod）
    if (originalMode !== null) {
      try { chmodSync(tmpPath, originalMode); } catch { /* 忽略 */ }
    }

    // 8. 原子 rename
    try {
      renameSync(tmpPath, realPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        // Windows 跨盘：回退直接写（牺牲原子性但保证可用）
        writeFileSync(realPath, contentToWrite, { mode: originalMode ?? mode });
        try { unlinkSync(tmpPath); } catch { /* 静默 */ }
      } else {
        throw err;
      }
    }
  } catch (err) {
    // 任何异常：清理 tmp 文件（best-effort），原文件保持不变
    try { unlinkSync(tmpPath); } catch { /* 静默 */ }
    throw err;
  }
}

/**
 * 原子写入（异步版）：tmp + rename，不阻塞事件循环。
 * 用于高频/大体积的运行时数据（如终端历史 JSON）；不保留 BOM/权限（调用方均为内部数据文件）。
 */
export async function atomicWriteFileAsync(
  filePath: string,
  data: string | Buffer,
): Promise<void> {
  const realPath = resolveRealPath(filePath);
  const tmpPath = buildTmpPath(realPath);
  try {
    await writeFileAsync(tmpPath, data);
    try {
      await renameAsync(tmpPath, realPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        // Windows 跨盘：回退直接写（牺牲原子性但保证可用）
        await writeFileAsync(realPath, data);
        try { await unlinkAsync(tmpPath); } catch { /* 静默 */ }
      } else {
        throw err;
      }
    }
  } catch (err) {
    try { await unlinkAsync(tmpPath); } catch { /* 静默 */ }
    throw err;
  }
}

// ============================================================================
// 导出辅助函数：供 atomicWriteFile 内部及流式写入实现复用
// ============================================================================

/**
 * 解析真实路径（处理 symlink）。
 * 文件不存在时（新建场景，realpathSync 抛 ENOENT）回退到原路径。
 */
export function resolveRealPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * 构造 tmp 文件路径（同目录，保证 rename 同文件系统）。
 * 前缀 . 隐藏，后缀 .tmp.<pid>.<random> 避免并发冲突。
 */
export function buildTmpPath(realPath: string): string {
  const dir = dirname(realPath);
  const base = basename(realPath);
  return join(dir, `.${base}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`);
}

/**
 * 获取原文件权限（POSIX mode 低 9 位）。
 * 文件不存在或 stat 失败时返回 null。
 */
export function getOriginalMode(realPath: string): number | null {
  if (!existsSync(realPath)) return null;
  try {
    return statSync(realPath).mode & 0o777;
  } catch {
    return null;
  }
}

/** 读取文件头部 N 字节（用于 BOM 检测/内容分类，避免全量读取大文件） */
export function readHeadBytes(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const bytesRead = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}
