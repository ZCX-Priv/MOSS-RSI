// webui/src/components/pages/overview/charts.tsx
// 设置-概览自绘图表基础件（无第三方图表库）：
// TrendAreaChart 面积趋势 / StackedTokenBars 三段堆叠柱 / Donut 环形图 /
// Heatmap 活跃热力图 / Sparkline 迷你趋势 / StatTile KPI 卡，以及格式化工具。
// 所有颜色引用项目级色卡（lib/theme-palette.ts）写入的 --palette-* 变量。

import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

// ============================================================================
// 配色（项目级色卡）
// ============================================================================

/** Token 构成（缓存命中 / 未缓存输入 / 输出） */
export const TOKEN_COLORS = {
  cached: 'var(--palette-chart-token-cached)',
  prompt: 'var(--palette-chart-token-uncached)',
  completion: 'var(--palette-chart-token-output)',
} as const;

/** 耗时构成（模型 / 工具） */
export const TIMING_COLORS = {
  llm: 'var(--palette-chart-timing-model)',
  tool: 'var(--palette-chart-timing-tool)',
} as const;

/** 资源（CPU / 内存 / 磁盘 / 网络） */
export const RESOURCE_COLORS = {
  cpu: 'var(--palette-chart-res-cpu)',
  memory: 'var(--palette-chart-res-memory)',
  disk: 'var(--palette-chart-res-disk)',
  network: 'var(--palette-chart-res-network)',
} as const;

/** Tally（技能 / 工具 / 命令）名称色板 */
const TALLY_PALETTE = [
  'var(--palette-chart-tally-1)',
  'var(--palette-chart-tally-2)',
  'var(--palette-chart-tally-3)',
  'var(--palette-chart-tally-4)',
  'var(--palette-chart-tally-5)',
  'var(--palette-chart-tally-6)',
  'var(--palette-chart-tally-7)',
  'var(--palette-chart-tally-8)',
];

/** 名称 → 稳定色（同名同色） */
export function nameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return TALLY_PALETTE[hash % TALLY_PALETTE.length];
}

// ============================================================================
// 格式化
// ============================================================================

/** token 数缩写：1.2K / 3.4M / 1.1B */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

/** 完整数字（千分位，用于图表标题总量与 tooltip） */
export function formatCount(value: number, locale = 'en-US'): string {
  if (!Number.isFinite(value)) return '0';
  try {
    return new Intl.NumberFormat(locale).format(Math.round(value));
  } catch {
    return String(Math.round(value));
  }
}

/** 百分比（0-1 → '96.7%'） */
export function formatPercent(ratio: number | null, digits = 1): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 毫秒 → '1h 2m' / '3m 20s' / '12s' */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 字节 → '1.2 GB' */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 每秒字节 → '1.2 MB/s' */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** 相对时间（跟随界面语言） */
export function relativeTime(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (abs < 60) return rtf.format(Math.round(diffSec), 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    if (abs < 86_400 * 30) return rtf.format(Math.round(diffSec / 86_400), 'day');
    return rtf.format(Math.round(diffSec / (86_400 * 30)), 'month');
  } catch {
    return iso.slice(0, 10);
  }
}

/** 日期刻度：YYYY-MM-DD → MM/DD */
function axisDay(day: string): string {
  return day.slice(5).replace('-', '/');
}

/** 取「好看」的坐标轴上限（1 / 2 / 5 × 10^n） */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const scaled = value / base;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * base;
}

/** 图表左侧 Y 轴刻度（0 / 中间 / 上限） */
function YAxis({ max }: { max: number }) {
  return (
    <div className="flex w-10 shrink-0 flex-col justify-between pb-4 text-right text-[10px] tabular-nums text-muted-foreground">
      <span>{formatTokens(max)}</span>
      <span>{formatTokens(max / 2)}</span>
      <span>0</span>
    </div>
  );
}

/** 图表底部日期刻度（起 / 中 / 止） */
function XAxis({ points }: { points: Array<{ day: string }> }) {
  if (points.length === 0) return null;
  const middle = points[Math.floor((points.length - 1) / 2)];
  return (
    <div className="flex justify-between pl-10 pt-1 text-[10px] tabular-nums text-muted-foreground">
      <span>{axisDay(points[0].day)}</span>
      {points.length > 2 && <span>{axisDay(middle.day)}</span>}
      <span>{axisDay(points[points.length - 1].day)}</span>
    </div>
  );
}

// ============================================================================
// 面积趋势图（API 请求次数）
// ============================================================================

export interface TrendPoint {
  day: string;
  value: number;
}

