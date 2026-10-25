// webui/src/lib/tool-preview.ts
// 工具调用卡片「预览」数据构建（纯函数，无 React 依赖）。
// 把不同工具的结果归一为可渲染的预览形态：diff / terminal / fileList / read / text / empty。
// diff 优先取后端 metadata.diff（含上下文与行号），旧会话/缺失时退回结果文本或参数合成。

import type { ToolResult } from '../types/api';

/** diff 文件头操作标签：修改 / 新建 / dryRun 预览 */
export type DiffLabel = 'modified' | 'new' | 'preview';

/** diff 行类型：新增 / 删除 / 上下文 / hunk 头 */
export type DiffRowKind = 'add' | 'del' | 'context' | 'hunk';

export interface DiffRow {
  kind: DiffRowKind;
  /** 行内容（hunk 行是 `@@ -a,b +c,d @@` 原文） */
  text: string;
  /** 旧文件行号（新增行/hunk 为 null） */
  oldNo: number | null;
  /** 新文件行号（删除行/hunk 为 null） */
  newNo: number | null;
}

export interface DiffBlock {
  path: string;
  label: DiffLabel;
  rows: DiffRow[];
  added: number;
  removed: number;
  /** 超过渲染上限被截断 */
  truncated: boolean;
}

export interface DiffFailure {
  path: string;
  error?: string;
}

export interface DiffPreview {
  kind: 'diff';
  blocks: DiffBlock[];
  /** 多文件批量中失败且无 diff 的文件 */
  failures: DiffFailure[];
  truncated: boolean;
  /** 纯失败结果（无结构化 diff）的错误原文 */
  error?: string;
}

export interface TerminalPreviewData {
  kind: 'terminal';
  command: string;
  output: string;
  cwd?: string;
  exitCode?: number;
}

export interface FileListPreviewData {
  kind: 'fileList';
  files: string[];
}

export interface ReadPreviewData {
  kind: 'read';
  path: string;
  text: string;
}

export interface TextPreviewData {
  kind: 'text';
  text: string;
  isError: boolean;
}

export interface EmptyPreviewData {
  kind: 'empty';
  reason: 'pending' | 'noResult';
}

export type ToolPreview =
  | DiffPreview
  | TerminalPreviewData
  | FileListPreviewData
  | ReadPreviewData
  | TextPreviewData
  | EmptyPreviewData;

export interface BuildToolPreviewParams {
  toolName: string;
  args: Record<string, unknown> | null;
  metadata?: ToolResult['metadata'];
  resultText?: string;
  isError?: boolean;
  /** 是否已经有结果（含仅文本的全局索引兜底） */
  hasResult: boolean;
}

/** diff 渲染行数上限（防止超长 diff 阻塞消息流） */
const MAX_DIFF_ROWS = 2000;

/** 工具参数摘要长度上限 */
const MAX_SUMMARY_CHARS = 80;

/** 安全读取对象（数组/null 视为无效） */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 安全读取非空字符串 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 只取前 max 行（不 split 整个大字符串，避免 write 超大 content 造成内存/卡顿）。
 * 末尾换行不产生额外空行；达到上限时再判断剩余是否还有非空白内容。
 */
function takeLines(value: string, max: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  if (!value || max <= 0) return { lines, truncated: value.trim().length > 0 };
  let start = 0;
  while (start < value.length) {
    if (lines.length >= max) {
      let hasContent = false;
      for (let i = start; i < value.length; i++) {
        const ch = value[i];
        if (ch !== '\n' && ch !== '\r' && ch !== ' ' && ch !== '\t') {
          hasContent = true;
          break;
        }
      }
      return { lines, truncated: hasContent };
    }
    const newline = value.indexOf('\n', start);
    const end = newline === -1 ? value.length : newline;
    let line = value.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    lines.push(line);
    if (newline === -1) return { lines, truncated: false };
    start = newline + 1;
  }
  return { lines, truncated: false };
}

/** 统计总行数（仅用于截断时显示真实增行数；不分配行数组） */
function countLines(value: string): number {
  if (!value) return 0;
  let count = 1;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) count++;
  }
  if (value.endsWith('\n')) count--;
  return count;
}

/** 截断摘要文本 */
function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 取路径最后一段（卡片标题摘要只显示文件名，完整路径见 diff 头/源码） */
function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

