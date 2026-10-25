// tools/edit/index.ts
// edit 工具 execute 逻辑：精确字符串匹配替换，支持三种模式：
//   A. 单次替换（path+oldString+newString，向后兼容）
//   B. 单文件批量（path+edits，顺序应用，预校验全通过才原子写入）
//   C. 多文件批量（files，文件级独立原子：失败文件跳过，其余照常）
// 强化点：
//   1. 多级模糊容错（exact → eol → indent → trailing-ws），命中即应用并标注级别
//   2. sha256 乐观锁（expectHash 防并发覆盖）
//   3. dryRun 预览
//   4. read-before-overwrite + 统一 track 哈希备份 + 原子写入 + diff 返回
// filesys 统一化：读取/哈希走 filesys.readFile（sha256 对磁盘原始字节，修复 BOM 乐观锁断裂）；
// 写入走 filesys.writeFile（BOM 单次保留，替代旧双写；缓存更新 + 变更事件）。

import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import { existsSync, statSync } from 'node:fs';
import { stripBom } from '../../../utils/encoding';
import { computeLineDiff } from '../../file-history/diff';
import { hashText } from '../../filesys/hash';
import { impactHintFor } from '../shared/file-index-hint';
import type { FileHistoryService, FilesysService } from '../../contracts';
import type { ChangeTracker } from '../../file-history/types';
import type { ToolContext, ToolResult } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

interface SingleEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

interface FileEdit {
  path: string;
  edits: SingleEdit[];
}

interface EditToolConfig {
  trackHistory: boolean;
  requireReadBeforeOverwrite: boolean;
  requireHashMatch: boolean;
  fuzzyMatch: boolean;
  maxEditsPerFile: number;
  maxFiles: number;
}

type FuzzyLevel = 'exact' | 'eol' | 'indent' | 'trailing-ws';

interface FuzzyLocateResult {
  /** 在原 content 上的起始偏移（仅用于 replaceAll=false 时定位，实际替换用 alignedOld） */
  start: number;
  end: number;
  /** 对齐后的搜索串；用它 split/join 或 replace 在原 content 上精确替换 */
  alignedOld: string;
  level: FuzzyLevel;
  /** 匹配次数（replaceAll 时为全部出现次数） */
  count: number;
}

interface PerEditResult {
  replacements: number;
  fuzzyLevel: FuzzyLevel;
}

interface ApplyResult {
  ok: boolean;
  newContent?: string;
  perEdit?: PerEditResult[];
  failedEditIndex?: number;
  error?: string;
}

