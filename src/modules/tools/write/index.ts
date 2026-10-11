// tools/write/index.ts
// write 工具调度层：参数校验 → 路径安全 → read-before-overwrite → 统一 track 备份 → 分派到 handler → 组装结果。
// 元数据（name/description/icon/annotations/inputSchema/config）见同目录 tool.json。
// handlers/ 子目录执行实际写入（流式原子写入 + diff + 哈希），shared/ 子目录提供流式写入/diff守卫等公共能力。
//
// 强化点：
// 1. 流式原子写入（createWriteStream 分块 + tmp+fsync+rename，防中断损坏，支持大文件）
// 2. 改前哈希备份（同内容去重，支持 undo）
// 3. read-before-overwrite（覆盖已存在文件前强制校验本会话已 read）
// 4. 无大小限制（write 不需要，LLM 协议层已约束；read 的限制是为了防止 ai 吃不下，与 write 场景不同）
// 5. 大文件跳过 diff 且不读 oldContent（防爆内存，避免 O(n*m) 矩阵和 oldContent 全量读取）
// 6. BOM 保留 + 权限保留（流式写入层自动处理）
// 7. 返回 unified diff（供 LLM 审视改动；大文件跳过时返回写入摘要）

import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import { existsSync, statSync } from 'node:fs';
import { impactHintFor } from '../shared/file-index-hint';
import type { FileHistoryService, FilesysService } from '../../contracts';
import type { ChangeTracker } from '../../file-history/types';
import type { ToolContext, ToolResult } from '../types';
import { writeText, type WriteTextResult } from './handlers/text';

interface WriteParams {
  path: string;
  content: string;
  createDirs?: boolean;
}

function getFileHistory(ctx: ToolContext): FileHistoryService | null {
  return ctx.services.tryResolve<FileHistoryService>(ServiceNames.FILE_HISTORY);
}

function getFilesys(ctx: ToolContext): FilesysService | null {
  return ctx.services.tryResolve<FilesysService>(ServiceNames.FILESYS);
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as WriteParams;

    // 1. 基础参数校验
    if (!p.path) {
      return errorResult(t('tools.writePathRequired'));
    }
    if (typeof p.content !== 'string') {
      return errorResult(t('tools.writeContentString'));
    }

    // 2. 路径解析与越权检测（filesys roots 机制）
    const filesys = getFilesys(ctx);
    if (!filesys) {
      return errorResult(t('filesys.serviceUnavailable'));
    }
    const absPath = filesys.resolve(p.path, ctx.cwd);
    if (!absPath) {
      return errorResult(t('fs.pathOutsideRoots', {
        path: p.path,
        roots: filesys.listRoots().length > 0 ? ` + ${filesys.listRoots().join(', ')}` : '',
      }));
    }

    // 3. 路径类型预检查：若已存在且是目录则拒绝
    const fileExists = existsSync(absPath);
    if (fileExists) {
      try {
        if (statSync(absPath).isDirectory()) {
          return { content: [{ type: 'text', text: `Error: ${t('tools.pathIsDirectory', { path: absPath })}` }], isError: true };
        }
      } catch { /* stat 失败不阻断 */ }
    }

    // 4. 从 toolConfig 读取配置（无大小限制，write 不需要）
    const toolConfig = (ctx.toolConfig ?? {}) as {
      trackHistory?: boolean;
      requireReadBeforeOverwrite?: boolean;
    };
    const trackHistory = toolConfig.trackHistory ?? true;
    const requireReadBeforeOverwrite = toolConfig.requireReadBeforeOverwrite ?? true;

    // 5. read-before-overwrite 强制校验
    const fileHistory = getFileHistory(ctx);
    if (fileExists && requireReadBeforeOverwrite && fileHistory) {
      if (!fileHistory.isRead(ctx.sessionId, absPath)) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${t('tools.readBeforeOverwriteRequired', { path: absPath })}\n${t('tools.writeReadFirst')}`,
          }],
          isError: true,
        };
      }
    }

    // 6. 统一追踪：改前备份（同步阻塞，必须在写入前完成）
    const createDirs = p.createDirs ?? true;
    let tracker: ChangeTracker | null = null;
    if (trackHistory && fileHistory) {
      try {
        tracker = await fileHistory.track({
          sessionId: ctx.sessionId,
          absPath,
          toolCallId: ctx.toolCallId,
          toolName: 'write',
        });
      } catch (err) {
        ctx.logger.warn('write: track failed, undo will be unavailable', {
          path: absPath, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 7. 分派到 handler 执行写入（filesys.writeFile 或大文件流式）+ diff + 哈希
    let writeResult: WriteTextResult;
    try {
      writeResult = await writeText({
        absPath,
        content: p.content,
        fileExists,
        createDirs,
        filesys,
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(t('tools.writeError', { message: msg }));
    }

    // 8. 登记历史条目（写入 transcript）
    if (tracker) {
      try {
        tracker.commit({
          hashAfter: writeResult.hash,
          bytesAfter: writeResult.bytes,
          diff: writeResult.diff ?? undefined,
        });
      } catch (err) {
        ctx.logger.warn('write: commit failed', { path: absPath, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 9. 返回丰富结果
    ctx.logger.info(t('tools.fileWritten', { path: absPath }), { bytes: writeResult.bytes, operation: writeResult.operation });

    const summary = writeResult.operation === 'create'
      ? t('tools.writeCreated', { path: absPath, bytes: writeResult.bytes })
      : t('tools.writeOverwrote', { path: absPath, bytes: writeResult.bytes });
    const diffSection = writeResult.diff ? `\n\n--- unified diff ---\n${writeResult.diff}` : '';
    const backupNote = tracker?.receipt.backedUp ? t('tools.writeBackupNote', { path: tracker.receipt.backupPath ?? '' }) : '';
    // 影响面注入（图谱开启且就绪时；仅覆盖已有文件的场景有上游可言）
    const impactNote = writeResult.operation === 'overwrite'
      ? await impactHintFor(ctx, absPath).then(h => (h ? `\n${h}` : ''))
      : '';

    return {
      content: [{ type: 'text', text: summary + diffSection + backupNote + impactNote }],
      metadata: {
        path: absPath,
        bytes: writeResult.bytes,
        operation: writeResult.operation,
        createdDirs: createDirs,
        diff: writeResult.diff || undefined,
        hashBefore: tracker?.receipt.hash || null,
        hashAfter: writeResult.hash,
        entryId: tracker?.receipt.entryId || null,
        backedUp: tracker?.receipt.backedUp ?? false,
      },
    };
  },
};
