// tools/delete/index.ts
// delete 工具 execute 逻辑：删除文件或目录。
// 强化点：
//   1. trash 优先（默认送系统回收站，撤回可恢复原位；系统回收站不可用时回退应用内回收站）
//   2. 删除前统一备份（文件哈希备份 / 目录 tar.gz 归档），trash 与硬删除均支持 undo 恢复原位
//   3. 批量删除（paths 数组）+ 预演模式（dryRun）
//   4. 四重安全校验：路径越权、symlink 遍历、Windows 路径折叠、dev vault（.git）防护
//   5. read-before-delete（文件需本会话先 read 过，force=true 可跳过）
//   6. force 控制 rmSync force 参数，覆盖只读文件

import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import { existsSync, statSync, unlinkSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPathInside,
  realpathSafe,
  isRootPath,
  containsVcsMarker,
} from '../../../utils/fs';
import sendToTrash from 'trash';
import { moveToTrash } from '../../file-history/trash';
import type { FileHistoryService, FilesysService } from '../../contracts';
import type { ChangeTracker } from '../../file-history/types';
import type { ToolContext, ToolResult } from '../types';

/** 目录删除（trash/硬删除）最大字节数（超限拒绝，提示改用 terminal 工具） */
const MAX_DIR_BYTES = 100 * 1024 * 1024; // 100MB

interface DeleteParams {
  path?: string;
  paths?: string[];
  recursive?: boolean;
  trash?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

function getFileHistory(ctx: ToolContext): FileHistoryService | null {
  return ctx.services.tryResolve<FileHistoryService>(ServiceNames.FILE_HISTORY);
}

interface PathResult {
  absPath: string;
  success: boolean;
  message: string;
  trashed?: boolean;
  systemTrash?: boolean;
  fallbackTrash?: boolean;
  hardDeleted?: boolean;
  backedUp?: boolean;
  entryId?: string | null;
  bytes?: number;
  isDirectory?: boolean;
  dryRun?: boolean;
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as DeleteParams;

    // 1. 参数解析：path 与 paths 互斥，至少提供一个
    if (p.path && p.paths) {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.deletePathExclusive')}` }],
        isError: true,
      };
    }
    const inputPaths = p.paths ?? (p.path ? [p.path] : []);
    if (inputPaths.length === 0) {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.deletePathRequired')}` }],
        isError: true,
      };
    }

    const trash = p.trash ?? true; // 默认送回收站
    const force = p.force ?? false;
    const dryRun = p.dryRun ?? false;
    const recursive = p.recursive ?? false;

    // 硬删除需 force=true 配合（防止 LLM 误用 trash=false 无 force 的组合）
    // 但允许 trash=false + force=false 走安全校验的硬删除路径
    // 此处不强制要求 force，trash=false 即表示硬删除意图，force 控制是否跳过校验

    const toolConfig = (ctx.toolConfig ?? {}) as { trackHistory?: boolean };
    const trackHistory = toolConfig.trackHistory ?? true;
    const fileHistory = getFileHistory(ctx);
    const trashDir = fileHistory?.getTrashDir();

    const results: PathResult[] = [];
    const dryRunList: Array<{ path: string; type: 'file' | 'directory'; bytes: number; action: string }> = [];
    let totalBytes = 0;

    for (const rawPath of inputPaths) {
      const result = await deleteSingle(
        rawPath,
        ctx,
        { trash, force, dryRun, recursive, trackHistory },
        fileHistory,
        trashDir,
        dryRunList,
      );
      if (result.bytes) totalBytes += result.bytes;
      results.push(result);
    }

    // dryRun 模式：返回清单不执行
    if (dryRun) {
      const lines = dryRunList.map(
        (d) => t('tools.deleteDryRunLine', {
          path: d.path,
          type: t(d.type === 'directory' ? 'tools.deleteTypeDirectory' : 'tools.deleteTypeFile'),
          bytes: d.bytes,
          action: d.action,
        }),
      );
      return {
        content: [
          {
            type: 'text',
            text: `${t('tools.deleteDryRunSummary', { count: dryRunList.length, bytes: totalBytes })}\n${lines.join('\n')}`,
          },
        ],
        metadata: { dryRun: true, wouldDelete: dryRunList, totalBytes },
      };
    }

    // 汇总结果
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;
    const trashedCount = results.filter((r) => r.trashed).length;
    const hardDeletedCount = results.filter((r) => r.hardDeleted).length;
    const backedUpCount = results.filter((r) => r.backedUp).length;

    const lines = results.map((r) => `  ${r.success ? '✓' : '✗'} ${r.absPath}: ${r.message}`);
    const summary = `${t('tools.deleteSummary', {
      ok: successCount,
      total: results.length,
      trashed: trashedCount,
      hardDeleted: hardDeletedCount,
      backedUp: backedUpCount,
    })}${failCount > 0 ? t('tools.deleteFailedSuffix', { count: failCount }) : ''}`;

    return {
      content: [{ type: 'text', text: `${summary}\n${lines.join('\n')}` }],
      metadata: {
        results,
        summary: { total: results.length, success: successCount, failed: failCount, trashed: trashedCount, hardDeleted: hardDeletedCount, backedUp: backedUpCount },
      },
    };
  }
};

