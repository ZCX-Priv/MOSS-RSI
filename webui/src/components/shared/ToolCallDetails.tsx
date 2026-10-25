// webui/src/components/shared/ToolCallDetails.tsx
// 工具调用卡片（主对话与子代理执行过程共用，保证图标/交互/样式一致）。
//
// 标题行：状态/工具图标 + 工具名 + 入参摘要 + diff 增删统计 + 状态文案 + 展开箭头。
// 展开区：预览/源码胶囊导航 + 复制源码；preview 走美化视图（edit/write 为 diff），
//         source 保留原始参数 JSON / 结果 / MCP structuredContent / resources。
// 默认折叠；底部居中箭头可收起。

import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { resolveToolIcon } from '@/lib/tool-icons';
import { copyText } from '../../lib/clipboard';
import { fileNameOf } from '../../render/file/detector';
import {
  buildToolPreview,
  summarizeToolCall,
  type DiffBlock,
  type DiffPreview,
  type ToolPreview,
} from '../../lib/tool-preview';
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

/** 单个文件的 diff 面板：文件头（操作 + 增删统计）+ 带行号的红绿行 */
function DiffBlockView({ block }: { block: DiffBlock }) {
  const { t } = useTranslation();
  const label =
    block.label === 'new'
      ? t('task.toolCard.newFile')
      : block.label === 'preview'
        ? t('task.toolCard.dryRunPreview')
        : t('task.toolCard.modifiedFile');

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
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
        {block.rows.map((row, index) => {
          if (row.kind === 'hunk') {
            return (
              <div
                key={index}
                className="bg-sky-500/10 px-2 py-0.5 text-sky-600 dark:text-sky-400"
              >
                {row.text}
              </div>
            );
          }
          return (
            <div
              key={index}
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
              <span className="whitespace-pre-wrap break-all text-foreground">
                {row.text || ' '}
              </span>
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
    <div className="flex flex-col gap-1.5">
      {preview.error && (
        <div className="whitespace-pre-wrap break-all rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {preview.error}
        </div>
      )}
      {preview.blocks.map((block, index) => (
        <DiffBlockView key={`${block.path}-${index}`} block={block} />
      ))}
      {preview.failures.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
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

  if (preview.kind === 'terminal') {
    const placeholder = !hasResult
      ? t('task.toolCard.pending')
      : t('task.toolCard.emptyResult');
    return (
      <div className="overflow-hidden rounded-md border border-border bg-background">
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
      <div className="overflow-hidden rounded-md border border-border bg-background">
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
      <div className="overflow-hidden rounded-md border border-border bg-background">
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
          'max-h-[300px] overflow-auto no-scrollbar whitespace-pre-wrap break-all rounded-md border border-border bg-muted/20 px-2 py-1.5 font-mono text-[11px] leading-relaxed',
          preview.isError ? 'text-destructive' : 'text-foreground',
        )}
      >
        {preview.text || t('task.toolCard.emptyResult')}
      </pre>
    );
  }

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-3 text-center text-[11px] text-muted-foreground">
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
    <div className="flex max-h-[300px] flex-col gap-2 overflow-auto no-scrollbar rounded-md border border-border bg-muted/20 p-2 text-xs">
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
}: ToolCallDetailsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<CardMode>('preview');
  const [copied, setCopied] = useState(false);
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

  const preview = useMemo(
    () =>
      buildToolPreview({
        toolName: toolCall.name,
        args: parsedArgs,
        metadata: result?.metadata,
        resultText,
        isError,
        hasResult,
      }),
    [toolCall.name, parsedArgs, result?.metadata, resultText, isError, hasResult],
  );

  const diffStats = useMemo(() => {
    if (preview.kind !== 'diff') return null;
    const added = preview.blocks.reduce((sum, block) => sum + block.added, 0);
    const removed = preview.blocks.reduce((sum, block) => sum + block.removed, 0);
    return added > 0 || removed > 0 ? { added, removed } : null;
  }, [preview]);

  const running = toolCall.status === 'generating' || toolCall.status === 'executing';
  const statusText = running
    ? t('task.toolCard.statusRunning')
    : isError
      ? t('task.toolCard.statusFailed')
      : t('task.toolCard.statusDone');
  const statusClass = running
    ? 'text-primary-strong'
    : isError
      ? 'text-destructive'
      : 'text-muted-foreground';

  const ToolIcon = resolveToolIcon(toolCall.name, iconMap);

  const sourceText = useMemo(() => {
    const parts: string[] = [];
    if (prettyArgs) parts.push(prettyArgs);
    if (resultText) parts.push(resultText);
    const structured = result?.metadata?.structuredContent;
    if (structured) parts.push(JSON.stringify(structured, null, 2));
    return parts.join('\n\n');
  }, [prettyArgs, resultText, result?.metadata?.structuredContent]);

  const toggle = () => setExpanded((value) => !value);

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
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors',
        isError && 'border-destructive/30',
      )}
    >
      {/* 标题行：点击展开/收起 */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary-strong" />
        ) : isError ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <ToolIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className="max-w-[45%] shrink-0 truncate font-mono text-[11px] font-medium text-foreground"
          title={toolCall.name}
        >
          {toolCall.name}
        </span>
        {summary && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            title={summary}
          >
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
        <span className={cn('ml-auto shrink-0 text-[10px]', statusClass)}>{statusText}</span>
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-border/60">
          {/* 预览/源码胶囊 + 复制源码 */}
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <ToolModeToggle mode={mode} onChange={setMode} />
            <button
              type="button"
              onClick={() => void onCopy()}
              title={t('task.toolCard.copySource')}
              aria-label={t('task.toolCard.copySource')}
              disabled={!sourceText}
              className="ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>

          <div className="px-2.5 pb-1.5">
            {mode === 'preview' ? (
              <PreviewBody preview={preview} hasResult={hasResult} isError={isError} />
            ) : (
              <SourceBody
                toolCall={toolCall}
                prettyArgs={prettyArgs}
                result={result}
                resultText={resultText}
                isError={isError}
              />
            )}
          </div>

          {/* 底部居中收起 */}
          <button
            type="button"
            onClick={toggle}
            aria-label={t('task.toolCard.collapse')}
            title={t('task.toolCard.collapse')}
            className="flex w-full items-center justify-center border-t border-border/60 py-1 text-muted-foreground transition-colors hover:bg-muted/40"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
});
