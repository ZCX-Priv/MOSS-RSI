// webui/src/components/shared/ToolCallDetails.tsx
// 工具调用卡片（主对话与子代理执行过程共用，保证图标/交互/样式一致）。
//
// 标题行：状态/工具图标 + 工具名 + 入参摘要 + diff 增删统计 + 状态文案 + 展开箭头。
// 展开区：预览/源码胶囊导航 + 复制源码；preview 走美化视图（edit/write 为 diff，
//         web search 为编号结果列表），source 保留原始参数 JSON / 结果 / MCP structuredContent / resources。
// run_code 通过 previewOverride / sourceOverride / titleOverride / trailing 复用同一张卡片。
// 默认折叠；底部居中箭头可收起。

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  Copy,
  Eye,
  FileText,
  Globe,
  Loader2,
  Square,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { resolveToolIcon } from '@/lib/tool-icons';
import { wsClient } from '../../api/ws';
import { copyText } from '../../lib/clipboard';
import { fileNameOf } from '../../render/file/detector';
import {
  buildToolPreview,
  foldDiffRows,
  summarizeToolCall,
  type DiffBlock,
  type DiffPreview,
  type DiffRow,
  type SearchResultsPreviewData,
  type ToolPreview,
} from '../../lib/tool-preview';
import { sanitizeTerminalOutput } from '../../lib/terminal-output';
import { FileTypeIcon } from './FileTypeIcon';
import type { ToolCall, ToolResult } from '../../types/api';

interface ToolCallDetailsProps {
  toolCall: ToolCall;
  /** 就近匹配到的完整结果（含 metadata：structuredContent / resources / diff） */
  result?: ToolResult;
  /** 全局结果索引兜底（结果消息不紧邻调用消息时，只有文本与错误标记） */
  fallbackText?: string;
  fallbackIsError?: boolean;
  /** 工具名 → 图标白名单键（store.toolIconMap） */
  iconMap: Record<string, string>;
  /** 覆盖默认预览内容（run_code 等有专属结果形态的工具使用） */
  previewOverride?: ReactNode;
  /** 覆盖默认源码内容（run_code 展示程序源码而非参数 JSON） */
  sourceOverride?: ReactNode;
  /** 覆盖复制文本（run_code 复制程序源码） */
  copyTextOverride?: string;
  /** 头部标题覆盖（run_code 显示「代码」而非 run_code） */
  titleOverride?: string;
  /** 头部右侧附加信息（run_code 的状态文案），仅展示不拦截点击 */
  trailing?: ReactNode;
  /** 头部行类名覆盖（PTC 用更小的左内边距形成中间层级） */
  headerClassName?: string;
}

type CardMode = 'preview' | 'source';

const TAB_ITEM = 'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] transition-colors';
const TAB_ACTIVE = 'bg-background text-foreground shadow-sm';
const TAB_INACTIVE = 'text-muted-foreground hover:text-foreground';

/** 预览/源码 胶囊（样式与文件预览的 PreviewModeToggle 同源） */
function ToolModeToggle({ mode, onChange }: { mode: CardMode; onChange: (mode: CardMode) => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t('task.toolCard.modePreview')}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-muted/40 p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'preview'}
        onClick={() => onChange('preview')}
        className={cn(TAB_ITEM, mode === 'preview' ? TAB_ACTIVE : TAB_INACTIVE)}
      >
        <Eye className="size-3" />
        {t('task.toolCard.modePreview')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'source'}
        onClick={() => onChange('source')}
        className={cn(TAB_ITEM, mode === 'source' ? TAB_ACTIVE : TAB_INACTIVE)}
      >
        <Code2 className="size-3" />
        {t('task.toolCard.modeSource')}
      </button>
    </div>
  );
}

