// tools/move/index.ts
// move 工具：移动/重命名文件或目录（替代 terminal 的 mv/Move-Item，全程可 undo）。
// 强化点：
//   1. 同盘 rename 原子移动；跨盘（EXDEV）回退递归 copy + delete
//   2. file-history move 条目：undo = dest → source 反向 rename
//   3. overwrite 三策略（error / rename 自动改名 / overwrite 覆盖前备份目标）
//   4. 四重安全校验（roots / symlink / 根路径 / VCS）+ 100MB 目录上限
//   5. dryRun 预演 + 批量（sources）
//   6. filesys 变更事件（file-moved，前端可见）

import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import {
  existsSync,
  statSync,
  renameSync,
  mkdirSync,
  rmSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import {
  isPathInside,
  realpathSafe,
  isRootPath,
  containsVcsMarker,
} from '../../../utils/fs';
import type { FileHistoryService, FilesysService } from '../../contracts';
import type { ChangeTracker } from '../../file-history/types';
import type { ToolContext, ToolResult } from '../types';

/** 目录移动大小上限（跨盘 fallback 时递归复制的保护） */
const MAX_DIR_BYTES = 100 * 1024 * 1024;

interface MoveParams {
  source?: string;
  sources?: string[];
  dest: string;
  overwrite?: 'error' | 'rename' | 'overwrite';
  dryRun?: boolean;
}

interface MoveOneResult {
  source: string;
  dest: string;
  success: boolean;
  message: string;
  bytes?: number;
  isDirectory?: boolean;
  renamedToAvoidConflict?: boolean;
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as MoveParams;

    // 1. 参数校验：source 与 sources 互斥，dest 必填
    if (p.source && p.sources) {
      return errorResult(t('tools.moveSourceExclusive'));
    }
    const inputSources = p.sources ?? (p.source ? [p.source] : []);
    if (inputSources.length === 0) {
      return errorResult(t('tools.moveSourceRequired'));
    }
    if (!p.dest) {
      return errorResult(t('tools.moveDestRequired'));
    }

    const overwrite = p.overwrite ?? 'error';
    const dryRun = p.dryRun ?? false;
    const toolConfig = (ctx.toolConfig ?? {}) as { trackHistory?: boolean };
    const trackHistory = toolConfig.trackHistory ?? true;

    const filesys = ctx.services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return errorResult(t('filesys.serviceUnavailable'));
    }
    const fileHistory = ctx.services.tryResolve<FileHistoryService>(ServiceNames.FILE_HISTORY);

    // 2. dest 解析（roots）
    const destAbs = filesys.resolve(p.dest, ctx.cwd);
    if (!destAbs) {
      return errorResult(t('fs.pathOutsideRoots', { path: p.dest, roots: '' }));
    }

    const results: MoveOneResult[] = [];
    const dryRunList: Array<{ source: string; dest: string; type: string; bytes: number }> = [];

    for (const rawSource of inputSources) {
      const r = await moveSingle(rawSource, destAbs, {
        multiSource: inputSources.length > 1,
        overwrite,
        dryRun,
        trackHistory,
      }, ctx, filesys, fileHistory, dryRunList);
      results.push(r);
    }

    if (dryRun) {
      const lines = dryRunList.map((d) => t('tools.moveDryRunLine', {
        source: d.source,
        dest: d.dest,
        type: t(d.type === 'directory' ? 'tools.moveTypeDirectory' : 'tools.moveTypeFile'),
        bytes: d.bytes,
      }));
      return {
        content: [{ type: 'text', text: `${t('tools.moveDryRunSummary', { count: dryRunList.length })}\n${lines.join('\n')}` }],
        metadata: { dryRun: true, wouldMove: dryRunList },
      };
    }

    const okCount = results.filter((r) => r.success).length;
    const failCount = results.length - okCount;
    const lines = results.map((r) => `  ${r.success ? '✓' : '✗'} ${r.source} → ${r.dest}: ${r.message}`);
    const summary = `${t('tools.moveSummary', { ok: okCount, total: results.length })}${failCount > 0 ? t('tools.moveFailedSuffix', { count: failCount }) : ''}`;

    return {
      content: [{ type: 'text', text: `${summary}\n${lines.join('\n')}` }],
      isError: failCount > 0 && okCount === 0,
      metadata: { results, summary: { total: results.length, success: okCount, failed: failCount } },
    };
  },
};

