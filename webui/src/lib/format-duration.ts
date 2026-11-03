// webui/src/lib/format-duration.ts
// 耗时统一人类可读化：<1s 用 ms，<60s 用 s，其余用 min。
// 避免大工具执行显示「几十万 ms」不可读。

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${(ms / 60_000).toFixed(ms < 600_000 ? 1 : 0)}min`;
}
