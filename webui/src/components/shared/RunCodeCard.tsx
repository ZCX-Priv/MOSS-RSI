// webui/src/components/shared/RunCodeCard.tsx
// PTC 复合块（不是普通工具卡）：程序卡片 + 工具调用折叠行 + Intelligent UI。
// - 程序卡片：复用 ToolCallDetails 的卡片外壳，头部显示「代码 · 说明 · 状态」，
//   展开后「预览」页签只放返回值 / 日志 / 诊断 / 错误，「源码」页签放程序源码。
// - 工具调用：每条直接复用 ToolCallDetails，与原生工具行的标题/摘要/hover/展开卡片完全同源。
// - Intelligent UI：仅程序卡片展开时懒加载渲染；折叠态只显示「含交互界面」徽标。
// - 执行中通过 toolCall.live 展示实时嵌套调用/日志与 ms/s/min 计时。
// - 程序源码/大 JSON 只在展开时解析；轻量历史结果展开时按 toolCallId 拉取完整 metadata。

import { lazy, memo, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, Loader2, X } from 'lucide-react';
import { CodeBlock } from '../../render';
import { ToolCallDetails } from './ToolCallDetails';
import { useLazyToolResult } from '../../lib/lazy-tool-results';
import { useStore } from '../../store';
import { formatDuration } from '../../lib/format-duration';
import type { CodeRunCall, CodeRunMetadata, ToolCall, ToolResult } from '../../types/api';

/** IntelligentUI 渲染器懒加载：只有程序卡片展开且确有 spec 时才拉 catalog/chart 等重模块 */
const GenUIRenderer = lazy(() =>
  import('../../render/genui/GenUIRenderer').then((m) => ({ default: m.GenUIRenderer })),
);