/**
 * 解析 unified diff（后端 computeLineDiff 产物：`@@` hunk 头 + ` / + / -` 行）。
 * 行号 0 显示为 null；未知前缀（提示行）跳过；超过上限截断。
 */
export function parseUnifiedDiff(diff: string, path: string, label: DiffLabel): DiffBlock | null {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  let truncated = false;

  for (const raw of diff.split('\n')) {
    if (rows.length >= MAX_DIFF_ROWS) {
      truncated = true;
      break;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      rows.push({
        kind: 'hunk',
        text: raw.endsWith('\r') ? raw.slice(0, -1) : raw,
        oldNo: null,
        newNo: null,
      });
      continue;
    }
    // `\ No newline at end of file` 与空行（尾部换行）不参与渲染
    if (!raw || raw.startsWith('\\')) continue;
    const prefix = raw[0];
    // CRLF 文件的 diff 行尾会带 \r（后端按 \n 切分），渲染前剥掉，避免多余换行
    const content = raw.endsWith('\r') ? raw.slice(1, -1) : raw.slice(1);
    if (prefix === '+') {
      rows.push({ kind: 'add', text: content, oldNo: null, newNo: newNo > 0 ? newNo : null });
      newNo++;
      added++;
    } else if (prefix === '-') {
      rows.push({ kind: 'del', text: content, oldNo: oldNo > 0 ? oldNo : null, newNo: null });
      oldNo++;
      removed++;
    } else if (prefix === ' ') {
      rows.push({
        kind: 'context',
        text: content,
        oldNo: oldNo > 0 ? oldNo : null,
        newNo: newNo > 0 ? newNo : null,
      });
      oldNo++;
      newNo++;
    }
  }

  if (rows.length === 0) return null;
  return { path, label, rows, added, removed, truncated };
}

/** 单次编辑的最小结构 */
interface EditTarget {
  path: string;
  edits: Array<{ oldString: string; newString: string }>;
}

/** 从单个 edit 条目对象收集 oldString/newString */
function collectEditPairs(list: unknown, single: Record<string, unknown>): EditTarget['edits'] {
  const pairs: EditTarget['edits'] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      const rec = asRecord(item);
      if (!rec) continue;
      const oldString = asString(rec.oldString);
      const newString = asString(rec.newString);
      if (oldString === undefined || newString === undefined) continue;
      pairs.push({ oldString, newString });
    }
  }
  // 模式 A：path + oldString + newString
  if (pairs.length === 0) {
    const oldString = asString(single.oldString);
    const newString = asString(single.newString);
    if (oldString !== undefined && newString !== undefined) pairs.push({ oldString, newString });
  }
  return pairs;
}

/** 归一化 edit 三种入参形态为「文件 → 编辑列表」 */
function collectEditTargets(args: Record<string, unknown>): EditTarget[] {
  const targets: EditTarget[] = [];
  const files = Array.isArray(args.files) ? args.files : [];
  if (files.length > 0) {
    for (const item of files) {
      const rec = asRecord(item);
      if (!rec) continue;
      const path = asString(rec.path);
      const edits = collectEditPairs(rec.edits, rec);
      if (path !== undefined && edits.length > 0) targets.push({ path, edits });
    }
    return targets;
  }
  const path = asString(args.path);
  const edits = collectEditPairs(args.edits, args);
  if (path !== undefined && edits.length > 0) targets.push({ path, edits });
  return targets;
}

/**
 * metadata 缺失时从 edit 参数合成 diff（无上下文、无行号）。
 * 删除行来自 oldString，新增行来自 newString；超出上限截断。
 */
export function buildSyntheticDiffFromArgs(
  args: Record<string, unknown>,
  label: DiffLabel,
): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  for (const target of collectEditTargets(args)) {
    const rows: DiffRow[] = [];
    let added = 0;
    let removed = 0;
    let truncated = false;
    for (const edit of target.edits) {
      const oldLines = takeLines(edit.oldString, MAX_DIFF_ROWS - rows.length);
      for (const line of oldLines.lines) {
        rows.push({ kind: 'del', text: line, oldNo: null, newNo: null });
        removed++;
      }
      if (oldLines.truncated) {
        truncated = true;
        break;
      }
      const newLines = takeLines(edit.newString, MAX_DIFF_ROWS - rows.length);
      for (const line of newLines.lines) {
        rows.push({ kind: 'add', text: line, oldNo: null, newNo: null });
        added++;
      }
      if (newLines.truncated) {
        truncated = true;
        break;
      }
    }
    if (rows.length > 0) {
      blocks.push({ path: target.path, label, rows, added, removed, truncated });
    }
  }
  return blocks;
}