/** diff 单行（hunk 头 / 增删 / 上下文） */
function DiffLineRow({ row }: { row: DiffRow }) {
  if (row.kind === 'hunk') {
    return (
      <div className="bg-sky-500/10 px-2 py-0.5 text-sky-600 dark:text-sky-400">
        {row.text}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'grid grid-cols-[2.5rem_2.5rem_1rem_1fr] items-start px-1',
        row.kind === 'add' && 'bg-emerald-500/10 dark:bg-emerald-500/20',
        row.kind === 'del' && 'bg-red-500/10 dark:bg-red-500/20',
      )}
    >
      <span className="select-none pr-1.5 text-right text-muted-foreground/50">
        {row.oldNo ?? ''}
      </span>
      <span className="select-none pr-1.5 text-right text-muted-foreground/50">
        {row.newNo ?? ''}
      </span>
      <span
        className={cn(
          'select-none whitespace-pre',
          row.kind === 'add' && 'text-emerald-600 dark:text-emerald-400',
          row.kind === 'del' && 'text-destructive',
          row.kind === 'context' && 'text-muted-foreground/60',
        )}
      >
        {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
      </span>
      <span className="whitespace-pre-wrap break-all text-foreground">{row.text || ' '}</span>
    </div>
  );
}

/** 单个文件的 diff 面板：文件头 + 智能折叠后的行 */
function DiffBlockView({ block }: { block: DiffBlock }) {
  const { t } = useTranslation();
  const [openFolds, setOpenFolds] = useState<Set<number>>(new Set());
  const displayRows = useMemo(() => foldDiffRows(block.rows), [block.rows]);

  // diff 内容变化（流式/结果更新）时清空展开态，避免旧 foldStart 命中新折叠条
  useEffect(() => {
    setOpenFolds(new Set());
  }, [block.rows]);

  const label =
    block.label === 'new'
      ? t('task.toolCard.newFile')
      : block.label === 'preview'
        ? t('task.toolCard.dryRunPreview')
        : t('task.toolCard.modifiedFile');

  const toggleFold = (id: number) => {
    setOpenFolds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1">
        <FileTypeIcon fileName={fileNameOf(block.path || 'file')} size={16} className="shrink-0" />
        <span
          className="min-w-0 truncate text-[11px] font-medium text-foreground"
          title={block.path}
        >
          {fileNameOf(block.path || 'file')}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">({label})</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums">
          {block.added > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400">+{block.added}</span>
          )}
          {block.added > 0 && block.removed > 0 && ' '}
          {block.removed > 0 && <span className="text-destructive">-{block.removed}</span>}
        </span>
      </div>
      <div className="max-h-[300px] overflow-auto no-scrollbar font-mono text-[11px] leading-[1.6]">
        {displayRows.map((row, index) => {
          if (row.kind !== 'fold') {
            return <DiffLineRow key={index} row={row} />;
          }
          const open = openFolds.has(row.foldStart);
          return (
            <div key={`fold-${row.foldStart}-${index}`}>
              <div className="relative flex items-center justify-center py-1.5">
                <div
                  aria-hidden="true"
                  className="absolute inset-x-2 top-1/2 -translate-y-1/2 border-t border-dashed border-border"
                />
                <button
                  type="button"
                  onClick={() => toggleFold(row.foldStart)}
                  title={
                    open
                      ? t('task.toolCard.diffFoldCollapse')
                      : t('task.toolCard.diffFolded', { count: row.hidden.length })
                  }
                  aria-label={
                    open
                      ? t('task.toolCard.diffFoldCollapse')
                      : t('task.toolCard.diffFolded', { count: row.hidden.length })
                  }
                  className="relative z-10 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 font-sans text-[10px] text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
                >
                  <span className="flex size-4 items-center justify-center rounded-sm bg-muted/60">
                    <ChevronDown
                      className={cn('size-3 transition-transform', open && 'rotate-180')}
                    />
                  </span>
                  {open
                    ? t('task.toolCard.diffFoldCollapse')
                    : t('task.toolCard.diffFolded', { count: row.hidden.length })}
                </button>
              </div>
              {open &&
                row.hidden.map((hiddenRow, hiddenIndex) => (
                  <DiffLineRow key={`hidden-${hiddenIndex}`} row={hiddenRow} />
                ))}
            </div>
          );
        })}
        {block.truncated && (
          <div className="border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
            {t('task.toolCard.diffTruncated')}
          </div>
        )}
      </div>
    </div>
  );
}