interface RunCodeCardProps {
  toolCall: ToolCall;
  result?: ToolResult;
  fallbackText?: string;
  fallbackIsError?: boolean;
  iconMap: Record<string, string>;
  /** 懒加载结果所属会话（子代理卡片传入自己的 session；缺省 store.activeSessionId） */
  sessionId?: string;
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
  sessionId,
}: RunCodeCardProps) {
  const { t } = useTranslation();
  const activeSessionId = useStore((s) => s.activeSessionId);
  const resultSessionId = sessionId ?? activeSessionId ?? undefined;
  const [open, setOpen] = useState(false);
  const [nestedOpenIds, setNestedOpenIds] = useState<Set<string>>(new Set());
  // 历史轻量投影只保留 hasUi（不含 uiSpec）：折叠态也要按需补拉完整结果，
  // 保证刷新后 IntelligentUI 仍显示在折叠代码卡下方（与对话流一致）。
  const hasUiFromResult =
    result?.metadata?.codeRun?.hasUi === true ||
    result?.metadata?.codeRun?.uiSpec !== undefined;
  // 程序卡片或任一嵌套调用展开时，才按需拉取完整的 codeRun metadata（含 uiSpec/日志）
  const hydratedResult = useLazyToolResult(
    resultSessionId,
    toolCall.id,
    result,
    open || nestedOpenIds.size > 0 || hasUiFromResult,
  );
  // 大 JSON 源码只在展开时解析；折叠态不解析 20KB~ 的程序参数
  const parsed: ParsedArgs = useMemo(
    () => (open ? parseRunCodeArgs(toolCall.arguments) : { partial: true }),
    [open, toolCall.arguments],
  );
  const meta = hydratedResult?.metadata?.codeRun;
  const status = toolCall.status ?? 'done';
  const isError =
    hydratedResult?.isError === true || (status === 'done' && fallbackIsError === true);
  const bodyText = open ? resultText(hydratedResult, fallbackText) : '';
  // 结果即完成：已拿到最终结果时，残留的 executing 不得继续显示「正在运行」
  const hasResult = hydratedResult !== undefined || fallbackText !== undefined;
  const running = !hasResult && (status === 'generating' || status === 'executing');
  const hasCode = typeof parsed.code === 'string' && parsed.code.trim().length > 0;
  const liveCalls = toolCall.live?.calls ?? [];
  const calls = sortCallsBySeq(meta?.calls?.length ? meta.calls : liveCalls);
  const hasUi = hasUiFromResult || meta?.uiSpec !== undefined;

  // 执行中本地 ticker：仅运行中的卡片启动（避免每个历史卡片都挂定时器）。
  // 耗时按秒展示，1s 刷新即可；250ms 会让整卡（含嵌套调用）每秒重渲染 4 次。
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => forceTick((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const startedAtMs = toolCall.live?.startedAtMs;
  const liveElapsedMs =
    running && startedAtMs !== undefined ? Math.max(0, Date.now() - startedAtMs) : undefined;

  // 运行中还没有最终 metadata 时，用 live 日志构造一个只读预览（不伪造返回/诊断）
  const displayMeta: CodeRunMetadata | undefined =
    meta ??
    (toolCall.live
      ? {
          version: 1,
          kind: 'text',
          description: '',
          logs: toolCall.live.logs,
          calls: [],
          durationMs: liveElapsedMs ?? 0,
        }
      : undefined);
  const preview =
    open && displayMeta ? (
      <RunCodeResultPreview meta={displayMeta} isError={isError} running={running} bodyText={bodyText} />
    ) : undefined;
  const source = open && hasCode ? (
    <CodeBlock code={parsed.code ?? ''} lang="ts" closed={!parsed.partial} variant="inline" />
  ) : undefined;

  const setNestedOpen = (id: string, expanded: boolean): void => {
    setNestedOpenIds((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-1">
      {/* 程序卡片：预览 = 文本结果，源码 = 程序代码；默认折叠，与普通工具一致 */}
      <ToolCallDetails
        toolCall={toolCall}
        result={hydratedResult}
        fallbackText={fallbackText}
        fallbackIsError={fallbackIsError}
        iconMap={iconMap}
        sessionId={resultSessionId}
        headerClassName="pl-1 pr-2"
        titleOverride={t('task.runCode.code')}
        expanded={open}
        onExpandedChange={setOpen}
        trailing={
          <RunStatusText
            status={status}
            isError={isError}
            durationMs={meta?.durationMs}
            liveElapsedMs={liveElapsedMs}
            truncated={meta?.truncated === true}
            hasUi={hasUi}
          />
        }
        previewOverride={preview}
        sourceOverride={source}
        copyTextOverride={open && hasCode ? parsed.code : undefined}
      />

      {/* 工具调用：直接复用普通工具调用卡片，与原生 tool 行完全同源同构 */}
      {calls.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {calls.map((call) => {
            // 父程序结束后不再有「运行中」的嵌套调用（最终 metadata 才是权威）
            const view = nestedToolView(call, running);
            return (
              <ToolCallDetails
                key={call.id}
                toolCall={view.toolCall}
                result={view.result}
                iconMap={iconMap}
                sessionId={resultSessionId}
                onExpandedChange={(expanded) => setNestedOpen(call.id, expanded)}
              />
            );
          })}
          {meta?.callsTruncated && (
            <div className="text-[11px] text-muted-foreground">{t('task.runCode.callsTruncated')}</div>
          )}
        </div>
      )}

      {/* IntelligentUI：折叠代码卡也常显（历史投影 hasUi=true 时自动补拉 spec）；
          仅程序卡片展开时才懒加载渲染器属于旧行为，刷新后图表会被收进折叠区 */}
      {meta?.uiSpec && !isError && (
        <div className="mt-0.5 ml-1 min-w-0">
          <Suspense
            fallback={
              <div className="text-[11px] text-muted-foreground">{t('task.runCode.loadingUi')}</div>
            }
          >
            <GenUIRenderer spec={meta.uiSpec} />
          </Suspense>
        </div>
      )}
    </div>
  );
});

/** 按调用开始序号 seq 排序（完成顺序会被并行调用打乱；旧历史无 seq 时保持原序） */
function sortCallsBySeq<T extends { id: string; seq?: number }>(list: readonly T[]): T[] {
  return list
    .map((call, index) => ({ call, index }))
    .sort((a, b) => {
      const sa = a.call.seq;
      const sb = b.call.seq;
      if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb;
      if (sa !== undefined && sb === undefined) return -1;
      if (sa === undefined && sb !== undefined) return 1;
      // 两侧都无 seq（旧历史）→ 保持原数组顺序
      return a.index - b.index;
    })
    .map((entry) => entry.call);
}

/** 合成普通 ToolCall/ToolResult：优先使用后端富数据，旧会话/执行中回退 preview 字段 */
function nestedToolView(
  call: CodeRunCall & { status?: 'running' | 'done' | 'failed' },
  parentRunning: boolean,
): {
  toolCall: ToolCall;
  result?: ToolResult;
} {
  // 只有「父程序仍在运行 + 该调用明确 running + 尚无任何结果」才算执行中；
  // 父程序已结束（含 metadata 已落库）时迟到的 progress 不得让嵌套行继续转圈。
  const hasOk = (call as { ok?: boolean }).ok;
  const running =
    parentRunning &&
    call.status === 'running' &&
    hasOk === undefined &&
    !call.error &&
    !call.resultText;
  const failed = !running && (call.status === 'failed' || hasOk === false);
  const text = call.resultText ?? (hasOk ? call.resultPreview : call.error ?? call.resultPreview);
  return {
    toolCall: {
      id: call.id,
      name: call.name,
      arguments: call.argumentsJson ?? call.argsPreview,
      status: running ? 'executing' : 'done',
    },
    // 执行中还没有结果：只显示标题行 + 转圈，避免伪造空结果
    ...(running
      ? {}
      : {
          result: {
            content: [{ type: 'text', text }],
            ...(failed ? { isError: true } : {}),
            ...(call.resultMetadata ? { metadata: call.resultMetadata } : {}),
          },
        }),
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
            {diagnostics.map((d, index) => (
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

/** 头部右侧状态：生成/执行/失败/完成（含耗时、截断标记） */
function RunStatusText({
  status,
  isError,
  durationMs,
  liveElapsedMs,
  truncated,
  hasUi,
}: {
  status: NonNullable<ToolCall['status']>;
  isError: boolean;
  durationMs?: number;
  /** 执行中实时已用时（ms；仅 running 时存在） */
  liveElapsedMs?: number;
  truncated: boolean;
  hasUi: boolean;
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
        {liveElapsedMs !== undefined && (
          <>
            <span>·</span>
            <span className="tabular-nums">{formatDuration(liveElapsedMs)}</span>
          </>
        )}
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
          <span className="tabular-nums">{formatDuration(durationMs)}</span>
        </>
      )}
      {hasUi && (
        <>
          <span>·</span>
          <span className="text-sky-600 dark:text-sky-400">{t('task.runCode.uiBadge')}</span>
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
