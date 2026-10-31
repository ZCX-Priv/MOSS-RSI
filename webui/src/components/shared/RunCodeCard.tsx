// webui/src/components/shared/RunCodeCard.tsx
// PTC 复合块（不是普通工具卡）：程序卡片 + 工具调用折叠行 + Intelligent UI。
// - 程序卡片：复用 ToolCallDetails 的卡片外壳，头部显示「代码 · 说明 · 状态」，
//   展开后「预览」页签只放返回值 / 日志 / 诊断 / 错误，「源码」页签放程序源码。
// - 工具调用：每条直接复用 ToolCallDetails，与原生工具行的标题/摘要/hover/展开卡片完全同源。
// - Intelligent UI：始终渲染在工具调用行之后，不依赖程序卡片展开。
// - 程序源码来自 toolCall.arguments（流式期间容错提取），UI 规格来自 result.metadata.codeRun。

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, Loader2, X } from 'lucide-react';
import { CodeBlock, GenUIRenderer } from '../../render';
import { ToolCallDetails } from './ToolCallDetails';
import type { CodeRunCall, CodeRunMetadata, ToolCall, ToolResult } from '../../types/api';

interface RunCodeCardProps {
  toolCall: ToolCall;
  result?: ToolResult;
  fallbackText?: string;
  fallbackIsError?: boolean;
  iconMap: Record<string, string>;
}

interface ParsedArgs {
  code?: string;
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
  const running = status === 'generating' || status === 'executing';
  const hasCode = typeof parsed.code === 'string' && parsed.code.trim().length > 0;
  const calls = meta?.calls ?? [];
  const kindLabel =
    meta?.kind === 'ui'
      ? t('task.runCode.kindUi')
      : meta?.kind === 'hybrid'
        ? t('task.runCode.kindHybrid')
        : meta?.kind === 'text'
          ? t('task.runCode.kindText')
          : '';

  const preview = meta ? (
    <RunCodeResultPreview meta={meta} isError={isError} running={running} bodyText={bodyText} />
  ) : undefined;
  const source = hasCode ? (
    <CodeBlock code={parsed.code ?? ''} lang="ts" closed={!parsed.partial} variant="inline" />
  ) : undefined;

  return (
    <div className="flex flex-col gap-1">
      {/* 程序卡片：预览 = 文本结果，源码 = 程序代码；默认折叠，与普通工具一致 */}
      <ToolCallDetails
        toolCall={toolCall}
        result={result}
        fallbackText={fallbackText}
        fallbackIsError={fallbackIsError}
        iconMap={iconMap}
        headerClassName="pl-1 pr-2"
        titleOverride={t('task.runCode.code')}
        trailing={
          <RunStatusText
            status={status}
            isError={isError}
            durationMs={meta?.durationMs}
            kindLabel={kindLabel}
            truncated={meta?.truncated === true}
          />
        }
        previewOverride={preview}
        sourceOverride={source}
        copyTextOverride={hasCode ? parsed.code : undefined}
      />

      {/* 工具调用：直接复用普通工具调用卡片，与原生 tool 行完全同源同构 */}
      {calls.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {calls.map((call) => {
            const view = nestedToolView(call);
            return (
              <ToolCallDetails
                key={call.id}
                toolCall={view.toolCall}
                result={view.result}
                iconMap={iconMap}
              />
            );
          })}
          {meta?.callsTruncated && (
            <div className="text-[11px] text-muted-foreground">{t('task.runCode.callsTruncated')}</div>
          )}
        </div>
      )}

      {/* Intelligent UI：常显，不依赖程序卡片展开 */}
      {meta?.uiSpec && (
        <div className="mt-0.5 ml-1 min-w-0">
          <GenUIRenderer spec={meta.uiSpec} />
        </div>
      )}
    </div>
  );
});

/** 合成普通 ToolCall/ToolResult：优先使用后端富数据，旧会话回退 preview 字段 */
function nestedToolView(call: CodeRunCall): { toolCall: ToolCall; result: ToolResult } {
  const text = call.resultText ?? (call.ok ? call.resultPreview : call.error ?? call.resultPreview);
  return {
    toolCall: {
      id: call.id,
      name: call.name,
      arguments: call.argumentsJson ?? call.argsPreview,
      status: 'done',
    },
    result: {
      content: [{ type: 'text', text }],
      isError: !call.ok,
      ...(call.resultMetadata ? { metadata: call.resultMetadata } : {}),
    },
  };
}

/** 程序卡片「预览」页签：返回值 / 日志 / 诊断 / 错误（Intelligent UI 在卡片下方常显） */
function RunCodeResultPreview({
  meta,
  isError,
  running,
  bodyText,
}: {
  meta: CodeRunMetadata;
  isError: boolean;
  running: boolean;
  bodyText: string;
}) {
  const { t } = useTranslation();
  const uiSpec = meta.uiSpec;
  const logs = meta.logs;
  const diagnostics = meta.uiDiagnostics ?? [];
  const valuePreview = meta.valuePreview;
  const showValuePreview = !!valuePreview;
  const hasTextOutput = isError || showValuePreview || logs.length > 0 || diagnostics.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-2 px-2.5 py-1.5">
      {isError && (
        <div className="flex min-w-0 items-start gap-1.5 text-[11px] text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <pre className="max-h-[240px] min-w-0 overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed">
            {bodyText || t('task.runCode.failed')}
          </pre>
        </div>
      )}
      {showValuePreview && (
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-[11px] text-muted-foreground/70">{t('task.runCode.resultValue')}</div>
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
            {valuePreview}
          </pre>
        </div>
      )}
      {logs.length > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-[11px] text-muted-foreground">
            {t('task.runCode.logsCount', { count: logs.length })}
          </div>
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
            {logs.join('\n')}
          </pre>
        </div>
      )}
      {diagnostics.length > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-[11px] text-amber-600 dark:text-amber-400">
            {t('task.runCode.diagnostics', { count: diagnostics.length })}
          </div>
          <ul className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
            {diagnostics.slice(0, 20).map((d, index) => (
              <li key={index} className="break-words">
                <span className="font-mono">{d.code}</span> @ {d.path}
                {d.detail ? ` — ${d.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!hasTextOutput && (
        <div className="text-[11px] text-muted-foreground">
          {running
            ? t('task.toolCard.pending')
            : uiSpec
              ? t('task.runCode.uiBelow')
              : t('task.toolCard.emptyResult')}
        </div>
      )}
    </div>
  );
}

/** 头部右侧状态：生成/执行/失败/完成（含耗时、输出类型、截断标记） */
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
        partial: false,
      };
    }
  } catch {
    // 流式中：走容错提取
  }
  return {
    code: extractJsonStringField(raw, 'code'),
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
