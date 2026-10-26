// tools/copy/index.ts
// copy 工具：复制文件/目录（替代 terminal 的 cp/Copy-Item）。
// 强化点：
//   1. 副本登记 file-history：新副本为 create 条目（undo = 删除副本）；覆盖时对目标先备份
//   2. overwrite 三策略（error / rename 自动改名 / overwrite 覆盖前备份）
//   3. 安全校验（roots / 根路径 / VCS / 目录大小上限）+ dryRun + 批量
//   4. filesys 变更事件（file-created, source=copy）

import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import {
  existsSync,
  statSync,
  mkdirSync,
  rmSync,
  readdirSync,
  copyFileSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { computeLineDiff } from '../../file-history/diff';
import {
  isPathInside,
  realpathSafe,
  isRootPath,
  containsVcsMarker,
} from '../../../utils/fs';
import type { FileHistoryService, FilesysService } from '../../contracts';
import type { ChangeTracker } from '../../file-history/types';
import type { ToolContext, ToolResult } from '../types';

/** 目录复制大小上限 */
const MAX_DIR_BYTES = 100 * 1024 * 1024;

/** 覆盖 diff 的字节上限（超过不生成，避免读入超大文件） */
const MAX_DIFF_BYTES = 1 * 1024 * 1024;

/**
 * 覆盖复制时生成行级 diff：旧内容来自备份，新内容来自源文件。
 * 目录 / 无备份 / 二进制（含 NUL）/ 超过上限时返回 undefined（条目仅记录元数据）。
 */
function buildOverwriteDiff(
  backupPath: string | null,
  sourcePath: string,
  isDir: boolean,
): string | undefined {
  if (isDir || !backupPath || !backupPath.endsWith('.bak')) return undefined;
  try {
    const beforeStat = statSync(backupPath);
    const afterStat = statSync(sourcePath);
    if (!beforeStat.isFile() || !afterStat.isFile()) return undefined;
    if (beforeStat.size > MAX_DIFF_BYTES || afterStat.size > MAX_DIFF_BYTES) return undefined;
    const before = readFileSync(backupPath);
    const after = readFileSync(sourcePath);
    if (before.includes(0) || after.includes(0)) return undefined;
    return computeLineDiff(before.toString('utf8'), after.toString('utf8')) || undefined;
  } catch {
    return undefined;
  }
}

interface CopyParams {
  source?: string;
  sources?: string[];
  dest: string;
  overwrite?: 'error' | 'rename' | 'overwrite';
  dryRun?: boolean;
}

interface CopyOneResult {
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
    const p = params as CopyParams;

    if (p.source && p.sources) {
      return errorResult(t('tools.copySourceExclusive'));
    }
    const inputSources = p.sources ?? (p.source ? [p.source] : []);
    if (inputSources.length === 0) {
      return errorResult(t('tools.copySourceRequired'));
    }
    if (!p.dest) {
      return errorResult(t('tools.copyDestRequired'));
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

    const destAbs = filesys.resolve(p.dest, ctx.cwd);
    if (!destAbs) {
      return errorResult(t('fs.pathOutsideRoots', { path: p.dest, roots: '' }));
    }

    const results: CopyOneResult[] = [];
    const dryRunList: Array<{ source: string; dest: string; type: string; bytes: number }> = [];

    for (const rawSource of inputSources) {
      const r = await copySingle(rawSource, destAbs, {
        multiSource: inputSources.length > 1,
        overwrite,
        dryRun,
        trackHistory,
      }, ctx, filesys, fileHistory, dryRunList);
      results.push(r);
    }

    if (dryRun) {
      const lines = dryRunList.map((d) => t('tools.copyDryRunLine', {
        source: d.source,
        dest: d.dest,
        type: t(d.type === 'directory' ? 'tools.copyTypeDirectory' : 'tools.copyTypeFile'),
        bytes: d.bytes,
      }));
      return {
        content: [{ type: 'text', text: `${t('tools.copyDryRunSummary', { count: dryRunList.length })}\n${lines.join('\n')}` }],
        metadata: { dryRun: true, wouldCopy: dryRunList },
      };
    }

    const okCount = results.filter((r) => r.success).length;
    const failCount = results.length - okCount;
    const lines = results.map((r) => `  ${r.success ? '✓' : '✗'} ${r.source} → ${r.dest}: ${r.message}`);
    const summary = `${t('tools.copySummary', { ok: okCount, total: results.length })}${failCount > 0 ? t('tools.copyFailedSuffix', { count: failCount }) : ''}`;

    return {
      content: [{ type: 'text', text: `${summary}\n${lines.join('\n')}` }],
      isError: failCount > 0 && okCount === 0,
      metadata: { results, summary: { total: results.length, success: okCount, failed: failCount } },
    };
  },
};

async function copySingle(
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
): Promise<CopyOneResult> {
  const { multiSource, overwrite, dryRun, trackHistory } = opts;

  // a. 源解析（roots）
  const sourceAbs = filesys.resolve(rawSource, ctx.cwd);
  if (!sourceAbs) {
    return { source: rawSource, dest: destAbs, success: false, message: t('tools.copySourceEscapesRoots') };
  }
  if (!existsSync(sourceAbs)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.copySourceNotFound') };
  }

  // b. 安全防护
  const realSource = realpathSafe(sourceAbs);
  if (!isPathInside(realSource, ctx.cwd)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.copySymlinkTraversal') };
  }
  if (isRootPath(sourceAbs) || isRootPath(destAbs)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.copyRootRefused') };
  }
  if (containsVcsMarker(sourceAbs) || containsVcsMarker(destAbs)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.copyVcsProtected') };
  }
  if (isPathInside(destAbs, sourceAbs)) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.copyIntoItself') };
  }

  const sourceStat = statSync(realSource);
  const isDir = sourceStat.isDirectory();
  const bytes = sourceStat.size;

  if (isDir) {
    const dirBytes = calcDirBytes(realSource);
    if (dirBytes > MAX_DIR_BYTES) {
      return {
        source: sourceAbs, dest: destAbs, success: false,
        message: t('tools.copyDirTooLarge', { bytes: dirBytes, limit: MAX_DIR_BYTES }),
      };
    }
  }

  // c. 计算最终目标
  let finalDest = destAbs;
  let renamedToAvoidConflict = false;
  const destExists = existsSync(destAbs);
  const destIsDir = destExists && statSync(destAbs).isDirectory();
  if (multiSource && !destIsDir) {
    return { source: sourceAbs, dest: destAbs, success: false, message: t('tools.copyMultiSourceDestDir') };
  }
  if (destIsDir) {
    finalDest = join(destAbs, basename(sourceAbs));
  }
  if (existsSync(finalDest)) {
    if (overwrite === 'error') {
      return { source: sourceAbs, dest: finalDest, success: false, message: t('tools.copyDestExists', { path: finalDest }) };
    }
    if (overwrite === 'rename') {
      finalDest = findNonConflictingPath(finalDest);
      renamedToAvoidConflict = true;
    }
  }

  if (dryRun) {
    dryRunList.push({ source: sourceAbs, dest: finalDest, type: isDir ? 'directory' : 'file', bytes });
    return { source: sourceAbs, dest: finalDest, success: true, message: t('tools.copyDryRunWouldCopy') };
  }

  // d. 覆盖前统一追踪已存在目标（track 变更前备份；commit 变更后登记覆盖条目）
  // toolName='write' → operation='overwrite'（面板显示「覆盖」，undo 从备份恢复旧内容），
  // 与 copy create 条目（undo=删除副本）语义区分。
  let destTracker: ChangeTracker | null = null;
  let overwriteDiff: string | undefined;
  if (existsSync(finalDest) && overwrite === 'overwrite' && trackHistory && fileHistory) {
    try {
      destTracker = await fileHistory.track({
        sessionId: ctx.sessionId,
        absPath: finalDest,
        toolCallId: ctx.toolCallId,
        toolName: 'write',
      });
      overwriteDiff = buildOverwriteDiff(destTracker.receipt.backupPath, realSource, isDir);
    } catch {
      /* 备份失败不阻断 */
    }
  }

  // e. 执行复制
  try {
    mkdirSync(dirname(finalDest), { recursive: true });
    if (existsSync(finalDest)) {
      // overwrite 策略：清掉已存在目标（内容已备份/或 rename 已避开）
      if (statSync(finalDest).isDirectory()) {
        rmSync(finalDest, { recursive: true, force: true });
      } else {
        rmSync(finalDest, { force: true });
      }
    }
    copyRecursive(realSource, finalDest);
  } catch (err) {
    return { source: sourceAbs, dest: finalDest, success: false, message: t('tools.copyFailed', { message: err instanceof Error ? err.message : String(err) }) };
  }

  // f. 登记：被覆盖目标条目（undo 恢复旧内容）+ 副本 create 条目（undo = 删除副本）
  // 覆盖场景不再额外登记 copy create 条目：同一路径若同时有 overwrite 与 create 两条活跃条目，
  // 单步 undo 会优先删除文件，而不是恢复被覆盖的旧内容。
  if (destTracker) {
    try {
      destTracker.commit({
        bytesAfter: bytes,
        ...(overwriteDiff ? { diff: overwriteDiff } : {}),
      });
    } catch {
      /* 登记失败不阻断 */
    }
  } else if (trackHistory && fileHistory) {
    try {
      const copyTracker = await fileHistory.track({
        sessionId: ctx.sessionId,
        absPath: finalDest,
        toolCallId: ctx.toolCallId,
        toolName: 'copy',
        isDirectory: isDir,
      });
      copyTracker.commit({ bytesAfter: bytes });
    } catch {
      /* 记录失败不阻断 */
    }
  }

  // g. filesys 变更事件
  filesys.emitChange({
    kind: 'created',
    absPath: finalDest,
    source: 'copy',
    sessionId: ctx.sessionId,
    toolCallId: ctx.toolCallId,
  });

  ctx.logger.info('copy: copied', { source: sourceAbs, dest: finalDest, isDirectory: isDir });

  return {
    source: sourceAbs,
    dest: finalDest,
    success: true,
    message: t('tools.copySuccess', {
      renamed: renamedToAvoidConflict ? t('tools.copyRenamedNote') : '',
    }),
    bytes,
    isDirectory: isDir,
    renamedToAvoidConflict,
  };
}

/** 生成不冲突的目标路径：name.ext → name (1).ext … */
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

/** 递归复制 */
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
