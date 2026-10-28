// webui/src/components/shared/RunCodeCard.tsx
// run_code 专属工具卡片：程序 / 日志 / 工具调用 / 界面 四个页签。
// 程序源码来自 toolCall.arguments（流式期间容错提取），UI 规格来自 result.metadata.codeRun。
// 历史回放：metadata 随 tool 消息持久化，刷新后 RunCodeCard 仍能还原界面与调用记录。

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  Loader2,
  ListChecks,
  Monitor,
  ScrollText,
  SquareCode,
  X,
} from 'lucide-react';
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

type TabKey = 'ui' | 'code' | 'logs' | 'calls';

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
  const [expanded, setExpanded] = useState(true);
  const [tab, setTab] = useState<TabKey>('code');
  const userSelectedTab = useRef(false);

  // 结果到达后默认切到「界面」（用户手动选过页签则不打扰）
  useEffect(() => {
    if (meta?.uiSpec && !userSelectedTab.current) setTab('ui');
  }, [meta?.uiSpec]);

  const status = toolCall.status ?? 'done';
  const isError = result?.isError === true || (status === 'done' && fallbackIsError === true);
  const description = parsed.description || meta?.description || t('task.runCode.title');
  const Icon = resolveToolIcon('run_code', iconMap) ?? SquareCode;

  const selectTab = (next: TabKey) => {
    userSelectedTab.current = true;
    setTab(next);
  };

  const tabs: Array<{ key: TabKey; label: string; icon: typeof Code2; show: boolean }> = [
    { key: 'ui', label: t('task.runCode.tabUi'), icon: Monitor, show: !!meta?.uiSpec },
    { key: 'code', label: t('task.runCode.tabCode'), icon: Code2, show: true },
    { key: 'logs', label: t('task.runCode.tabLogs'), icon: ScrollText, show: true },
    { key: 'calls', label: t('task.runCode.tabCalls'), icon: ListChecks, show: true },
  ];

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-card shadow-sm',
        isError ? 'border-destructive/50' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
        aria-expanded={expanded}
      >
        <Icon className={cn('size-4 shrink-0', isError ? 'text-destructive' : 'text-primary-strong')} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs font-medium text-foreground">{t('task.runCode.cardTitle')}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">{description}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <StatusText status={status} isError={isError} />
            {meta?.durationMs != null && (
              <>
                <span>·</span>
                <span className="tabular-nums">{meta.durationMs}ms</span>
              </>
            )}
            {meta?.kind && (
              <>
                <span>·</span>
                <span>
                  {meta.kind === 'ui'
                    ? t('task.runCode.kindUi')
                    : meta.kind === 'hybrid'
                      ? t('task.runCode.kindHybrid')
                      : t('task.runCode.kindText')}
                </span>
              </>
            )}
            {meta?.truncated && (
              <>
                <span>·</span>
                <span className="text-amber-600 dark:text-amber-400">{t('task.runCode.truncated')}</span>
              </>
            )}
          </div>
        </div>
        <ChevronRight
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
        />
      </button>

      {expanded && (
        <div className="border-t border-border/70">
          {(status === 'generating' || status === 'executing') && (
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span>{status === 'generating' ? t('task.runCode.generating') : t('task.runCode.running')}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
            {tabs.filter((item) => item.show).map((item) => {
              const TabIcon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => selectTab(item.key)}
                  className={cn(
                    'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] transition-colors',
                    tab === item.key
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <TabIcon className="size-3" />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="max-h-[520px] overflow-auto">
            {tab === 'ui' && meta?.uiSpec && <GenUIRenderer spec={meta.uiSpec} className="p-3" />}
            {tab === 'code' && (
              <div className="p-0">
                {parsed.code ? (
                  <CodeBlock code={parsed.code} lang="ts" closed={!parsed.partial} />
                ) : (
                  <div className="px-3 py-3 text-xs text-muted-foreground">{t('task.runCode.noCode')}</div>
                )}
              </div>
            )}
            {tab === 'logs' && <LogsPanel logs={meta?.logs ?? []} emptyText={t('task.runCode.noLogs')} />}
            {tab === 'calls' && (
              <CallsPanel
                calls={meta?.calls ?? []}
                truncated={meta?.callsTruncated === true}
                emptyText={t('task.runCode.noCalls')}
              />
            )}
          </div>

          {isError && (
            <div className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap break-words">
                {resultText(result, fallbackText) || t('task.runCode.failed')}
              </span>
            </div>
          )}

          {meta?.uiDiagnostics && meta.uiDiagnostics.length > 0 && (
            <details className="border-t border-border/60 px-3 py-2">
              <summary className="cursor-pointer text-[11px] text-amber-600 dark:text-amber-400">
                {t('task.runCode.diagnostics', { count: meta.uiDiagnostics.length })}
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                {meta.uiDiagnostics.slice(0, 20).map((d, index) => (
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
    </div>
  );
});

function StatusText({ status, isError }: { status: NonNullable<ToolCall['status']>; isError: boolean }) {
  const { t } = useTranslation();
  if (status === 'generating') {
    return (
      <span className="inline-flex items-center gap-1">
        <Loader2 className="size-3 animate-spin" />
        {t('task.runCode.generating')}
      </span>
    );
  }
  if (status === 'executing') {
    return (
      <span className="inline-flex items-center gap-1">
        <Loader2 className="size-3 animate-spin" />
        {t('task.runCode.running')}
      </span>
    );
  }
  if (isError) {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <X className="size-3" />
        {t('task.runCode.failed')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
      <Check className="size-3" />
      {t('task.runCode.completed')}
    </span>
  );
}

function LogsPanel({ logs, emptyText }: { logs: string[]; emptyText: string }) {
  if (logs.length === 0) {
    return <div className="px-3 py-3 text-xs text-muted-foreground">{emptyText}</div>;
  }
  return (
    <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
      {logs.join('\n')}
    </pre>
  );
}

function CallsPanel({
  calls,
  truncated,
  emptyText,
}: {
  calls: CodeRunCall[];
  truncated: boolean;
  emptyText: string;
}) {
  const { t } = useTranslation();
  if (calls.length === 0) {
    return <div className="px-3 py-3 text-xs text-muted-foreground">{emptyText}</div>;
  }
  return (
    <div className="flex flex-col divide-y divide-border/60">
      {calls.map((call) => (
        <details key={call.id} className="group px-3 py-1.5">
          <summary className="flex cursor-pointer items-center gap-2 text-xs">
            {call.ok ? (
              <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <X className="size-3 shrink-0 text-destructive" />
            )}
            <span className="font-mono text-foreground">{call.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{call.argsPreview}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{call.durationMs}ms</span>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-1 flex flex-col gap-1 pl-5 text-[11px] text-muted-foreground">
            <div className="break-words">
              <span className="text-foreground/70">{t('task.runCode.callArgs')}: </span>
              <span className="font-mono">{call.argsPreview}</span>
            </div>
            <div className="break-words">
              <span className="text-foreground/70">{t('task.runCode.callResult')}: </span>
              <span className="font-mono">{call.resultPreview || '—'}</span>
            </div>
            {call.error && (
              <div className="break-words text-destructive">
                <span>{t('task.runCode.callError')}: </span>
                <span className="font-mono">{call.error}</span>
              </div>
            )}
          </div>
        </details>
      ))}
      {truncated && (
        <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('task.runCode.callsTruncated')}</div>
      )}
    </div>
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