/** write 新建文件：把 content 渲染为全新增行（新行号从 1 开始） */
export function buildWriteCreateBlock(args: Record<string, unknown>): DiffBlock | null {
  const path = asString(args.path) ?? '';
  const content = typeof args.content === 'string' ? args.content : undefined;
  if (content === undefined) return null;
  const { lines, truncated } = takeLines(content, MAX_DIFF_ROWS);
  const rows: DiffRow[] = lines.map((line, index) => ({
    kind: 'add',
    text: line,
    oldNo: null,
    newNo: index + 1,
  }));
  return {
    path,
    label: 'new',
    rows,
    added: truncated ? countLines(content) : lines.length,
    removed: 0,
    truncated,
  };
}

/** 从结果文本中提取 `--- unified diff ---` 之后的 diff 内容（旧会话兜底） */
export function extractUnifiedDiffFromText(text: string): string | null {
  const marker = '--- unified diff ---';
  const index = text.indexOf(marker);
  if (index === -1) return null;
  // 只去掉紧邻标记的换行，保留 diff 首行可能存在的上下文前导空格
  const body = text.slice(index + marker.length).replace(/^[\r\n]+/, '');
  return body || null;
}

/** 从参数中取路径 */
function pathFromArgs(args: Record<string, unknown> | null): string {
  return args ? asString(args.path) ?? '' : '';
}

/** 组合多文件 diff 预览（含失败文件列表） */
function buildMultiFilePreview(
  files: NonNullable<NonNullable<ToolResult['metadata']>['files']>,
  label: DiffLabel,
): DiffPreview | null {
  const blocks: DiffBlock[] = [];
  const failures: DiffFailure[] = [];
  for (const file of files) {
    const path = file.path ?? '';
    if (typeof file.diff === 'string' && file.diff) {
      const block = parseUnifiedDiff(file.diff, path, label);
      if (block) blocks.push(block);
    } else if (file.ok === false) {
      failures.push({ path, error: file.error });
    }
  }
  if (blocks.length === 0 && failures.length === 0) return null;
  return {
    kind: 'diff',
    blocks,
    failures,
    truncated: blocks.some((block) => block.truncated),
  };
}

/** edit 预览：metadata.files → metadata.diff → 结果文本 diff → 参数合成 */
function buildEditPreview(
  args: Record<string, unknown> | null,
  metadata: ToolResult['metadata'] | undefined,
  resultText: string,
): DiffPreview | null {
  const dryRun = metadata?.dryRun === true || (args ? args.dryRun === true : false);
  const label: DiffLabel = dryRun ? 'preview' : 'modified';
  const metaFiles = metadata?.files ?? [];
  if (metaFiles.length > 0) {
    const multi = buildMultiFilePreview(metaFiles, label);
    if (multi) return multi;
  }
  if (typeof metadata?.diff === 'string' && metadata.diff) {
    const block = parseUnifiedDiff(metadata.diff, metadata.path ?? pathFromArgs(args), label);
    if (block) {
      return { kind: 'diff', blocks: [block], failures: [], truncated: block.truncated };
    }
  }
  const fromText = extractUnifiedDiffFromText(resultText);
  if (fromText) {
    const block = parseUnifiedDiff(fromText, metadata?.path ?? pathFromArgs(args), label);
    if (block) {
      return { kind: 'diff', blocks: [block], failures: [], truncated: block.truncated };
    }
  }
  if (args) {
    const blocks = buildSyntheticDiffFromArgs(args, label);
    if (blocks.length > 0) {
      return {
        kind: 'diff',
        blocks,
        failures: [],
        truncated: blocks.some((block) => block.truncated),
      };
    }
  }
  return null;
}

