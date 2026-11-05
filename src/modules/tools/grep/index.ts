// tools/grep/index.ts
// grep 工具 execute 逻辑：按正则表达式搜索文件内容。
// 三种输出模式（content / files_with_matches / count）+ 上下文行 + smartCase +
// fixedStrings + multiline + type/glob 过滤 + offset 分页。
// 引擎：shared/search-core 异步 walker（gitignore 剪枝 / 8KB 头二进制检测 / AbortSignal）。
// 元数据见同目录 tool.json。

import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { Glob } from 'bun';
import { t } from '../../../core/i18n';
import { ServiceNames } from '../../../core/types';
import type { FilesysService } from '../../contracts';
import { stripBom } from '../../../utils/encoding';
import {
  walkFiles,
  typeToGlobs,
  toDisplayPath,
  readFileHead,
  isBinaryBufferHead,
  SUPPORTED_TYPES,
} from '../shared/search-core';
import { ScanCache } from '../shared/scan-cache';
import type { ToolContext, ToolResult } from '../types';

/** grep 专属文件列表缓存（独立实例；glob 不共享） */
const grepScanCache = new ScanCache({ ttlMs: 30_000, maxRoots: 2 });

const MAX_FILE_SIZE = 10 * 1024 * 1024;
/** multiline 模式单文件上限（整文件 exec，收紧防大文件回溯开销） */
const MAX_MULTILINE_FILE_SIZE = 1024 * 1024;
const MAX_LINE_DISPLAY = 500;
/** 正则长度上限，防止 LLM 注入超长模式 */
const MAX_PATTERN_LENGTH = 500;
/** files_with_matches 模式超出分页窗口后的额外缓冲（用于 mtime 排序近似） */
const FILES_BUFFER = 500;

/** 预检正则是否可能灾难性回溯（嵌套量词如 (a+)+ / (a*)* 等），是则拒绝 */
function isRiskyRegex(pattern: string): boolean {
  return /\([^()]*[+*{][^()]*\)[+*?{]/.test(pattern);
}

/** 转义正则元字符（fixedStrings 字面量搜索用） */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 统计 [0, end) 内换行数（multiline 行号计算） */
function countNewlinesBefore(content: string, end: number): number {
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf('\n', pos)) !== -1 && pos < end) {
    count++;
    pos++;
  }
  return count;
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_DISPLAY) return line;
  return line.slice(0, MAX_LINE_DISPLAY) + '...(truncated)';
}

interface GrepParams {
  pattern?: string;
  path?: string;
  glob?: string;
  type?: string;
  outputMode?: 'content' | 'files_with_matches' | 'count';
  caseInsensitive?: boolean;
  smartCase?: boolean;
  fixedStrings?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  multiline?: boolean;
  maxResults?: number;
  offset?: number;
  noIgnore?: boolean;
  dot?: boolean;
}

