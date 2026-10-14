// 运行指标栏：任务输入框下方的一行统计。混合口径：
//   轮·步 | LLM 耗时 | 工具耗时 —— 会话生命周期累计（runStats，跨消息持续累加，刷新后恢复）
//   缓存命中 | 输入/输出 token —— 上下文引擎真实数据（contextStats：最近一次请求的 LLM usage
//   与近样本平均命中率，与右侧上下文面板同源同刻）；引擎不可用/无样本时降级 runStats 累计值
// 常驻显示（无数据时按 0 值渲染）。

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useStore } from '../../store';
import type { RunStats, ContextStats } from '../../types/api';

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 数值项（值变化时不再高亮脉冲：已去掉「变蓝闪一下」特效） */
function StatItem({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <span className="anim-stat whitespace-nowrap tabular-nums">
      {label}{' '}
      <span className={cn('text-foreground/80', warning && 'text-amber-500 dark:text-amber-400')}>
        {value}
      </span>
    </span>
  );
}

function Separator() {
  return <span className="select-none text-border" aria-hidden>|</span>;
}

/** 无数据时的全 0 兜底（常驻显示） */
const EMPTY_STATS: RunStats = {
  turns: 0,
  runTurns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftCount: 0,
  ttftMsTotal: 0,
  decodeMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
};

export function StatsBar({ stats, contextStats }: { stats?: RunStats; contextStats?: ContextStats }) {
  const { t } = useTranslation();
  const s = stats ?? EMPTY_STATS;
  // 轮数上限（agent.maxTurns；0=无限）：有限时第一项切换为本次 run 进度 X/N
  const maxTurns = useStore((st) => st.appConfig?.agent.maxTurns) ?? 0;
  const finiteTurns = maxTurns > 0;
  const runTurns = s.runTurns ?? 0;
  const nearTurnLimit = finiteTurns && runTurns / maxTurns >= 0.9;
  // 引擎数据优先：缓存命中用 avgHitRate（与右侧面板徽章同源）；无样本降级累计口径
  const cacheHitPct =
    contextStats?.avgHitRate != null
      ? Math.round(contextStats.avgHitRate * 100)
      : s.inputTokens > 0
        ? Math.round((s.cachedTokens / s.inputTokens) * 100)
        : 0;
  // 输入/输出：引擎最近一次请求真实 usage；无样本降级 runStats 累计
  const inputTokens = contextStats?.lastUsage?.promptTokens ?? s.inputTokens;
  const outputTokens = contextStats?.lastUsage?.completionTokens ?? s.outputTokens;

  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 px-3 pb-1 pt-0.5 text-[11px] text-muted-foreground">
      <StatItem
        label=""
        value={
          finiteTurns
            ? t('stats.turnsProgress', { current: runTurns, max: maxTurns })
            : t('stats.turnsSteps', { turns: s.turns, steps: s.steps })
        }
        warning={nearTurnLimit}
      />
      <Separator />
      <StatItem label={t('stats.llmLabel')} value={fmtMs(s.llmMs)} />
      <Separator />
      <StatItem label={t('stats.toolLabel')} value={fmtMs(s.toolMs)} />
      <Separator />
      <StatItem label={t('stats.cacheLabel')} value={t('stats.percent', { pct: cacheHitPct })} />
      <Separator />
      <StatItem label={t('stats.inputLabel')} value={t('stats.tokCount', { count: fmtTokens(inputTokens) })} />
      <Separator />
      <StatItem label={t('stats.outputLabel')} value={t('stats.tokCount', { count: fmtTokens(outputTokens) })} />
    </div>
  );
}
