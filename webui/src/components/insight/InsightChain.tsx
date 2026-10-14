// webui/src/components/insight/InsightChain.tsx
// 链路式诊断渲染：取证/分析步骤链 + 思考折叠 + 结论正文（流式 Markdown）+ 重新生成。
// 由父级 DialogBody 提供固定高度滚动区。

import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { MarkdownRenderer } from '@/render';
import { Button } from '@/components/ui/button';
import type { InsightStreamState } from '@/hooks/useInsightStream';

function StepMark({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'running') return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary-strong" />;
  if (status === 'error') return <AlertCircle className="size-3.5 shrink-0 text-destructive" />;
  return <Check className="size-3.5 shrink-0 text-emerald-500" />;
}

export function InsightChain({ state, onRerun }: { state: InsightStreamState; onRerun: () => void }) {
  const { t } = useTranslation();
  const { steps, thinking, text, status, error } = state;
  const running = status === 'running';

  return (
    <div className="flex flex-col gap-3">
      {/* 思考（默认折叠；流式中展示进行态标签） */}
      {thinking && (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
            {running ? t('insight.thinkingRunning') : t('insight.thinking')}
          </summary>
          <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs leading-relaxed text-muted-foreground">
            {thinking}
          </div>
        </details>
      )}

      {/* 取证 / 分析步骤链（竖向连接线） */}
      {steps.length > 0 && (
        <ol className="flex flex-col">
          {steps.map((s, i) => (
            <li key={s.id} className="relative flex gap-2.5 pb-3 last:pb-0">
              {i < steps.length - 1 && (
                <span className="absolute left-[6px] top-4 h-full w-px bg-border" aria-hidden />
              )}
              <span className="mt-0.5">
                <StepMark status={s.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-foreground">
                  {t(`insight.step.${s.kind}`, { defaultValue: s.kind })}
                </div>
                {s.detail && (
                  <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">{s.detail}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* 结论正文（流式 Markdown） */}
      {text ? (
        <div className="text-sm text-foreground">
          <MarkdownRenderer text={text} streaming={running} />
        </div>
      ) : running ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('insight.running')}
        </div>
      ) : status === 'done' ? (
        <div className="py-2 text-center text-sm text-muted-foreground">{t('insight.empty')}</div>
      ) : null}

      {/* 错误提示 */}
      {status === 'error' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {t('insight.failed')}：{error}
        </div>
      )}

      {/* 重新生成（终态可重跑） */}
      {(status === 'done' || status === 'error') && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" className="h-7 gap-1" onClick={onRerun}>
            <RefreshCw className="size-3.5" />
            {t('insight.regenerate')}
          </Button>
        </div>
      )}
    </div>
  );
}