export function TrendAreaChart({
  points,
  color,
  height = 148,
}: {
  points: TrendPoint[];
  color: string;
  height?: number;
}) {
  const gradientId = useId().replace(/:/g, '');
  const max = niceMax(Math.max(1, ...points.map((point) => point.value)));
  const width = 600;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((point, index) => ({
    x: points.length > 1 ? index * step : 0,
    y: height - (Math.max(0, point.value) / max) * height,
  }));
  const line = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area =
    points.length > 1
      ? `0,${height} ${line} ${width},${height}`
      : `0,${height} 0,${coords[0]?.y.toFixed(1) ?? height} ${width},${coords[0]?.y.toFixed(1) ?? height} ${width},${height}`;

  return (
    <div className="flex flex-col">
      <div className="flex items-stretch gap-1">
        <YAxis max={max} />
        <div className="relative min-w-0 flex-1">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="block w-full"
            style={{ height }}
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={`trend-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.32 }} />
                <stop offset="100%" style={{ stopColor: color, stopOpacity: 0.02 }} />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((ratio) => (
              <line
                key={ratio}
                x1="0"
                x2={width}
                y1={(height * ratio).toFixed(1)}
                y2={(height * ratio).toFixed(1)}
                style={{ stroke: 'var(--palette-chart-grid)' }}
                strokeWidth="1"
                strokeDasharray={ratio === 0 ? undefined : '3 3'}
              />
            ))}
            <polygon points={area} style={{ fill: `url(#trend-${gradientId})` }} />
            <polyline
              points={line}
              fill="none"
              strokeWidth="1.6"
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ stroke: color }}
            />
          </svg>
        </div>
      </div>
      <XAxis points={points} />
    </div>
  );
}

// ============================================================================
// 三段堆叠柱（Tokens：命中缓存 / 未命中输入 / 输出）
// ============================================================================

export interface TokenBarPoint {
  day: string;
  cachedTokens: number;
  promptTokens: number;
  completionTokens: number;
}