/** diff 预览：多文件块 + 失败文件提示 */
function DiffPreviewView({ preview }: { preview: DiffPreview }) {
  return (
    <div className="flex flex-col divide-y divide-border">
      {preview.error && (
        <div className="mx-2.5 my-1.5 whitespace-pre-wrap break-all rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {preview.error}
        </div>
      )}
      {preview.blocks.map((block, index) => (
        <DiffBlockView key={`${block.path}-${index}`} block={block} />
      ))}
      {preview.failures.length > 0 && (
        <div className="mx-2.5 my-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {preview.failures.map((failure, index) => (
            <div key={`${failure.path}-${index}`} className="break-all">
              {failure.path}
              {failure.error ? `: ${failure.error}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 站点图标：优先站点自身 favicon，失败/非法 URL 回退地球图标 */
function SiteFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = useMemo(() => {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return '';
      return `https://${parsed.hostname}/favicon.ico`;
    } catch {
      return '';
    }
  }, [url]);

  if (!src || failed) return <Globe className="size-4 shrink-0 text-muted-foreground" />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-4 shrink-0 rounded-[3px] object-contain"
    />
  );
}

/** web 搜索结果：序号 + 站点图标 + 标题 + 灰色摘要，点击整行打开链接 */
function SearchResultsView({ preview }: { preview: SearchResultsPreviewData }) {
  const { t } = useTranslation();
  const open = (url: string) => {
    if (!/^https?:\/\//i.test(url)) {
      toast.error(t('task.runCode.openBlocked'));
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="overflow-hidden">
      <div className="max-h-[300px] overflow-auto no-scrollbar py-0.5">
        {preview.items.map((item, index) => {
          const summary = item.snippet || item.contentExcerpt || '';
          return (
            <button
              key={`${item.url}-${index}`}
              type="button"
              onClick={() => open(item.url)}
              title={t('task.toolCard.openLink')}
              aria-label={t('task.toolCard.openLink')}
              className="grid w-full grid-cols-[1.25rem_1rem_minmax(0,1fr)] items-start gap-x-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
            >
              <span className="flex h-5 items-center justify-end font-mono text-[11px] tabular-nums text-muted-foreground/50">
                {preview.offset + index + 1}
              </span>
              <span className="flex h-5 items-center">
                <SiteFavicon url={item.url} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] leading-5 text-muted-foreground">
                  {item.title || item.url}
                </span>
                {summary && (
                  <span className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/70">
                    {summary}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 预览档主体：按工具类型渲染美化视图 */
function PreviewBody({
  preview,
  hasResult,
  isError,
}: {
  preview: ToolPreview;
  hasResult: boolean;
  isError?: boolean;
}) {
  const { t } = useTranslation();

  if (preview.kind === 'diff') {
    return <DiffPreviewView preview={preview} />;
  }

  if (preview.kind === 'searchResults') {
    return <SearchResultsView preview={preview} />;
  }

  if (preview.kind === 'terminal') {
    const placeholder = !hasResult
      ? t('task.toolCard.pending')
      : t('task.toolCard.emptyResult');
    return (
      <div className="overflow-hidden">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1 font-mono text-[11px]">
          <span className="select-none text-emerald-600 dark:text-emerald-400">$</span>
          <span className="min-w-0 flex-1 truncate text-foreground" title={preview.command}>
            {preview.command}
          </span>
          {preview.cwd && (
            <span
              className="max-w-[40%] shrink-0 truncate text-[10px] text-muted-foreground"
              title={preview.cwd}
            >
              {preview.cwd}
            </span>
          )}
        </div>
        <pre
          className={cn(
            'max-h-[300px] overflow-auto no-scrollbar whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[11px] leading-relaxed',
            isError ? 'text-destructive' : 'text-foreground',
          )}
        >
          {preview.output || placeholder}
        </pre>
      </div>
    );
  }

  if (preview.kind === 'fileList') {
    return (
      <div className="overflow-hidden">
        <div className="max-h-[300px] overflow-auto no-scrollbar py-1">
          {preview.files.map((file, index) => (
            <div
              key={`${file}-${index}`}
              className="flex items-center gap-1.5 px-2 py-1 transition-colors hover:bg-muted/40"
              title={file}
            >
              <FileTypeIcon fileName={fileNameOf(file)} size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {file}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (preview.kind === 'read') {
    return (
      <div className="overflow-hidden">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1">
          <FileTypeIcon fileName={fileNameOf(preview.path)} size={16} className="shrink-0" />
          <span className="min-w-0 truncate text-[11px] font-medium text-foreground" title={preview.path}>
            {fileNameOf(preview.path)}
          </span>
        </div>
        <pre
          className={cn(
            'max-h-[300px] overflow-auto no-scrollbar whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[11px] leading-relaxed',
            isError ? 'text-destructive' : 'text-foreground',
          )}
        >
          {preview.text || t('task.toolCard.emptyResult')}
        </pre>
      </div>
    );
  }

  if (preview.kind === 'text') {
    return (
      <pre
        className={cn(
          'mx-2.5 my-1 max-h-[300px] overflow-auto no-scrollbar whitespace-pre-wrap break-all bg-muted/20 px-2 py-1.5 font-mono text-[11px] leading-relaxed',
          preview.isError ? 'text-destructive' : 'text-foreground',
        )}
      >
        {preview.text || t('task.toolCard.emptyResult')}
      </pre>
    );
  }

  return (
    <div className="px-3 py-3 text-center text-[11px] text-muted-foreground">
      {preview.reason === 'pending' ? t('task.toolCard.pending') : t('task.toolCard.emptyResult')}
    </div>
  );
}

/** 源码档主体：原始参数 JSON / 结果 / structuredContent / resources（沿用旧渲染口径） */
function SourceBody({
  toolCall,
  prettyArgs,
  result,
  resultText,
  isError,
}: {
  toolCall: ToolCall;
  prettyArgs: string;
  result?: ToolResult;
  resultText?: string;
  isError?: boolean;
}) {
  const { t } = useTranslation();
  const structured = result?.metadata?.structuredContent;
  const resources = result?.metadata?.resources;

  return (
    <div className="mx-2.5 my-1 flex max-h-[300px] flex-col gap-2 overflow-auto no-scrollbar bg-muted/20 p-2 text-xs">
      {toolCall.arguments && (
        <div>
          <div className="text-muted-foreground/70">{t('task.toolCallArguments')}</div>
          <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-foreground">
            {prettyArgs}
          </pre>
        </div>
      )}
      {resultText && (
        <div>
          <div className={cn('text-muted-foreground/70', isError && 'text-destructive/80')}>
            {isError ? t('task.errorResult') : t('task.result')}
          </div>
          <pre
            className={cn(
              'mono mt-0.5 whitespace-pre-wrap break-all',
              isError ? 'text-destructive' : 'text-foreground',
            )}
          >
            {resultText}
          </pre>
        </div>
      )}
      {/* MCP structuredContent：结构化输出 JSON */}
      {structured && (
        <div>
          <div className="text-muted-foreground/70">{t('task.structuredOutput')}</div>
          <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-foreground">
            {JSON.stringify(structured, null, 2)}
          </pre>
        </div>
      )}
      {/* MCP resources：资源引用卡片（uri + mimeType + 可展开 text） */}
      {resources && resources.length > 0 && (
        <div>
          <div className="text-muted-foreground/70">
            {t('task.resourceRefs', { count: resources.length })}
          </div>
          <div className="mt-0.5 flex flex-col gap-1">
            {resources.map((r) => (
              <details key={r.uri} className="group/res rounded border border-border px-1.5 py-1">
                <summary className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                  <ChevronRight className="size-3 transition-transform group-open/res:rotate-90" />
                  <FileText className="size-3 shrink-0" />
                  <span className="truncate">{r.uri}</span>
                  {r.mimeType && (
                    <span className="ml-auto shrink-0 rounded bg-muted px-1 py-px text-[10px]">
                      {r.mimeType}
                    </span>
                  )}
                </summary>
                {r.text && (
                  <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-foreground">
                    {r.text}
                  </pre>
                )}
              </details>
            ))}
          </div>
        </div>
      )}
      {!toolCall.arguments && !resultText && !structured && (!resources || resources.length === 0) && (
        <div className="text-muted-foreground">{t('task.toolCard.emptyResult')}</div>
      )}
    </div>
  );
}

export const ToolCallDetails = memo(function ToolCallDetails({
  toolCall,
  result,
  fallbackText,
  fallbackIsError,
  iconMap,
  previewOverride,
  sourceOverride,
  copyTextOverride,
  titleOverride,
  trailing,
  headerClassName,
}: ToolCallDetailsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<CardMode>('preview');
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  // 结果文本/错误标记：就近结果优先，全局索引兜底
  const resultText = useMemo(
    () =>
      result
        ? result.content
            .map((c) => (c.type === 'text' ? c.text : ''))
            .filter((text) => text.length > 0)
            .join('\n')
        : fallbackText,
    [result, fallbackText],
  );
  const isError = result?.isError ?? fallbackIsError;
  const hasResult = result !== undefined || fallbackText !== undefined;

  const parsedArgs = useMemo<Record<string, unknown> | null>(() => {
    try {
      const value: unknown = JSON.parse(toolCall.arguments || '{}');
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      return value as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [toolCall.arguments]);

  const prettyArgs = useMemo(() => {
    if (!toolCall.arguments) return '';
    try {
      return JSON.stringify(JSON.parse(toolCall.arguments), null, 2);
    } catch {
      // 非 JSON，原样显示
      return toolCall.arguments;
    }
  }, [toolCall.arguments]);

  const summary = useMemo(() => summarizeToolCall(parsedArgs), [parsedArgs]);

  const terminalCommand = useMemo(
    () =>
      toolCall.name === 'terminal' && parsedArgs && typeof parsedArgs.command === 'string'
        ? parsedArgs.command
        : undefined,
    [toolCall.name, parsedArgs],
  );

  // 终端历史结果可能带提示符/编码初始化/标记回显：预览与源码统一展示清洗后的文本
  const displayResultText = useMemo(
    () =>
      toolCall.name === 'terminal' && resultText
        ? sanitizeTerminalOutput(resultText, terminalCommand)
        : resultText,
    [toolCall.name, resultText, terminalCommand],
  );

  const preview = useMemo(
    () =>
      buildToolPreview({
        toolName: toolCall.name,
        args: parsedArgs,
        metadata: result?.metadata,
        resultText: displayResultText,
        isError,
        hasResult,
      }),
    [toolCall.name, parsedArgs, result?.metadata, displayResultText, isError, hasResult],
  );

  const diffStats = useMemo(() => {
    if (preview.kind !== 'diff') return null;
    const added = preview.blocks.reduce((sum, block) => sum + block.added, 0);
    const removed = preview.blocks.reduce((sum, block) => sum + block.removed, 0);
    return added > 0 || removed > 0 ? { added, removed } : null;
  }, [preview]);

  const running = toolCall.status === 'generating' || toolCall.status === 'executing';

  const ToolIcon = resolveToolIcon(toolCall.name, iconMap);

  const sourceText = useMemo(() => {
    if (copyTextOverride) return copyTextOverride;
    const parts: string[] = [];
    if (prettyArgs) parts.push(prettyArgs);
    if (displayResultText) parts.push(displayResultText);
    const structured = result?.metadata?.structuredContent;
    if (structured) parts.push(JSON.stringify(structured, null, 2));
    return parts.join('\n\n');
  }, [copyTextOverride, prettyArgs, displayResultText, result?.metadata?.structuredContent]);

  const toggle = () => setExpanded((value) => !value);

  const canStopTerminal =
    toolCall.name === 'terminal' &&
    toolCall.status === 'executing' &&
    typeof parsedArgs?.command === 'string';

  useEffect(() => {
    if (toolCall.status !== 'executing') setStopping(false);
  }, [toolCall.status]);

  const stopCommand = () => {
    if (stopping) return;
    setStopping(true);
    wsClient.send({ type: 'terminal.interrupt', payload: { toolCallId: toolCall.id } });
    // 后端无 ack：3s 后恢复按钮，避免命令已结束时按钮永远转圈
    window.setTimeout(() => setStopping(false), 3000);
  };

  const onCopy = async () => {
    const ok = await copyText(sourceText);
    if (!ok) {
      toast.error(t('task.messageCopyFailed'));
      return;
    }
    toast.success(t('task.messageCopied'));
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      copyTimer.current = null;
      setCopied(false);
    }, 1500);
  };

  return (
    <div className="flex flex-col">
      {/* 折叠行：沿用美化前的原始工具行样式（左侧箭头 + 图标 + 工具名） */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className={cn(
          'flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-left text-xs text-muted-foreground',
          headerClassName ?? 'px-2',
        )}
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
        />
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : isError ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <ToolIcon className="size-3.5 shrink-0" />
        )}
        <span className="max-w-[45%] shrink-0 truncate" title={toolCall.name}>
          {titleOverride ?? toolCall.name}
        </span>
        {summary && (
          <span className="min-w-0 max-w-[60%] truncate text-muted-foreground/70" title={summary}>
            {summary}
          </span>
        )}
        {diffStats && (
          <span className="shrink-0 text-[10px] tabular-nums">
            {diffStats.added > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400">+{diffStats.added}</span>
            )}
            {diffStats.added > 0 && diffStats.removed > 0 && ' '}
            {diffStats.removed > 0 && (
              <span className="text-destructive">-{diffStats.removed}</span>
            )}
          </span>
        )}
        {trailing && <span className="ml-auto shrink-0 pl-2">{trailing}</span>}
      </button>

      {expanded && (
        <div className="ml-5 flex flex-col gap-1">
          {/* 预览/源码胶囊 + 停止/复制：卡片外的工具栏 */}
          <div className="flex items-center gap-2 px-0.5">
            <ToolModeToggle mode={mode} onChange={setMode} />
            <div className="ml-auto flex items-center gap-1">
              {canStopTerminal && (
                <button
                  type="button"
                  onClick={stopCommand}
                  title={t('task.toolCard.stopCommand')}
                  aria-label={t('task.toolCard.stopCommand')}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                >
                  {stopping ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Square className="size-3.5 fill-current" />
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => void onCopy()}
                title={t('task.toolCard.copySource')}
                aria-label={t('task.toolCard.copySource')}
                disabled={!sourceText}
                className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* 展开后的内容卡：唯一卡片 */}
          <div
            className={cn(
              'overflow-hidden rounded-xl border border-border bg-card shadow-sm',
              isError && 'border-destructive/30',
            )}
          >
            <div className="pb-1.5">
              {mode === 'preview'
                ? (previewOverride ?? (
                    <PreviewBody preview={preview} hasResult={hasResult} isError={isError} />
                  ))
                : (sourceOverride ?? (
                    <SourceBody
                      toolCall={toolCall}
                      prettyArgs={prettyArgs}
                      result={result}
                      resultText={displayResultText}
                      isError={isError}
                    />
                  ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
