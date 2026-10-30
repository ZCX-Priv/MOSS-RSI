// webui/src/components/shared/RunCodeCard.tsx
// run_code 步骤呈现：一行「# 代码 · 说明」折叠行 + 常显的执行结果。
// - 代码默认收起；失败时自动展开源码。
// - 结果区不再使用卡片/页签/固定高度：嵌套调用一行一条，日志收进 details，
//   Intelligent UI 直接渲染在消息流里（与正文连成一体）。
// - 程序源码来自 toolCall.arguments（流式期间容错提取），UI 规格来自 result.metadata.codeRun。
// - 历史回放：metadata 随 tool 消息持久化，刷新后仍能还原界面与调用记录。

import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, CircleAlert, Hash, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveToolIcon } from '@/lib/tool-icons';
import { CodeBlock, GenUIRenderer } from '../../render';
import type { CodeRunCall, ToolCall, ToolResult } from '../../types/api';

interface RunCodeCardProps {
  toolCall: ToolCall;
  result?: ToolResult;
  fallbackText?: string;
  fallbackIsError?: boolean;
  iconMap: Record<string, string>;
}

interface ParsedArgs {
  code?: string;
  description?: string;
  partial: boolean;
}

export const RunCodeCard = memo(function RunCodeCard({
  toolCall,
  result,
  fallbackText,
  fallbackIsError,
  iconMap,
}: RunCodeCardProps) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parseRunCodeArgs(toolCall.arguments), [toolCall.arguments]);
  const meta = result?.metadata?.codeRun;
  const status = toolCall.status ?? 'done';
  const isError = result?.isError === true || (status === 'done' && fallbackIsError === true);
  const bodyText = useMemo(() => resultText(result, fallbackText), [result, fallbackText]);
  const errorSummary = isError ? firstErrorLine(bodyText) : '';
  const description = parsed.description || meta?.description || errorSummary || t('task.runCode.title');
  const hasCode = typeof parsed.code === 'string' && parsed.code.trim().length > 0;

  // 代码默认收起（结果常显）；失败时自动展开，便于定位。
  const [codeOpen, setCodeOpen] = useState(false);
  useEffect(() => {
    if (isError && hasCode) setCodeOpen(true);
  }, [isError, hasCode]);

  const running = status === 'generating' || status === 'executing';
  const calls = meta?.calls ?? [];
  const logs = meta?.logs ?? [];
  const diagnostics = meta?.uiDiagnostics ?? [];
  const valuePreview = meta?.valuePreview;
  const uiSpec = meta?.uiSpec;
  // 有界面时以界面为主，不再重复展示「返回值 ok」这类状态串
  const showValuePreview = !!valuePreview && !uiSpec;
  const hasCompactRows = calls.length > 0 || logs.length > 0 || showValuePreview || diagnostics.length > 0;
  const showCompactRows = !running && hasCompactRows;
  const kindLabel =
    meta?.kind === 'ui'
      ? t('task.runCode.kindUi')
      : meta?.kind === 'hybrid'
        ? t('task.runCode.kindHybrid')
        : meta?.kind === 'text'
          ? t('task.runCode.kindText')
          : '';

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* 折叠行：点击只控制程序源码显隐，结果区始终在下方 */}
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => {
            if (hasCode) setCodeOpen((value) => !value);
          }}
          aria-expanded={hasCode ? codeOpen : undefined}
          aria-label={codeOpen ? t('task.runCode.collapseCode') : t('task.runCode.expandCode')}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors',
            hasCode ? 'cursor-pointer hover:bg-muted/40' : 'cursor-default',
            isError ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              codeOpen && 'rotate-90',
              !hasCode && 'opacity-40',
            )}
          />
          <Hash className="size-3.5 shrink-0" />
          <span className={cn('shrink-0 font-medium', isError ? 'text-destructive' : 'text-foreground/80')}>
            {t('task.runCode.code')}
          </span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate">{description}</span>
        </button>
        <RunStatusText
          status={status}
          isError={isError}
          durationMs={meta?.durationMs}
          kindLabel={kindLabel}
          truncated={meta?.truncated === true}
        />
      </div>

      {codeOpen && parsed.code && (
        <CodeBlock code={parsed.code} lang="ts" closed={!parsed.partial} variant="inline" />
      )}

      {showCompactRows && (
        <div className="flex min-w-0 flex-col gap-1.5 pl-1">
          {calls.length > 0 && (
            <div className="flex min-w-0 flex-col gap-0.5">
              {calls.map((call) => (
                <CallRow key={call.id} call={call} iconMap={iconMap} />
              ))}
              {meta?.callsTruncated && (
                <div className="text-[11px] text-muted-foreground">{t('task.runCode.callsTruncated')}</div>
              )}
            </div>
          )}
          {logs.length > 0 && (
            <details className="group/logs">
              <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                <ChevronRight className="size-3 shrink-0 transition-transform group-open/logs:rotate-90" />
                {t('task.runCode.logsCount', { count: logs.length })}
              </summary>
              <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
                {logs.join('\n')}
              </pre>
            </details>
          )}
          {showValuePreview && (
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="text-[11px] text-muted-foreground/70">{t('task.runCode.resultValue')}</div>
              <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
                {valuePreview}
              </pre>
            </div>
          )}
          {diagnostics.length > 0 && (
            <details className="group/diag">
              <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                <ChevronRight className="size-3 shrink-0 transition-transform group-open/diag:rotate-90" />
                {t('task.runCode.diagnostics', { count: diagnostics.length })}
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                {diagnostics.slice(0, 20).map((d, index) => (
                  <li key={index} className="break-words">
                    <span className="font-mono">{d.code}</span> @ {d.path}
                    {d.detail ? ` — ${d.detail}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {isError && (
        <div className="flex min-w-0 items-start gap-1.5 pl-1 text-[11px] text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <pre className="max-h-[240px] min-w-0 overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed">
            {bodyText || t('task.runCode.failed')}
          </pre>
        </div>
      )}

      {/* Intelligent UI：直接渲染在消息流里，不包卡片、不加内边距 */}
      {uiSpec && (
        <div className="mt-0.5 min-w-0">
          <GenUIRenderer spec={uiSpec} />
        </div>
      )}
    </div>
  );
});

/** 右上角状态：生成/执行/失败/完成（含耗时、输出类型、截断标记） */
function RunStatusText({
  status,
  isError,
  durationMs,
  kindLabel,
  truncated,
}: {
  status: NonNullable<ToolCall['status']>;
  isError: boolean;
  durationMs?: number;
  kindLabel: string;
  truncated: boolean;
}) {
  const { t } = useTranslation();
  if (status === 'generating') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {t('task.runCode.generating')}
      </span>
    );
  }
  if (status === 'executing') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {t('task.runCode.running')}
      </span>
    );
  }
  if (isError) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-destructive">
        <X className="size-3" />
        {t('task.runCode.failed')}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
      {t('task.runCode.completed')}
      {durationMs != null && (
        <>
          <span>·</span>
          <span className="tabular-nums">{durationMs}ms</span>
        </>
      )}
      {kindLabel && (
        <>
          <span>·</span>
          <span>{kindLabel}</span>
        </>
      )}
      {truncated && (
        <span className="text-amber-600 dark:text-amber-400">{t('task.runCode.truncated')}</span>
      )}
    </span>
  );
}

/** 单条嵌套工具调用：一行折叠，点开看参数/结果/错误 */
function CallRow({ call, iconMap }: { call: CodeRunCall; iconMap: Record<string, string> }) {
  const { t } = useTranslation();
  const Icon = resolveToolIcon(call.name, iconMap);
  return (
    <details className="group/call">
      {/* 折叠行与常规工具调用（ToolCallDetails）同构：箭头 + 状态/工具图标 + 工具名 + 入参摘要 + 耗时 */}
      <summary className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/call:rotate-90" />
        {call.ok ? (
          <Icon className="size-3.5 shrink-0" />
        ) : (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="max-w-[45%] shrink-0 truncate text-foreground/80" title={call.name}>
          {call.name}
        </span>
        {call.argsPreview && (
          <span className="min-w-0 max-w-[60%] truncate text-muted-foreground/70" title={call.argsPreview}>
            {call.argsPreview}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums">{call.durationMs}ms</span>
      </summary>
      {/* 展开区：常规工具调用的卡片容器（参数 / 结果 / 错误三段） */}
      <div className="mt-1 ml-5 flex min-w-0 flex-col">
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="mx-2.5 my-1 flex max-h-[300px] flex-col gap-2 overflow-auto no-scrollbar bg-muted/20 p-2 text-xs">
            {call.argsPreview && (
              <div>
                <div className="text-muted-foreground/70">{t('task.toolCallArguments')}</div>
                <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-foreground">{call.argsPreview}</pre>
              </div>
            )}
            {call.resultPreview && (
              <div>
                <div className="text-muted-foreground/70">{t('task.result')}</div>
                <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-foreground">{call.resultPreview}</pre>
              </div>
            )}
            {call.error && (
              <div>
                <div className="text-destructive/80">{t('task.errorResult')}</div>
                <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-destructive">{call.error}</pre>
              </div>
            )}
            {!call.argsPreview && !call.resultPreview && !call.error && (
              <div className="text-muted-foreground">{t('task.toolCard.emptyResult')}</div>
            )}
          </div>
        </div>
      </div>
    </details>
  );
}

function resultText(result: ToolResult | undefined, fallback?: string): string {
  if (!result) return fallback ?? '';
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');
  return text || fallback || '';
}

/** 失败摘要：优先取 [run_code] 首行之后的错误消息，否则取第一行 */
function firstErrorLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  const first = lines[0];
  const message = first.startsWith('[run_code]') ? (lines[1] ?? '') : first;
  return message.slice(0, 160);
}

// ============================================================================
// 参数解析（完整 JSON / 流式半成品容错提取）
// ============================================================================

function parseRunCodeArgs(raw: string): ParsedArgs {
  if (!raw) return { partial: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        code: typeof obj.code === 'string' ? obj.code : undefined,
        description: typeof obj.description === 'string' ? obj.description : undefined,
        partial: false,
      };
    }
  } catch {
    // 流式中：走容错提取
  }
  return {
    code: extractJsonStringField(raw, 'code'),
    description: extractJsonStringField(raw, 'description'),
    partial: true,
  };
}

/** 从（可能未闭合的）JSON 字符串里提取一个字符串字段的值 */
function extractJsonStringField(raw: string, field: string): string | undefined {
  const key = `"${field}"`;
  const keyIndex = raw.indexOf(key);
  if (keyIndex < 0) return undefined;
  const colon = raw.indexOf(':', keyIndex + key.length);
  if (colon < 0) return undefined;
  let i = colon + 1;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (raw[i] !== '"') return undefined;
  i += 1;
  let out = '';
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === undefined) break;
      out += unescapeJsonChar(raw, i);
      i += unescapeLength(raw, i);
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i += 1;
  }
  return out;
}

function unescapeLength(raw: string, index: number): number {
  return raw[index + 1] === 'u' ? 6 : 2;
}

function unescapeJsonChar(raw: string, index: number): string {
  const next = raw[index + 1];
  switch (next) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case '"':
      return '"';
    case '\\':
      return '\\';
    case '/':
      return '/';
    case 'u': {
      const hex = raw.slice(index + 2, index + 6);
      if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      return '';
    }
    default:
      return next ?? '';
  }
}
