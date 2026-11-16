// write/handlers/text.ts
// 文本写入 handler：filesys.writeFile（≤1MB 统一路径）或流式原子写入（>1MB 大文件）+ diff + 哈希。
// 只关心「如何写文本」，不关心 read-before-overwrite / 统一 track 备份 / 权限确认（调度层负责）。
// 返回纯数据，由调度层组装 ToolResult 和调用 fileHistory 服务。
// filesys 统一化：两路径写入均更新 filesys 缓存并发出变更事件（大文件经 recordExternalWrite 登记）。

import { dirname } from 'node:path';
import { computeLineDiff } from '../../../file-history/diff';
import { ensureDirectory, explainFsWriteError } from '../../../../utils/fs';
import { atomicWriteFileStream } from '../shared/streaming';
import { readOldContentForDiff } from '../shared/diff-guard';
import type { FilesysService } from '../../../contracts';

/** 小文件/大文件分界（与 diff-guard 的跳过阈值一致） */
const STREAMING_THRESHOLD_BYTES = 1024 * 1024;

/** text handler 需要的参数 */
export interface WriteTextParams {
  /** 文件绝对路径（已解析，roots 内） */
  absPath: string;
  /** 写入内容 */
  content: string;
  /** 文件是否已存在（决定 create/overwrite 语义） */
  fileExists: boolean;
  /** 是否自动创建父目录 */
  createDirs: boolean;
  /** filesys 服务（统一写入/缓存/事件） */
  filesys: FilesysService;
  /** 事件溯源 */
  sessionId: string;
  toolCallId: string;
}

/** text handler 返回的纯数据结果 */
export interface WriteTextResult {
  /** 写入字节数 */
  bytes: number;
  /** 磁盘真实字节 sha256（含被保留的 BOM） */
  hash: string;
  /** unified diff 文本；null=未计算（新建/跳过），''=内容相同，非空=diff 或占位 */
  diff: string | null;
  /** 操作类型 */
  operation: 'create' | 'overwrite';
}

/**
 * 执行文本写入：≤1MB 走 filesys.writeFile（BOM/缓存/事件一站式）；
 * >1MB 走流式原子写入（防大内容一次性 Buffer 化），完成后 recordExternalWrite 登记缓存+事件。
 *
 * @throws 父目录创建失败或写入失败时抛出 Error，由调度层捕获
 */
export async function writeText(params: WriteTextParams): Promise<WriteTextResult> {
  const { absPath, content, fileExists, createDirs, filesys, sessionId, toolCallId } = params;

  // 1. 创建父目录（若需要；writeFile 的 createDirs 也可处理，streaming 路径需要）
  if (createDirs) {
    ensureDirectory(dirname(absPath));
  }

  // 2. 计算字节大小（diff 守卫 + 路径分界）
  const contentBytes = Buffer.byteLength(content, 'utf8');

  // 3. 读取 oldContent（大文件跳过时不读，防爆内存核心点）
  const oldContent = readOldContentForDiff(absPath, fileExists, contentBytes);

  // 4. 写入
  let bytes: number;
  let hash: string;
  if (contentBytes <= STREAMING_THRESHOLD_BYTES) {
    // 统一路径：BOM 保留 + 原子写 + 缓存更新 + 变更事件
    const r = filesys.writeFile(absPath, content, {
      source: 'write',
      sessionId,
      toolCallId,
      fsync: true,
      preserveBom: true,
      createDirs: false,
    });
    if (!r.ok) {
      throw new Error(r.message);
    }
    bytes = r.bytes;
    hash = r.sha256;
  } else {
    // 大文件：流式原子写入 + 流式 sha256，随后登记缓存派生值 + 事件
    let streamed: Awaited<ReturnType<typeof atomicWriteFileStream>>;
    try {
      streamed = await atomicWriteFileStream(absPath, content, {
        fsync: true,
        preserveBom: true,
        preserveMode: true,
      });
    } catch (err) {
      // 盘符根 ACL 拒绝等系统错误 → 可行动提示（与 filesys.writeFile 同口径）
      throw new Error(explainFsWriteError(err, absPath));
    }
    bytes = streamed.bytes;
    hash = streamed.hash;
    filesys.recordExternalWrite(absPath, { sha256: hash, bytes }, {
      source: 'write',
      sessionId,
      toolCallId,
      existed: fileExists,
    });
  }

  // 5. 计算 diff（oldContent 为 null 时跳过；内容相同时 computeLineDiff 返回空字符串）
  let diff: string | null = null;
  if (oldContent !== null && oldContent !== content) {
    diff = computeLineDiff(oldContent, content);
  }

  return {
    bytes,
    hash,
    diff,
    operation: fileExists ? 'overwrite' : 'create',
  };
}