/**
 * 删除单个路径（模块级函数，与 edit 工具 editOneFile 同模式；不依赖 this 绑定）。
 */
async function deleteSingle(
  rawPath: string,
  ctx: ToolContext,
  opts: { trash: boolean; force: boolean; dryRun: boolean; recursive: boolean; trackHistory: boolean },
  fileHistory: FileHistoryService | null,
  trashDir: string | undefined,
  dryRunList: Array<{ path: string; type: 'file' | 'directory'; bytes: number; action: string }>,
): Promise<PathResult> {
  const { trash, force, dryRun, recursive, trackHistory } = opts;
  const filesys = ctx.services.tryResolve<FilesysService>(ServiceNames.FILESYS);

  // a. 路径越权校验（filesys roots 机制）
  const absPath = filesys ? filesys.resolve(rawPath, ctx.cwd) : null;
  if (!absPath) {
    return { absPath: rawPath, success: false, message: t('tools.deletePathEscapesRoots') };
  }

  // b. 存在性校验
  if (!existsSync(absPath)) {
    return { absPath, success: false, message: t('tools.deletePathNotFound') };
  }

  // c. symlink 遍历防护：realpath 解析后必须仍在 cwd 内
  const realPath = realpathSafe(absPath);
  if (!isPathInside(realPath, ctx.cwd)) {
    return {
      absPath,
      success: false,
      message: t('tools.deleteSymlinkTraversal', { path: realPath }),
    };
  }

  // d. Windows 路径折叠防护：拒绝根级路径
  if (isRootPath(absPath) || isRootPath(realPath)) {
    return {
      absPath,
      success: false,
      message: t('tools.deleteRootRefused'),
    };
  }

  // e. dev vault 防护：路径含 .git/.svn/.hg 拒绝（force=true 可跳过）
  if (!force && containsVcsMarker(absPath)) {
    return {
      absPath,
      success: false,
      message: t('tools.deleteVcsProtected'),
    };
  }

  const stat = statSync(realPath);
  const isDir = stat.isDirectory();
  const bytes = stat.size;

  // f. 目录校验：recursive 必填 + 大小限制
  if (isDir) {
    if (!recursive) {
      return {
        absPath,
        success: false,
        message: t('tools.deleteIsDirectory'),
      };
    }
    // 计算目录大小（硬删除与 trash 均校验：trash 送系统回收站涉及跨盘复制 + 归档备份，同样耗时）
    const dirBytes = calcDirBytes(realPath);
    if (dirBytes > MAX_DIR_BYTES) {
      return {
        absPath,
        success: false,
        message: t('tools.deleteDirTooLarge', { bytes: dirBytes, limit: MAX_DIR_BYTES }),
      };
    }
  } else {
    // g. 文件 read-before-delete 校验（仅硬删除时强制，trash 模式可恢复故不强制；force=true 可跳过）
    if (!trash && !force && fileHistory && !fileHistory.isRead(ctx.sessionId, realPath)) {
      return {
        absPath,
        success: false,
        message: `${t('tools.readBeforeOverwriteRequired', { path: absPath })}\n${t('tools.deleteReadFirstHint')}`,
      };
    }
  }

  // h. dryRun：收集清单不执行
  if (dryRun) {
    const action = trash ? t('tools.deleteActionTrash') : t('tools.deleteActionHardDelete');
    dryRunList.push({ path: absPath, type: isDir ? 'directory' : 'file', bytes, action });
    return {
      absPath,
      success: true,
      message: t('tools.deleteDryRunWould', { action }),
      bytes,
      isDirectory: isDir,
      dryRun: true,
    };
  }

  // i/j. trash 模式：备份 → 送系统回收站（失败回退应用内回收站）→ 记录历史
  if (trash) {
    // 1. 删除前备份（undo/消息撤回恢复原位的数据来源；失败不阻断——系统回收站本身是兜底）
    let tracker: ChangeTracker | null = null;
    if (trackHistory && fileHistory) {
      try {
        tracker = await fileHistory.track({
          sessionId: ctx.sessionId,
          absPath: realPath,
          toolCallId: ctx.toolCallId,
          toolName: 'delete',
        });
      } catch (err) {
        ctx.logger.warn('delete: track failed, undo will be unavailable', {
          path: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. 送系统回收站（Windows 回收站 / macOS 废纸篓 / Linux gio trash）
    let systemTrash = true;
    let fallbackTrashPath: string | null = null;
    try {
      await sendToTrash([realPath]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      systemTrash = false;
      ctx.logger.warn('delete: system trash failed, falling back to internal trash', {
        path: absPath,
        error: errMsg,
      });
      // 3. 回退应用内回收站（~/.moss/file-history/trash，保留 7 天）
      if (!trashDir) {
        return { absPath, success: false, message: t('tools.deleteTrashDirUnavailable') };
      }
      try {
        const entry = moveToTrash(realPath, trashDir);
        fallbackTrashPath = entry.trashPath;
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return {
          absPath,
          success: false,
          message: t('tools.deleteTrashFailed', { message: `${errMsg}; fallback: ${fbMsg}` }),
        };
      }
    }

    // 4. 登记历史（消息撤回 rollbackRange / undo 从备份恢复原位的依据）
    if (tracker?.receipt.entryId) {
      try {
        tracker.commit();
      } catch (err) {
        ctx.logger.warn('delete: commit failed', {
          path: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 5. 变更事件（前端 contextFiles/WS file-deleted 通知；修复旧版 delete 无任何通知的割裂）
    filesys?.emitChange({
      kind: 'deleted',
      absPath,
      source: 'delete',
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
    });

    ctx.logger.info('delete: moved to trash', {
      path: absPath,
      isDirectory: isDir,
      systemTrash,
      fallbackTrashPath,
    });

    return {
      absPath,
      success: true,
      message: systemTrash
        ? t('tools.deleteTrashed')
        : t('tools.deleteTrashedFallback', { path: fallbackTrashPath ?? '' }),
      trashed: true,
      systemTrash,
      fallbackTrash: !systemTrash,
      backedUp: tracker?.receipt.backedUp ?? false,
      entryId: tracker?.receipt.entryId || null,
      bytes,
      isDirectory: isDir,
    };
  }

  // k. 硬删除：统一追踪备份 + unlinkSync/rmSync + commit 登记
  let tracker: ChangeTracker | null = null;
  if (trackHistory && fileHistory) {
    try {
      tracker = await fileHistory.track({
        sessionId: ctx.sessionId,
        absPath: realPath,
        toolCallId: ctx.toolCallId,
        toolName: 'delete',
      });
    } catch (err) {
      ctx.logger.warn('delete: track failed, undo will be unavailable', {
        path: absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    if (isDir) {
      rmSync(realPath, { recursive: true, force });
    } else {
      if (force) {
        // force=true：用 rmSync force 覆盖只读文件
        rmSync(realPath, { force: true });
      } else {
        unlinkSync(realPath);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { absPath, success: false, message: t('tools.deleteFailed', { message: errMsg }) };
  }

  // 登记历史（hashAfter='', bytesAfter=0）
  if (tracker) {
    try {
      tracker.commit();
    } catch (err) {
      ctx.logger.warn('delete: commit failed', {
        path: absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const backupNote = tracker?.receipt.backedUp
    ? t('tools.deleteBackupNote', { path: tracker.receipt.backupPath ?? '' })
    : '';

  // 变更事件（同 trash 分支；delete 从原位置消失即视为 deleted）
  filesys?.emitChange({
    kind: 'deleted',
    absPath,
    source: 'delete',
    sessionId: ctx.sessionId,
    toolCallId: ctx.toolCallId,
  });

  ctx.logger.info('delete: hard deleted', { path: absPath, isDirectory: isDir, force });

  return {
    absPath,
    success: true,
    message: `${t('tools.deleteHardDeleted')}${backupNote}`,
    hardDeleted: true,
    backedUp: tracker?.receipt.backedUp ?? false,
    entryId: tracker?.receipt.entryId || null,
    bytes,
    isDirectory: isDir,
  };
}

/** 计算目录总字节数（递归） */
function calcDirBytes(dirPath: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      const full = join(dirPath, ent.name);
      try {
        if (ent.isDirectory()) {
          total += calcDirBytes(full);
        } else {
          total += statSync(full).size;
        }
      } catch {
        // 跳过单项失败
      }
    }
  } catch {
    // 目录读取失败
  }
  return total;
}