interface EditOneFileResult {
  ok: boolean;
  path: string;
  replacements: number;
  perEdit: PerEditResult[];
  fuzzyLevels: FuzzyLevel[];
  diff?: string;
  hashBefore?: string;
  hashAfter?: string;
  expectHash?: string;
  hashMatched?: boolean;
  entryId?: string | null;
  backedUp?: boolean;
  dryRun?: boolean;
  error?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

function getFileHistory(ctx: ToolContext): FileHistoryService | null {
  return ctx.services.tryResolve<FileHistoryService>(ServiceNames.FILE_HISTORY);
}

function getFilesys(ctx: ToolContext): FilesysService | null {
  return ctx.services.tryResolve<FilesysService>(ServiceNames.FILESYS);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/** 检测文件主导行尾风格 */
function detectEol(content: string): 'crlf' | 'lf' {
  const crlfCount = countOccurrences(content, '\r\n');
  if (crlfCount === 0) return 'lf';
  const lfCount = countOccurrences(content, '\n');
  // CRLF 占多数（>= 一半）即视为 CRLF 文件
  return crlfCount * 2 >= lfCount ? 'crlf' : 'lf';
}

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 多级模糊容错定位。逐级尝试，命中即返回（用 alignedOld 在原 content 上精确替换）。
 * - replaceAll=false 时要求唯一匹配，否则视为未找到
 * - 全部级别失败返回 null
 */
function fuzzyLocate(
  content: string,
  oldString: string,
  fuzzyEnabled: boolean,
  replaceAll: boolean,
): FuzzyLocateResult | null {
  // Level 0: exact
  const exactCount = countOccurrences(content, oldString);
  if (exactCount > 0 && (replaceAll || exactCount === 1)) {
    const idx = content.indexOf(oldString);
    return {
      start: idx,
      end: idx + oldString.length,
      alignedOld: oldString,
      level: 'exact',
      count: exactCount,
    };
  }

  if (!fuzzyEnabled) return null;

  // Level 1: EOL 对齐（CRLF <-> LF）
  const fileEol = detectEol(content);
  let eolAligned = oldString;
  if (fileEol === 'crlf' && !oldString.includes('\r\n')) {
    eolAligned = oldString.replace(/\r?\n/g, '\r\n');
  } else if (fileEol === 'lf' && oldString.includes('\r\n')) {
    eolAligned = oldString.replace(/\r\n/g, '\n');
  }
  if (eolAligned !== oldString) {
    const c = countOccurrences(content, eolAligned);
    if (c > 0 && (replaceAll || c === 1)) {
      const idx = content.indexOf(eolAligned);
      return { start: idx, end: idx + eolAligned.length, alignedOld: eolAligned, level: 'eol', count: c };
    }
  }

  // Level 2: 缩进 tab <-> space 对齐（仅行首）
  // 生成两个候选：行首 tab→2空格、行首 2空格→tab，分别精确匹配
  const tabToSpace = oldString.replace(/^(\t+)/gm, (m) => m.replace(/\t/g, '  '));
  const spaceToTab = oldString.replace(/^( +)/gm, (m) => m.replace(/  /g, '\t'));
  for (const aligned of [tabToSpace, spaceToTab]) {
    if (aligned === oldString) continue;
    const c = countOccurrences(content, aligned);
    if (c > 0 && (replaceAll || c === 1)) {
      const idx = content.indexOf(aligned);
      return { start: idx, end: idx + aligned.length, alignedOld: aligned, level: 'indent', count: c };
    }
  }

  // Level 3: 行尾空白归一化
  // oldString 每行转义后行尾允许匹配任意尾部空白 [ \t]*
  try {
    const lines = oldString.split('\n');
    const regexSrc = lines.map((l) => escapeRegExp(l) + '[ \\t]*').join('\\n');
    const re = new RegExp(regexSrc, 'g');
    const matches = Array.from(content.matchAll(re));
    if (matches.length > 0 && (replaceAll || matches.length === 1)) {
      const m = matches[0];
      const idx = m.index ?? -1;
      if (idx >= 0) {
        const aligned = m[0];
        return {
          start: idx,
          end: idx + aligned.length,
          alignedOld: aligned,
          level: 'trailing-ws',
          count: matches.length,
        };
      }
    }
  } catch {
    // 正则构造失败，跳过该级别
  }

  return null;
}

/**
 * 在 content 上顺序应用 edits（模拟，预校验）。
 * 任一 edit 的 oldString 找不到/不唯一 → 立即返回失败，不修改内容。
 * edit[N] 在 edit[N-1] 修改后的内容上查找。
 */
function applyEditsOnContent(
  content: string,
  edits: SingleEdit[],
  fuzzyEnabled: boolean,
): ApplyResult {
  let current = content;
  const perEdit: PerEditResult[] = [];

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (typeof e.oldString !== 'string' || typeof e.newString !== 'string') {
      return { ok: false, failedEditIndex: i, error: t('tools.editEntryStringsInvalid', { index: i }) };
    }
    if (e.oldString === e.newString) {
      return { ok: false, failedEditIndex: i, error: t('tools.editIdenticalStrings', { index: i }) };
    }
    if (e.oldString === '') {
      return { ok: false, failedEditIndex: i, error: t('tools.editEmptyOldString', { index: i }) };
    }
    const replaceAll = e.replaceAll ?? false;
    const loc = fuzzyLocate(current, e.oldString, fuzzyEnabled, replaceAll);
    if (!loc) {
      const occ = countOccurrences(current, e.oldString);
      const error = occ === 0
        ? t('tools.editOldStringNotFound', { index: i })
        : t('tools.editOldStringNotUnique', { index: i, count: occ });
      return { ok: false, failedEditIndex: i, error };
    }
    if (replaceAll) {
      current = current.split(loc.alignedOld).join(e.newString);
      perEdit.push({ replacements: loc.count, fuzzyLevel: loc.level });
    } else {
      current = current.replace(loc.alignedOld, e.newString);
      perEdit.push({ replacements: 1, fuzzyLevel: loc.level });
    }
  }

  return { ok: true, newContent: current, perEdit };
}

// ============================================================================
// 单文件完整编辑流程
// ============================================================================

async function editOneFile(
  fileEdit: FileEdit,
  expectHash: string | undefined,
  dryRun: boolean,
  ctx: ToolContext,
  toolConfig: EditToolConfig,
): Promise<EditOneFileResult> {
  const { path: rawPath, edits } = fileEdit;
  const result: EditOneFileResult = {
    ok: false,
    path: rawPath,
    replacements: 0,
    perEdit: [],
    fuzzyLevels: [],
  };

  // 1. 路径解析（filesys roots 机制）
  const filesys = getFilesys(ctx);
  if (!filesys) {
    result.error = t('filesys.serviceUnavailable');
    return result;
  }
  const absPath = filesys.resolve(rawPath, ctx.cwd);
  if (!absPath) {
    result.error = t('fs.pathOutsideRoots', {
      path: rawPath,
      roots: filesys.listRoots().length > 0 ? ` + ${filesys.listRoots().join(', ')}` : '',
    });
    return result;
  }
  result.path = absPath;

  // 2. 存在性
  if (!existsSync(absPath)) {
    result.error = t('tools.editFileNotFound', { path: absPath });
    return result;
  }

  // 3. 目录检测
  try {
    if (statSync(absPath).isDirectory()) {
      result.error = t('tools.pathIsDirectory', { path: absPath });
      return result;
    }
  } catch {
    // stat 失败不阻断，后续读取会抛错
  }

  // 4. read-before-overwrite
  const fileHistory = getFileHistory(ctx);
  if (toolConfig.requireReadBeforeOverwrite && fileHistory) {
    if (!fileHistory.isRead(ctx.sessionId, absPath)) {
      result.error = `${t('tools.readBeforeOverwriteRequired', { path: absPath })}\n${t('tools.editReadFirstHint')}`;
      return result;
    }
  }

  // 5. 读文件（filesys 统一读取：缓存命中零 I/O；BOM 剥离在字符串层，写回时 writeFile 按原文件保留）
  let content: string;
  let diskHashBefore: string;
  try {
    const entity = filesys.readFile(absPath);
    if (!entity) {
      result.error = t('tools.editFileNotFound', { path: absPath });
      return result;
    }
    // 全项目统一哈希规范：sha256 对磁盘原始字节（含 BOM）计算（修复 BOM 文件乐观锁断裂 bug）
    diskHashBefore = entity.sha256;
    content = stripBom(entity.rawBuffer.toString('utf8'));
  } catch (err) {
    result.error = t('tools.editReadError', { reason: err instanceof Error ? err.message : String(err) });
    return result;
  }

  // 6. expectHash 乐观锁（与 read 返回的 metadata.sha256 同源同规范，BOM 文件不再误报）
  const actualHashBefore = diskHashBefore;
  result.hashBefore = actualHashBefore;
  result.expectHash = expectHash;
  if (expectHash !== undefined) {
    if (expectHash !== actualHashBefore) {
      result.error = t('tools.hashMismatch', { path: absPath });
      result.hashMatched = false;
      return result;
    }
    result.hashMatched = true;
  } else {
    if (toolConfig.requireHashMatch) {
      ctx.logger.warn(t('tools.expectHashMissing'), { path: absPath });
    }
    result.hashMatched = false;
  }

  // 7. 模拟应用 edits（预校验）
  const applyResult = applyEditsOnContent(content, edits, toolConfig.fuzzyMatch);
  if (!applyResult.ok || !applyResult.newContent) {
    const idx = (applyResult.failedEditIndex ?? 0) + 1;
    result.error = `${t('tools.batchEditFailed', { index: idx, level: 'none', path: absPath })}\n${applyResult.error}`;
    return result;
  }
  const newContent = applyResult.newContent;
  result.perEdit = applyResult.perEdit ?? [];
  result.replacements = result.perEdit.reduce((s, e) => s + e.replacements, 0);
  result.fuzzyLevels = result.perEdit.map((e) => e.fuzzyLevel);

  // 8. dryRun：只返回 diff 不写入
  if (dryRun) {
    const diff = computeLineDiff(content, newContent);
    result.ok = true;
    result.dryRun = true;
    result.diff = diff || undefined;
    result.hashAfter = hashText(newContent);
    return result;
  }

  // 9. 统一追踪：改前备份（改前哈希）
  let tracker: ChangeTracker | null = null;
  if (toolConfig.trackHistory && fileHistory) {
    try {
      tracker = await fileHistory.track({
        sessionId: ctx.sessionId,
        absPath,
        toolCallId: ctx.toolCallId,
        toolName: 'edit',
      });
    } catch (err) {
      ctx.logger.warn('edit: track failed, undo will be unavailable', {
        path: absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 10. 原子写入（filesys.writeFile：BOM 单次保留 + 缓存更新 + 变更事件；旧双写废弃）
  //     expectHash 已在步骤 6 校验，此处不再传（避免二次比对）
  let writeResult: import('../../filesys/types').WriteFileResult;
  try {
    writeResult = filesys.writeFile(absPath, newContent, {
      source: 'edit',
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      fsync: true,
      preserveBom: true,
      createDirs: false,
    });
  } catch (err) {
    result.error = t('tools.editWriteError', { reason: err instanceof Error ? err.message : String(err) });
    return result;
  }
  if (!writeResult.ok) {
    result.error = t('tools.editWriteError', { reason: writeResult.message });
    return result;
  }

  // 11. diff（hashAfter = 写入后磁盘真实字节哈希，含被保留的 BOM）
  const diff = computeLineDiff(content, newContent);
  result.diff = diff || undefined;
  result.hashAfter = writeResult.sha256;
  result.entryId = tracker?.receipt.entryId ?? null;
  result.backedUp = tracker?.receipt.backedUp ?? false;
  result.ok = true;

  // 12. 登记（写入 transcript）
  if (tracker) {
    try {
      tracker.commit({
        hashAfter: result.hashAfter,
        bytesAfter: writeResult.bytes,
        diff: diff || undefined,
      });
    } catch (err) {
      ctx.logger.warn('edit: commit failed', {
        path: absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  ctx.logger.info(t('tools.fileEdited', { path: absPath }), { replacements: result.replacements });

  return result;
}

// ============================================================================
// 主入口
// ============================================================================

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as {
      path?: string;
      oldString?: string;
      newString?: string;
      replaceAll?: boolean;
      edits?: SingleEdit[];
      files?: { path: string; edits: SingleEdit[] }[];
      expectHash?: string;
      dryRun?: boolean;
    };

    // 读取配置
    const cfg = (ctx.toolConfig ?? {}) as Partial<EditToolConfig>;
    const toolConfig: EditToolConfig = {
      trackHistory: cfg.trackHistory ?? true,
      requireReadBeforeOverwrite: cfg.requireReadBeforeOverwrite ?? true,
      requireHashMatch: cfg.requireHashMatch ?? true,
      fuzzyMatch: cfg.fuzzyMatch ?? true,
      maxEditsPerFile: cfg.maxEditsPerFile ?? 50,
      maxFiles: cfg.maxFiles ?? 20,
    };

    // 参数归一化为 FileEdit[]
    let fileEdits: FileEdit[];
    let expectHash: string | undefined;

    if (p.files && p.files.length > 0) {
      // 模式 C：多文件批量
      if (p.files.length > toolConfig.maxFiles) {
        return {
          content: [{ type: 'text', text: `Error: ${t('tools.editFilesExceedMax', { max: toolConfig.maxFiles })}` }],
          isError: true,
        };
      }
      fileEdits = p.files.map((f) => ({ path: f.path, edits: f.edits }));
      expectHash = undefined; // 多文件模式不支持顶层 expectHash（每文件哈希不同）
    } else if (p.path && p.edits && p.edits.length > 0) {
      // 模式 B：单文件批量
      if (p.edits.length > toolConfig.maxEditsPerFile) {
        return {
          content: [{ type: 'text', text: `Error: ${t('tools.editEditsExceedMax', { max: toolConfig.maxEditsPerFile })}` }],
          isError: true,
        };
      }
      fileEdits = [{ path: p.path, edits: p.edits }];
      expectHash = p.expectHash;
    } else if (p.path && typeof p.oldString === 'string' && typeof p.newString === 'string') {
      // 模式 A：单次替换（向后兼容）
      fileEdits = [{
        path: p.path,
        edits: [{ oldString: p.oldString, newString: p.newString, replaceAll: p.replaceAll }],
      }];
      expectHash = p.expectHash;
    } else {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.editMissingParams')}` }],
        isError: true,
      };
    }

    // 基础校验
    for (const fe of fileEdits) {
      if (!fe.path) {
        return { content: [{ type: 'text', text: `Error: ${t('tools.editPathRequired')}` }], isError: true };
      }
      for (const e of fe.edits) {
        if (typeof e.oldString !== 'string' || typeof e.newString !== 'string') {
          return { content: [{ type: 'text', text: `Error: ${t('tools.editStringsMustBeStrings')}` }], isError: true };
        }
      }
    }

    const dryRun = p.dryRun ?? false;

    // 单文件快速路径
    if (fileEdits.length === 1) {
      const r = await editOneFile(fileEdits[0], expectHash, dryRun, ctx, toolConfig);
      if (!r.ok) {
        return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
      }
      const nonExactLevels = r.fuzzyLevels.filter((l) => l !== 'exact');
      const fuzzyNote = nonExactLevels.length > 0
        ? `\n[${t('tools.fuzzyMatchUsed', { level: nonExactLevels.join(',') })}]`
        : '';
      const replacementsDesc = t(
        r.replacements > 1 ? 'tools.editReplacementsMany' : 'tools.editReplacementsOne',
        { count: r.replacements },
      );
      const summary = r.dryRun
        ? `${t('tools.dryRunPreview')}: ${r.path} (${replacementsDesc})`
        : t('tools.editSuccess', { path: r.path, replacements: replacementsDesc });
      const diffSection = r.diff ? `\n\n--- unified diff ---\n${r.diff}` : '';
      const backupNote = r.backedUp && r.entryId
        ? `\n[${t('tools.editBackupCreated', { entryId: r.entryId })}]`
        : '';
      // 影响面注入（图谱开启且就绪时；非 dryRun 的真实写入才提示）
      const impactNote = !r.dryRun && r.path
        ? await impactHintFor(ctx, r.path).then(h => (h ? `\n${h}` : ''))
        : '';

      return {
        content: [{ type: 'text', text: summary + fuzzyNote + diffSection + backupNote + impactNote }],
        metadata: {
          path: r.path,
          replacements: r.replacements,
          perEdit: r.perEdit,
          fuzzyLevels: r.fuzzyLevels,
          diff: r.diff || undefined,
          hashBefore: r.hashBefore || null,
          hashAfter: r.hashAfter || null,
          expectHash: r.expectHash || null,
          hashMatched: r.hashMatched ?? false,
          entryId: r.entryId || null,
          backedUp: r.backedUp ?? false,
          dryRun: r.dryRun ?? false,
        },
      };
    }

    // 多文件模式：文件级独立原子
    const results: EditOneFileResult[] = [];
    for (const fe of fileEdits) {
      const r = await editOneFile(fe, undefined, dryRun, ctx, toolConfig);
      results.push(r);
    }

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    if (succeeded.length === 0) {
      const lines = [t('tools.multiEditAllFailed')];
      for (const r of failed) {
        lines.push(`  - ${r.path}: ${r.error}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
    }

    const lines: string[] = [];
    if (failed.length > 0) {
      lines.push(t('tools.multiEditPartialFailure', { failed: failed.length, success: succeeded.length }));
    } else {
      lines.push(t('tools.editMultiSuccess', { count: succeeded.length }));
    }
    lines.push('');
    lines.push(t('tools.editSucceededLabel'));
    for (const r of succeeded) {
      const nonExact = r.fuzzyLevels.filter((l) => l !== 'exact');
      const fuzzy = nonExact.length > 0 ? ` [${t('tools.editFuzzyTag', { levels: nonExact.join(',') })}]` : '';
      const dryTag = r.dryRun ? ` [${t('tools.editDryRunTag')}]` : '';
      const replDesc = t(
        r.replacements > 1 ? 'tools.editReplacementsMany' : 'tools.editReplacementsOne',
        { count: r.replacements },
      );
      lines.push(`  - ${r.path} (${replDesc})${fuzzy}${dryTag}`);
      if (r.diff) {
        lines.push('    --- diff ---');
        lines.push(r.diff.split('\n').map((l) => '    ' + l).join('\n'));
      }
    }
    if (failed.length > 0) {
      lines.push('');
      lines.push(t('tools.editFailedLabel'));
      for (const r of failed) {
        lines.push(`  - ${r.path}: ${r.error}`);
      }
    }

    // 影响面注入（多文件：合并每个成功文件的上游清单，图谱开启且就绪时）
    if (!dryRun && succeeded.length > 0 && succeeded.length <= 5) {
      const impacts = await Promise.all(
        succeeded.filter(r => r.path).map(async r => ({ path: r.path, hint: await impactHintFor(ctx, r.path!) })),
      );
      const hits = impacts.filter(x => x.hint);
      if (hits.length > 0) {
        lines.push('');
        lines.push(hits.map(x => x.hint).join('\n'));
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      metadata: {
        files: results.map((r) => ({
          path: r.path,
          ok: r.ok,
          replacements: r.replacements,
          fuzzyLevels: r.fuzzyLevels,
          hashAfter: r.hashAfter || null,
          // diff 供前端逐文件渲染 diff 视图（失败文件无 diff）
          diff: r.diff || undefined,
          error: r.error || undefined,
        })),
        succeeded: succeeded.length,
        failed: failed.length,
        dryRun,
      },
    };
  },
};