/** write 预览：新建用参数 content 合成全绿；覆盖用 metadata.diff / 文本 diff */
function buildWritePreview(
  args: Record<string, unknown> | null,
  metadata: ToolResult['metadata'] | undefined,
  resultText: string,
): DiffPreview | null {
  if (metadata?.operation === 'create' && args) {
    const block = buildWriteCreateBlock(args);
    if (block) {
      return { kind: 'diff', blocks: [block], failures: [], truncated: block.truncated };
    }
  }
  const label: DiffLabel = 'modified';
  if (typeof metadata?.diff === 'string' && metadata.diff) {
    const block = parseUnifiedDiff(metadata.diff, metadata.path ?? pathFromArgs(args), label);
    if (block) {
      return { kind: 'diff', blocks: [block], failures: [], truncated: block.truncated };
    }
  }
  const fromText = extractUnifiedDiffFromText(resultText);
  if (fromText) {
    const block = parseUnifiedDiff(fromText, metadata?.path ?? pathFromArgs(args), label);
    if (block) {
      return { kind: 'diff', blocks: [block], failures: [], truncated: block.truncated };
    }
  }
  return null;
}

/**
 * terminal 结果首行是后端本地化标题（如「终端 xxx 执行结果：」）。
 * 有 running 标记说明是命令执行结果，剥掉首行只留输出；Error 文本不剥。
 */
function stripTerminalHeader(text: string, metadata: ToolResult['metadata'] | undefined): string {
  if (!text || text.startsWith('Error:') || typeof metadata?.running !== 'boolean') return text;
  const newline = text.indexOf('\n');
  return newline === -1 ? '' : text.slice(newline + 1);
}

/** glob/grep：按 metadata.returned 从结果文本第 2 行起截取本页正文 */
function extractSearchBody(text: string, metadata: ToolResult['metadata'] | undefined): string[] {
  const returned = typeof metadata?.returned === 'number' ? metadata.returned : 0;
  if (returned <= 0) return [];
  return text
    .split('\n')
    .slice(1, 1 + returned)
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
}

/** 工具参数一行摘要（命令 / 路径 / 模式等） */
export function summarizeToolCall(args: Record<string, unknown> | null): string {
  if (!args) return '';
  const keys = ['command', 'path', 'pattern', 'glob', 'query', 'url', 'name', 'task'];
  for (const key of keys) {
    const value = asString(args[key]);
    if (value === undefined) continue;
    const text = key === 'path' ? baseName(value.trim()) : value.trim();
    return truncateText(text, MAX_SUMMARY_CHARS);
  }
  for (const key of ['paths', 'files']) {
    const list = args[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const first = list[0];
    const record = asRecord(first);
    const value =
      typeof first === 'string' ? first : record ? asString(record.path) : undefined;
    if (value !== undefined && value.length > 0) {
      const name = baseName(value);
      return truncateText(list.length > 1 ? `${name}…` : name, MAX_SUMMARY_CHARS);
    }
  }
  return '';
}

/** 构建工具卡片预览 */
export function buildToolPreview({
  toolName,
  args,
  metadata,
  resultText,
  isError,
  hasResult,
}: BuildToolPreviewParams): ToolPreview {
  const text = resultText ?? '';
  const command = args ? asString(args.command) : undefined;

  // terminal：命令执行中/完成都显示 `$ 命令` + 输出
  if (toolName === 'terminal' && command !== undefined) {
    return {
      kind: 'terminal',
      command,
      output: hasResult ? stripTerminalHeader(text, metadata) : '',
      cwd: metadata?.cwd,
      exitCode: metadata?.exitCode,
    };
  }

  if (toolName === 'edit') {
    const preview = buildEditPreview(args, metadata, text);
    if (preview) {
      // 纯失败（无结构化 diff）时把错误原文挂在 diff 预览顶部，避免只看得到“将要改什么”
      const hasStructuredDiff =
        (typeof metadata?.diff === 'string' && metadata.diff.length > 0) ||
        (metadata?.files?.length ?? 0) > 0;
      return isError && text && !hasStructuredDiff ? { ...preview, error: text } : preview;
    }
  }

  if (toolName === 'write') {
    const preview = buildWritePreview(args, metadata, text);
    if (preview) return preview;
  }

  if ((toolName === 'glob' || toolName === 'grep') && hasResult) {
    const body = extractSearchBody(text, metadata);
    const isFileList = toolName === 'glob' || metadata?.outputMode === 'files_with_matches';
    if (isFileList && body.length > 0) return { kind: 'fileList', files: body };
    if (body.length > 0) return { kind: 'text', text: body.join('\n'), isError: !!isError };
  }

  if (toolName === 'read' && hasResult && metadata?.path) {
    return { kind: 'read', path: metadata.path, text };
  }

  if (!hasResult) return { kind: 'empty', reason: 'pending' };
  if (!text) return { kind: 'empty', reason: 'noResult' };
  return { kind: 'text', text, isError: !!isError };
}