export default {
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = (params ?? {}) as GrepParams;
    const startedAt = Date.now();

    // ---- pattern 校验与归一 ----
    if (!p.pattern || typeof p.pattern !== 'string') {
      return { content: [{ type: 'text', text: `Error: ${t('tools.grepPatternRequired')}` }], isError: true };
    }
    if (p.pattern.length > MAX_PATTERN_LENGTH) {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.grepPatternTooLong', { max: MAX_PATTERN_LENGTH })}` }],
        isError: true,
      };
    }

    const fixedStrings = p.fixedStrings === true;
    const effectivePattern = fixedStrings ? escapeRegex(p.pattern) : p.pattern;
    if (!fixedStrings && isRiskyRegex(effectivePattern)) {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.grepPatternRejected')}` }],
        isError: true,
      };
    }

    // ---- 大小写策略：caseInsensitive 优先；smartCase 下纯小写自动忽略大小写 ----
    const smartCaseActive =
      p.smartCase === true && p.caseInsensitive !== true && !/[A-Z]/.test(p.pattern);
    const ignoreCase = p.caseInsensitive === true || smartCaseActive;

    // ---- 编译正则 ----
    const multiline = p.multiline === true;
    const outputMode: 'content' | 'files_with_matches' | 'count' =
      p.outputMode === 'files_with_matches' || p.outputMode === 'count' ? p.outputMode : 'content';

    let lineRegex: RegExp | null = null;
    let multilineRegex: RegExp | null = null;
    try {
      if (multiline) {
        multilineRegex = new RegExp(effectivePattern, (ignoreCase ? 'gi' : 'g') + 's');
      } else {
        lineRegex = new RegExp(effectivePattern, ignoreCase ? 'i' : '');
      }
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${t('tools.grepInvalidRegex', { pattern: p.pattern, reason: err instanceof Error ? err.message : String(err) })}`,
        }],
        isError: true,
      };
    }

    // ---- glob / type 文件过滤 ----
    let filterGlob: Glob | null = null;
    let filterGlobPattern: string | null = null;
    if (p.glob) {
      const normalized = p.glob.split('\\').join('/');
      try {
        filterGlob = new Glob(normalized);
        filterGlobPattern = normalized;
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${t('tools.searchInvalidGlob', { pattern: p.glob, reason: err instanceof Error ? err.message : String(err) })}`,
          }],
          isError: true,
        };
      }
    }

    let typeGlobs: Glob[] | null = null;
    if (p.type) {
      const globs = typeToGlobs(p.type);
      if (!globs) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${t('tools.searchInvalidType', { type: p.type, types: SUPPORTED_TYPES.join(', ') })}`,
          }],
          isError: true,
        };
      }
      typeGlobs = globs.map(g => new Glob(g));
    }

    // ---- 路径解析与隔离（filesys roots 机制）----
    const filesys = ctx.services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (!filesys) {
      return {
        content: [{ type: 'text', text: `Error: ${t('filesys.serviceUnavailable')}` }],
        isError: true,
      };
    }
    let searchPath: string;
    if (p.path) {
      const confined = filesys.resolve(p.path, ctx.cwd);
      if (!confined) {
        return {
          content: [{ type: 'text', text: `Error: ${t('fs.pathOutsideRoots', { path: p.path, roots: '' })}` }],
          isError: true,
        };
      }
      searchPath = confined;
    } else {
      searchPath = ctx.cwd || process.cwd();
    }

    let pathIsFile = false;
    try {
      pathIsFile = statSync(searchPath).isFile();
    } catch {
      return {
        content: [{ type: 'text', text: `Error: ${t('tools.grepPathNotFound', { path: searchPath })}` }],
        isError: true,
      };
    }

    // ---- 配置与分页参数 ----
    const cfg = (ctx.toolConfig ?? {}) as {
      respectGitignore?: boolean;
      maxResults?: number;
      maxContextLines?: number;
    };
    const noIgnore = p.noIgnore === true || cfg.respectGitignore === false;
    const maxResults = Math.min(Math.max(p.maxResults ?? cfg.maxResults ?? 100, 1), 500);
    const offset = Math.max(p.offset ?? 0, 0);
    const cfgMaxCtx = Math.max(cfg.maxContextLines ?? 10, 0);
    const clampCtx = (v: number | undefined): number =>
      Math.min(Math.max(v ?? 0, 0), Math.min(10, cfgMaxCtx));
    const contextBefore = outputMode === 'content' ? clampCtx(p.contextBefore) : 0;
    const contextAfter = outputMode === 'content' ? clampCtx(p.contextAfter) : 0;

    // ---- 收集循环 ----
    const lines: string[] = [];               // content / count 输出行
    const matchedFiles: Array<{ rel: string; abs: string }> = []; // files_with_matches
    let filesScanned = 0;
    let filesWithMatches = 0;
    let totalMatches = 0;                     // content: 匹配行数; count: 匹配行数合计; files_with_matches: 文件数
    let skippedLarge = 0;
    let cancelled = false;
    /** 达到收集窗口后提前终止（truncated 保守标记用） */
    let stoppedEarly = false;

    const displayBase = ctx.cwd || process.cwd();
    const collectLimit = offset + maxResults;

    const processFile = async (rel: string, abs: string): Promise<void> => {
      filesScanned++;

      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        return;
      }
      const sizeLimit = multiline ? MAX_MULTILINE_FILE_SIZE : MAX_FILE_SIZE;
      if (size > sizeLimit) {
        if (multiline) skippedLarge++;
        return;
      }

      // 二进制检测：只读前 8KB（避免全量读入）
      try {
        const head = await readFileHead(abs, 8192);
        if (isBinaryBufferHead(head)) return;
      } catch {
        return;
      }

      let content: string;
      try {
        content = stripBom(await readFile(abs, 'utf8'));
      } catch {
        return;
      }

      const filePath = toDisplayPath(abs, displayBase);

      if (multilineRegex) {
        // ---- multiline：整文件 exec，行号取匹配起始行 ----
        let mm: RegExpExecArray | null;
        let fileHadMatch = false;
        multilineRegex.lastIndex = 0;
        while ((mm = multilineRegex.exec(content)) !== null) {
          if (!fileHadMatch) {
            fileHadMatch = true;
            filesWithMatches++;
          }
          const lineNum = countNewlinesBefore(content, mm.index) + 1;
          const firstLine = mm[0].split('\n')[0] ?? '';
          totalMatches++;
          lines.push(`${filePath}:${lineNum}:${truncateLine(firstLine)}`);
          if (multilineRegex.lastIndex === mm.index) multilineRegex.lastIndex++; // 零宽匹配防死循环
          if (lines.length >= collectLimit) break;
        }
        return;
      }

      const fileLines = content.split('\n');

      if (outputMode === 'files_with_matches') {
        // ---- 只定位文件：首命中即停 ----
        for (let i = 0; i < fileLines.length; i++) {
          if (lineRegex!.test(fileLines[i])) {
            filesWithMatches++;
            totalMatches++;
            matchedFiles.push({ rel, abs });
            return;
          }
        }
        return;
      }

      if (outputMode === 'count') {
        // ---- 每文件匹配行计数（数完整个文件） ----
        let count = 0;
        for (let i = 0; i < fileLines.length; i++) {
          if (lineRegex!.test(fileLines[i])) count++;
        }
        if (count > 0) {
          filesWithMatches++;
          totalMatches += count;
          lines.push(`${filePath}:${count}`);
        }
        return;
      }

      // ---- content 模式（含上下文行；启用上下文时块间/文件间 `--` 分隔、重叠合并；无上下文保持纯行格式） ----
      const useContext = contextBefore > 0 || contextAfter > 0;
      let lastEmitted = -1; // 0-based 最后已输出行号
      let emittedAny = false;
      for (let i = 0; i < fileLines.length; i++) {
        if (!lineRegex!.test(fileLines[i])) continue;
        if (!emittedAny) {
          emittedAny = true;
          filesWithMatches++;
          if (useContext && lines.length > 0) lines.push('--'); // 文件间分隔
          lastEmitted = -1; // 新文件行号空间
        }
        const from = Math.max(0, i - contextBefore);
        const to = Math.min(fileLines.length - 1, i + contextAfter);
        const start = Math.max(from, lastEmitted + 1);
        if (useContext && lastEmitted >= 0 && start > lastEmitted + 1) lines.push('--'); // 同文件内跳行分隔
        for (let j = start; j <= to; j++) {
          const sep = j === i ? ':' : '-';
          lines.push(`${filePath}${sep}${j + 1}${sep}${truncateLine(fileLines[j])}`);
        }
        lastEmitted = to;
        totalMatches++;
        if (lines.length >= collectLimit) break;
      }
    };

    /** glob 文件过滤（ripgrep -g 语义：无 '/' 的模式额外匹配 basename） */
    const filePassesFilters = (rel: string): boolean => {
      if (filterGlob) {
        const hit = filterGlob.match(rel)
          || (!filterGlobPattern!.includes('/') && filterGlob.match(rel.split('/').pop()!));
        if (!hit) return false;
      }
      if (typeGlobs && !typeGlobs.some(g => g.match(rel))) return false;
      return true;
    };

    if (pathIsFile) {
      await processFile('', searchPath);
    } else {
      // ---- 缓存枚举（grep 专属文件列表缓存；跳过重复目录遍历）----
      let cachedFiles: Array<{ rel: string; abs: string }> | null = null;
      if (!p.path && !noIgnore && p.dot !== true) {
        try {
          const entries = await grepScanCache.list(searchPath, {
            noIgnore: false,
            dot: false,
            includeDirs: false,
          });
          cachedFiles = entries.filter((e) => !e.isDir).map((e) => ({ rel: e.rel, abs: e.abs }));
        } catch {
          cachedFiles = null; // 缓存枚举异常 → 回退遍历
        }
      }

      try {
        if (cachedFiles) {
          // 缓存枚举路径：内存列表过滤 + 处理
          for (const entry of cachedFiles) {
            if (ctx.signal?.aborted) break;
            if (!filePassesFilters(entry.rel)) continue;
            await processFile(entry.rel, entry.abs);
            if (lines.length >= collectLimit) {
              stoppedEarly = true;
              break;
            }
            if (outputMode === 'files_with_matches' && matchedFiles.length >= collectLimit + FILES_BUFFER) {
              stoppedEarly = true;
              break;
            }
          }
        } else {
          for await (const entry of walkFiles(searchPath, {
            signal: ctx.signal,
            noIgnore,
            dot: p.dot === true,
          })) {
            if (ctx.signal?.aborted) break;
            if (!filePassesFilters(entry.rel)) continue;
            await processFile(entry.rel, entry.abs);
            // 提前终止：输出行数/命中文件数达收集窗口（count 模式 totalMatches 为部分和，见 metadata）
            if (lines.length >= collectLimit) {
              stoppedEarly = true;
              break;
            }
            if (outputMode === 'files_with_matches' && matchedFiles.length >= collectLimit + FILES_BUFFER) {
              stoppedEarly = true;
              break;
            }
          }
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
    if (ctx.signal?.aborted) cancelled = true;

    // ---- files_with_matches：mtime 降序排序（最近修改优先） ----
    if (outputMode === 'files_with_matches') {
      const mtimeCache = new Map<string, number>();
      await Promise.all(
        matchedFiles.map(async f => {
          try {
            mtimeCache.set(f.abs, (await stat(f.abs)).mtimeMs);
          } catch {
            mtimeCache.set(f.abs, 0);
          }
        }),
      );
      matchedFiles.sort((a, b) => (mtimeCache.get(b.abs) ?? 0) - (mtimeCache.get(a.abs) ?? 0));
    }

    // ---- 分页与输出 ----
    const allLines = outputMode === 'files_with_matches'
      ? matchedFiles.map(f => toDisplayPath(f.abs, displayBase))
      : lines;
    // total：content=匹配行数；files_with_matches=命中文件数；count=已计数文件数（提前终止时为部分和）
    const total = outputMode === 'content' ? totalMatches
      : outputMode === 'files_with_matches' ? matchedFiles.length
      : lines.length;
    // truncated：显示窗口外仍有结果，或因窗口提前终止（保守提示）
    const truncated = !cancelled && (allLines.length > collectLimit || stoppedEarly);
    const page = allLines.slice(offset, offset + maxResults);

    const modeDesc =
      outputMode === 'content' ? t('tools.grepModeMatches') : t('tools.grepModeFilesWithMatches');
    const header =
      t('tools.grepFoundHeader', {
        total,
        mode: modeDesc,
        files: filesWithMatches,
        fileUnit: t(filesWithMatches === 1 ? 'tools.grepFileUnitOne' : 'tools.grepFileUnitMany'),
        scanned: filesScanned,
        elapsed: Date.now() - startedAt,
      }) +
      (truncated ? t('tools.grepShowingRange', { from: offset + 1, to: offset + page.length }) : '') +
      '\n';
    const hints: string[] = [];
    if (truncated) hints.push(t('tools.searchTruncatedHint'));
    if (skippedLarge > 0) hints.push(t('tools.searchMultilineSkipped', { count: skippedLarge, max: 1 }));
    if (cancelled) hints.push(t('tools.searchCancelled'));
    const body = page.length > 0 ? page.join('\n') : t('tools.searchNoResults');

    return {
      content: [{ type: 'text', text: header + body + (hints.length > 0 ? `\n${hints.join('\n')}` : '') }],
      metadata: {
        pattern: p.pattern,
        outputMode,
        caseInsensitive: ignoreCase,
        smartCaseApplied: smartCaseActive,
        fixedStrings,
        multiline,
        glob: p.glob ?? null,
        type: p.type ?? null,
        root: searchPath,
        filesScanned,
        filesWithMatches,
        totalMatches: total,
        returned: page.length,
        truncated,
        maxResults,
        offset,
        contextBefore,
        contextAfter,
        noIgnore,
        dot: p.dot ?? false,
        skippedLarge,
        cancelled,
        elapsedMs: Date.now() - startedAt,
      },
    };
  },
};