async function moveSingle(
  rawSource: string,
  destAbs: string,
  opts: {
    multiSource: boolean;
    overwrite: 'error' | 'rename' | 'overwrite';
    dryRun: boolean;
    trackHistory: boolean;
  },
  ctx: ToolContext,
  filesys: FilesysService,
  fileHistory: FileHistoryService | null,
  dryRunList: Array<{ source: string; dest: string; type: string; bytes: number }>,
): Promise<MoveOneResult> {
  const { multiSource, overwrite, dryRun, trackHistory } = opts;

  // a. 源解析（roots）
  const sourceAbs = filesys.resolve(rawSource, ctx.cwd);
  if (!sourceAbs) {
    return { source: rawSource, dest: destAbs, success: false, message: t('tools.moveSourceEscapesRoots') };
  }

  // b. 源存在性
  if (!existsSync(sourceAbs)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.moveSourceNotFound') };
  }

  // c. symlink / 根路径 / VCS 防护
  const realSource = realpathSafe(sourceAbs);
  if (!isPathInside(realSource, ctx.cwd)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.moveSymlinkTraversal') };
  }
  if (isRootPath(sourceAbs) || isRootPath(destAbs)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.moveRootRefused') };
  }
  if (containsVcsMarker(sourceAbs) || containsVcsMarker(destAbs)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.moveVcsProtected') };
  }
  // 不能把目录移进自己内部
  if (isPathInside(destAbs, sourceAbs)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.moveIntoItself') };
  }

  const sourceStat = statSync(realSource);
  const isDir = sourceStat.isDirectory();
  const bytes = sourceStat.size;

  // d. 目录大小限制（跨盘 fallback 需递归复制）
  if (isDir) {
    const dirBytes = calcDirBytes(realSource);
    if (dirBytes > MAX_DIR_BYTES) {
      return {
        source: sourceAbs, dest: destAbs, success: false,
        message: t('tools.moveDirTooLarge', { bytes: dirBytes, limit: MAX_DIR_BYTES }),
      };
    }
  }

  // e. 计算最终目标路径
  let finalDest = destAbs;
  let renamedToAvoidConflict = false;
  const destExists = existsSync(destAbs);
  const destIsDir = destExists && statSync(destAbs).isDirectory();
  if (multiSource && !destIsDir) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.moveMultiSourceDestDir') };
  }
  if (destIsDir && !multiSource) {
    // 单源移入目录：dest = dir/basename(source)
    finalDest = join(destAbs, basename(sourceAbs));
  }
  if (existsSync(finalDest) && finalDest !== sourceAbs) {
    if (overwrite === 'error') {
      return { source: sourceAbs, dest: finalDest, success: false, message: t('tools.moveDestExists', { path: finalDest }) };
    }
    if (overwrite === 'rename') {
      finalDest = findNonConflictingPath(finalDest);
      renamedToAvoidConflict = true;
    }
    // overwrite 策略：继续，覆盖前备份目标
  }

  if (finalDest === sourceAbs) {
    return { source: sourceAbs, dest: finalDest, success: false, message: t('tools.moveSamePath') };
  }

  // f. dryRun
  if (dryRun) {
    dryRunList.push({ source: sourceAbs, dest: finalDest, type: isDir ? 'directory' : 'file', bytes });
    return { source: sourceAbs, dest: finalDest, success: true, message: t('tools.moveDryRunWouldMove') };
  }

  // g. overwrite 策略：覆盖前统一追踪已存在目标（track 变更前备份；commit 变更后登记覆盖条目）
  let destTracker: ChangeTracker | null = null;
  if (existsSync(finalDest) && overwrite === 'overwrite' && trackHistory && fileHistory) {
    try {
      destTracker = await fileHistory.track({
        sessionId: ctx.sessionId,
        absPath: finalDest,
        toolCallId: ctx.toolCallId,
        toolName: 'edit',
      });
    } catch {
      /* 备份失败不阻断（undo 不可用） */
    }
  }

  // h. 执行移动：同盘 rename 原子；EXDEV 跨盘回退 copy+delete
  try {
    mkdirSync(dirname(finalDest), { recursive: true });
    try {
      renameSync(realSource, finalDest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        // 跨盘：递归复制 + 删除源
        copyRecursive(realSource, finalDest);
        if (isDir) {
          rmSync(realSource, { recursive: true, force: true });
        } else {
          rmSync(realSource, { force: true });
        }
      } else {
        throw err;
      }
    }
  } catch (err) {
    return { source: sourceAbs, dest: finalDest, success: false, message: t('tools.moveFailed', { message: err instanceof Error ? err.message : String(err) }) };
  }

  // i. 登记：被覆盖目标条目（undo 恢复旧内容）+ move 条目（undo = 反向 rename）
  if (destTracker) {
    try {
      destTracker.commit();
    } catch {
      /* 登记失败不阻断 */
    }
  }
  if (trackHistory && fileHistory) {
    try {
      const moveTracker = await fileHistory.track({
        sessionId: ctx.sessionId,
        absPath: sourceAbs,
        toolCallId: ctx.toolCallId,
        toolName: 'move',
        destPath: finalDest,
        bytesBefore: bytes,
        isDirectory: isDir,
      });
      moveTracker.commit();
    } catch {
      /* 记录失败不阻断 */
    }
  }

  // j. filesys 变更事件（file-moved）+ 缓存清理
  filesys.emitChange({
    kind: 'moved',
    absPath: sourceAbs,
    destPath: finalDest,
    source: 'move',
    sessionId: ctx.sessionId,
    toolCallId: ctx.toolCallId,
  });

  ctx.logger.info('move: moved', { source: sourceAbs, dest: finalDest, isDirectory: isDir });

  return {
    source: sourceAbs,
    dest: finalDest,
    success: true,
    message: t('tools.moveSuccess', {
      renamed: renamedToAvoidConflict ? t('tools.moveRenamedNote') : '',
    }),
    bytes,
    isDirectory: isDir,
    renamedToAvoidConflict,
  };
}

/** 生成不冲突的目标路径：name.ext → name (1).ext → name (2).ext … */
function findNonConflictingPath(p: string): string {
  const dir = dirname(p);
  const base = basename(p, extname(p));
  const ext = extname(p);
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${base} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${base} (${Date.now()})${ext}`);
}

/** 递归复制（跨盘 move fallback） */
function copyRecursive(src: string, dest: string): void {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const ent of readdirSync(src)) {
      copyRecursive(join(src, ent), join(dest, ent));
    }
  } else {
    copyFileSync(src, dest);
  }
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
        /* 跳过单项失败 */
      }
    }
  } catch {
    /* 目录读取失败 */
  }
  return total;
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