export function StackedTokenBars({
  points,
  height = 148,
}: {
  points: TokenBarPoint[];
  height?: number;
}) {
  const { t, i18n } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const totals = points.map(
    (point) => point.cachedTokens + point.promptTokens + point.completionTokens,
  );
  const max = niceMax(Math.max(1, ...totals));
  const hovered = hover !== null ? points[hover] : null;
  const hoveredTotal = hover !== null ? totals[hover] : 0;
  const tooltipLeft = hover !== null ? Math.min(88, Math.max(12, ((hover + 0.5) / points.length) * 100)) : 0;

  return (
    <div className="flex flex-col">
      <div className="flex items-stretch gap-1">
        <YAxis max={max} />
        <div className="relative min-w-0 flex-1">
          <div className="relative flex items-end gap-[2px]" style={{ height }}>
            {[0, 0.5, 1].map((ratio) => (
              <span
                key={ratio}
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 border-t"
                style={{
                  bottom: `${ratio * 100}%`,
                  borderColor: 'var(--palette-chart-grid)',
                  borderStyle: ratio === 0 ? 'solid' : 'dashed',
                }}
              />
            ))}
            {points.map((point, index) => {
              const total = totals[index];
              const heightPercent = total <= 0 ? 0 : (total / max) * 100;
              const segment = (value: number): number => (total <= 0 ? 0 : (value / total) * 100);
              return (
                <div
                  key={point.day}
                  className="relative z-10 flex h-full min-w-0 flex-1 items-end justify-center"
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className="flex w-full max-w-[14px] flex-col-reverse overflow-hidden rounded-t-[2px] transition-[height] duration-300"
                    style={{ height: total <= 0 ? 2 : `${Math.max(2, heightPercent)}%` }}
                    title={`${point.day} · ${formatTokens(total)}`}
                  >
                    {total > 0 && (
                      <>
                        <span
                          className="w-full"
                          style={{
                            height: `${segment(point.completionTokens)}%`,
                            backgroundColor: TOKEN_COLORS.completion,
                          }}
                        />
                        <span
                          className="w-full"
                          style={{
                            height: `${segment(point.promptTokens)}%`,
                            backgroundColor: TOKEN_COLORS.prompt,
                          }}
                        />
                        <span
                          className="w-full"
                          style={{
                            height: `${segment(point.cachedTokens)}%`,
                            backgroundColor: TOKEN_COLORS.cached,
                          }}
                        />
                      </>
                    )}
                    {total <= 0 && <span className="h-full w-full bg-muted" />}
                  </div>
                </div>
              );
            })}
          </div>

          {hovered !== null && (
            <div
              className="pointer-events-none absolute top-0 z-20 rounded-lg border border-border bg-popover px-3 py-2 text-[11px] shadow-lg"
              style={{ left: `${tooltipLeft}%`, transform: 'translate(-50%, -6px)' }}
            >
              <div className="mb-1 flex items-baseline justify-between gap-6">
                <span className="font-medium text-foreground">{hovered.day}</span>
                <span className="tabular-nums font-medium text-foreground">
                  {formatCount(hoveredTotal, i18n.language)}
                </span>
              </div>
              {[
                { key: 'cached', color: TOKEN_COLORS.cached, label: t('usage.chart.cached'), value: hovered.cachedTokens },
                { key: 'uncached', color: TOKEN_COLORS.prompt, label: t('usage.chart.uncached'), value: hovered.promptTokens },
                { key: 'output', color: TOKEN_COLORS.completion, label: t('usage.chart.output'), value: hovered.completionTokens },
              ].map((row) => (
                <div key={row.key} className="flex items-center gap-2 whitespace-nowrap">
                  <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: row.color }} />
                  <span className="min-w-0 flex-1 text-muted-foreground">{row.label}</span>
                  <span className="tabular-nums text-foreground">{formatCount(row.value, i18n.language)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <XAxis points={points} />
    </div>
  );
}

// ============================================================================
// Donut 环形图
// ============================================================================

export interface DonutSegment {
  key: string;
  color: string;
  value: number;
}

export interface DonutProps {
  segments: DonutSegment[];
  centerTop: ReactNode;
  centerSub?: ReactNode;
  size?: number;
  /** 高亮段（与图例联动） */
  hoverKey?: string | null;
  onHoverKey?: (key: string | null) => void;
}

const DONUT_RADIUS = 15.9155;
const SEG_GAP = 0.5;

export function Donut({ segments, centerTop, centerSub, size = 96, hoverKey, onHoverKey }: DonutProps) {
  const arcs = useMemo(() => {
    const positive = segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
    const total = positive.reduce((sum, s) => sum + s.value, 0);
    if (total <= 0) return [];
    const out: Array<{ key: string; color: string; len: number; offset: number }> = [];
    let acc = 0;
    for (const s of positive) {
      const pct = (s.value / total) * 100;
      out.push({ key: s.key, color: s.color, len: pct, offset: 100 - acc + 25 });
      acc += pct;
    }
    if (out.length > 1) {
      for (const arc of out) {
        const cut = Math.min(SEG_GAP / 2, arc.len / 4);
        arc.len -= cut * 2;
        arc.offset -= cut;
      }
    }
    return out;
  }, [segments]);

  const active = hoverKey !== null && hoverKey !== undefined;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      onMouseLeave={() => onHoverKey?.(null)}
    >
      <svg viewBox="0 0 42 42" width={size} height={size} aria-hidden="true">
        {arcs.length === 0 ? (
          <circle
            cx="21"
            cy="21"
            r={DONUT_RADIUS}
            fill="none"
            strokeWidth="4"
            className="stroke-muted"
          />
        ) : (
          arcs.map((arc) => (
            <circle
              key={arc.key}
              cx="21"
              cy="21"
              r={DONUT_RADIUS}
              fill="none"
              strokeWidth={hoverKey === arc.key ? 4.8 : 4}
              strokeLinecap="butt"
              strokeDasharray={`${arc.len} ${100 - arc.len}`}
              strokeDashoffset={arc.offset}
              className="transition-[stroke-width,opacity] duration-200"
              style={{ stroke: arc.color, opacity: active && hoverKey !== arc.key ? 0.35 : 1 }}
              onMouseEnter={() => onHoverKey?.(arc.key)}
            />
          ))
        )}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span
          className="font-semibold leading-none tabular-nums text-foreground"
          style={{ fontSize: Math.max(11, Math.round(size * 0.135)) }}
        >
          {centerTop}
        </span>
        {centerSub !== undefined && (
          <span
            className="leading-none text-muted-foreground"
            style={{ fontSize: Math.max(9, Math.round(size * 0.105)) }}
          >
            {centerSub}
          </span>
        )}
      </div>
    </div>
  );
}

/** 环形图右侧图例行 */
export function DonutLegend({
  rows,
  hoverKey,
  onHoverKey,
}: {
  rows: Array<{ key: string; color: string; label: string; value: string; sub?: string }>;
  hoverKey?: string | null;
  onHoverKey?: (key: string | null) => void;
}) {
  return (
    <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
      {rows.map((row) => (
        <li
          key={row.key}
          className={cn(
            'flex items-center gap-2 rounded-md px-1.5 py-0.5 text-xs transition-colors',
            hoverKey === row.key ? 'bg-muted/70' : 'bg-transparent',
          )}
          onMouseEnter={() => onHoverKey?.(row.key)}
          onMouseLeave={() => onHoverKey?.(null)}
        >
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
          <span className="shrink-0 font-medium tabular-nums text-foreground">{row.value}</span>
          {row.sub !== undefined && (
            <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{row.sub}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ============================================================================
// 热力图（8 周 × 7 天）
// ============================================================================

const HEAT_LEVEL_CLASS = ['bg-muted/50', 'bg-primary/20', 'bg-primary/40', 'bg-primary/65', 'bg-primary'];

export function heatLevelOf(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export interface HeatmapProps {
  /** day → 值 */
  values: Map<string, number>;
  /** 单元格说明（tooltip） */
  label: (day: string, value: number) => string;
  selected: string | null;
  onSelect: (day: string | null) => void;
  weeks?: number;
  /** 今天（YYYY-MM-DD，本地） */
  today: string;
  /** 星期标签（索引 1/3/5） */
  weekdayLabels?: [string, string, string];
  lessLabel: string;
  moreLabel: string;
}

function dayKeyOfDate(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function Heatmap({
  values,
  label,
  selected,
  onSelect,
  weeks = 8,
  today,
  weekdayLabels = ['', '', ''],
  lessLabel,
  moreLabel,
}: HeatmapProps) {
  const columns = useMemo(() => {
    const todayDate = new Date(`${today}T00:00:00`);
    if (Number.isNaN(todayDate.getTime())) return [];
    // 最后一列为本周（周日起），往前推 weeks-1 周
    const lastSunday = new Date(todayDate);
    lastSunday.setDate(lastSunday.getDate() - lastSunday.getDay());
    const out: Array<Array<{ key: string; future: boolean }>> = [];
    for (let w = weeks - 1; w >= 0; w -= 1) {
      const column: Array<{ key: string; future: boolean }> = [];
      for (let d = 0; d < 7; d += 1) {
        const day = new Date(lastSunday);
        day.setDate(lastSunday.getDate() - w * 7 + d);
        const key = dayKeyOfDate(day);
        column.push({ key, future: key > today });
      }
      out.push(column);
    }
    return out;
  }, [today, weeks]);

  const max = useMemo(() => {
    let top = 0;
    for (const column of columns) {
      for (const cell of column) {
        const v = values.get(cell.key) ?? 0;
        if (v > top) top = v;
      }
    }
    return top;
  }, [columns, values]);

  return (
    <div className="flex items-stretch gap-2">
      <div className="flex shrink-0 flex-col gap-1" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((row) => (
          <span key={row} className="flex flex-1 items-center justify-end text-[10px] leading-none text-muted-foreground/70">
            {row === 1 ? weekdayLabels[0] : row === 3 ? weekdayLabels[1] : row === 5 ? weekdayLabels[2] : ''}
          </span>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="flex gap-1">
          {columns.map((column) => (
            <div key={column[0].key} className="flex max-w-[26px] flex-1 flex-col gap-1">
              {column.map((cell) => {
                const value = values.get(cell.key) ?? 0;
                const level = heatLevelOf(value, max);
                const picked = selected === cell.key;
                if (cell.future) {
                  return <span key={cell.key} className="aspect-square w-full rounded-[3px] bg-transparent" aria-hidden="true" />;
                }
                return (
                  <button
                    key={cell.key}
                    type="button"
                    title={label(cell.key, value)}
                    aria-label={label(cell.key, value)}
                    aria-pressed={picked}
                    onClick={() => onSelect(picked ? null : cell.key)}
                    className={cn(
                      'aspect-square w-full rounded-[3px] transition-transform hover:scale-110',
                      HEAT_LEVEL_CLASS[level],
                      picked && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                      cell.key === today && 'outline outline-1 outline-primary/60',
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          <span>{lessLabel}</span>
          {HEAT_LEVEL_CLASS.map((cls) => (
            <span key={cls} className={cn('size-3 rounded-[3px]', cls)} />
          ))}
          <span>{moreLabel}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 迷你趋势线
// ============================================================================

export function Sparkline({
  points,
  color,
  width = 120,
  height = 32,
  id,
}: {
  points: number[];
  color: string;
  width?: number;
  height?: number;
  id: string;
}) {
  if (points.length < 2) {
    return <div style={{ width, height }} className="rounded bg-muted/40" aria-hidden="true" />;
  }
  const max = Math.max(1, ...points);
  const min = Math.min(...points, 0);
  const span = Math.max(1, max - min);
  const step = width / (points.length - 1);
  const coords = points.map((v, i) => `${(i * step).toFixed(2)},${(height - ((v - min) / span) * (height - 4) - 2).toFixed(2)}`);
  const line = coords.join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.28 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <polygon points={area} style={{ fill: `url(#spark-${id})` }} />
      <polyline
        points={line}
        fill="none"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ stroke: color }}
      />
    </svg>
  );
}

// ============================================================================
// KPI 卡
// ============================================================================

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold leading-tight tabular-nums text-foreground">{value}</span>
      {sub !== undefined && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}
