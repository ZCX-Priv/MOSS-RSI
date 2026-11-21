// write/shared/streaming.ts
// 流式原子写入 + 流式 sha256：createWriteStream 分块写入 tmp，支持超大文件，避免一次性缓冲。
// 复用 utils/fs-atomic 的原子性辅助（resolveRealPath/buildTmpPath/getOriginalMode/readHeadBytes）。
// 路径：write/shared/streaming.ts → utils = ../../../../../utils

import {
  createWriteStream,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
  chmodSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import {
  resolveRealPath,
  buildTmpPath,
  getOriginalMode,
  readHeadBytes,
  type AtomicWriteOptions,
} from '../../../../utils/fs-atomic';
import { hasUtf8Bom } from '../../../../utils/encoding';

/** 流式分块大小（64KB，对齐 Node createWriteStream 默认 highWaterMark） */
export const STREAM_CHUNK_SIZE = 64 * 1024;

export interface StreamWriteResult {
  /** 写入字节数（UTF-8 编码后字节长度） */
  bytes: number;
  /** 流式 sha256 哈希（写入过程中分块 update 计算，避免事后重复扫描） */
  hash: string;
}

/**
 * 流式原子写入：createWriteStream 分块写入 tmp + fsync + rename。
 *
 * 与 atomicWriteFile 的区别：
 * - 写入 tmp 时用 createWriteStream 分块写入（而非 writeFileSync 一次性），支持超大文件
 * - 写入过程中分块 update sha256，避免事后重复扫描
 * - 原子性策略（tmp+fsync+rename+EXDEV 回退+BOM 保留+权限保留）与 atomicWriteFile 一致
 *
 * @param filePath 目标文件路径（可能为 symlink）
 * @param content 写入内容（string）
 * @param options 选项（fsync/preserveMode/preserveBom/mode）
 * @returns 写入字节数 + sha256 哈希
 */
export async function atomicWriteFileStream(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<StreamWriteResult> {
  const {
    fsync = true,
    preserveMode = true,
    preserveBom = true,
    mode = 0o644,
  } = options;

  // 1. 解析 symlink + 构造 tmp 路径
  const realPath = resolveRealPath(filePath);
  const tmpPath = buildTmpPath(realPath);

  // 2. BOM 保留逻辑（与 atomicWriteFile 一致）
  let contentToWrite = content;
  if (preserveBom) {
    const hadBom = (() => {
      try {
        return hasUtf8Bom(readHeadBytes(realPath, 3));
      } catch {
        return false;
      }
    })();
    const dataHasBom = content.charCodeAt(0) === 0xfeff;
    if (hadBom && !dataHasBom) {
      // 原文件有 BOM，新内容无 BOM → 前置 BOM
      contentToWrite = '\uFEFF' + content;
    }
  }

  // 3. 保留原文件权限
  const originalMode = preserveMode ? getOriginalMode(realPath) : null;

  // 4. 转 Buffer（一次性转换，V8 string 已在内存，不放大内存）
  const buf = Buffer.from(contentToWrite, 'utf8');
  const hash = createHash('sha256');

  try {
    // 5. 流式分块写入 tmp + 同步计算 sha256
    const stream = createWriteStream(tmpPath, { mode: originalMode ?? mode });
    await writeBufferStream(stream, buf, hash);

    // 6. fsync 刷盘（持久化保证）
    if (fsync) {
      await fsyncFile(tmpPath);
    }

    // 7. 保留原文件权限（createWriteStream mode 参数在某些平台不可靠，显式 chmod）
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
        writeFileSync(realPath, buf, { mode: originalMode ?? mode });
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

  return { bytes: buf.length, hash: hash.digest('hex') };
}

/**
 * 将 Buffer 分块写入流，同时分块 update 哈希。
 * 当 stream.write 返回 false（缓冲满）时等待 drain 事件。
 */
async function writeBufferStream(
  stream: WriteStream,
  buf: Buffer,
  hash: Hash,
): Promise<void> {
  for (let i = 0; i < buf.length; i += STREAM_CHUNK_SIZE) {
    const end = Math.min(i + STREAM_CHUNK_SIZE, buf.length);
    const chunk = buf.subarray(i, end);
    hash.update(chunk);
    await writeChunk(stream, chunk);
  }
  // 所有 chunk 写入完成，end 并等待 finish
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    const onFinish = () => {
      stream.removeListener('error', onError);
      resolve();
    };
    stream.once('error', onError);
    stream.once('finish', onFinish);
    stream.end();
  });
}

/** 写入单个 chunk，缓冲满时等待 drain */
function writeChunk(stream: WriteStream, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) {
    // 缓冲未满，立即继续
    return Promise.resolve();
  }
  // 缓冲满，等待 drain
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      stream.removeListener('drain', onDrain);
      reject(err);
    };
    const onDrain = () => {
      stream.removeListener('error', onError);
      resolve();
    };
    stream.once('error', onError);
    stream.once('drain', onDrain);
  });
}

/** fsync 刷盘（持久化保证） */
async function fsyncFile(path: string): Promise<void> {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // fsync 失败不致命（某些文件系统不支持），继续
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* 静默 */ }
    }
  }
}
