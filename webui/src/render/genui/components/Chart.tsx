// webui/src/render/genui/components/Chart.tsx
// Intelligent UI 图表：ECharts Canvas 渲染（不是手绘 SVG）。
// 该组件由 GenUIRenderer 懒加载，首屏不引入 ECharts。

import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

export interface GenUIChartDatum {
  label: string;
  value: number;
}

export interface GenUIChartProps {
  kind: 'bar' | 'line' | 'pie';
  data: GenUIChartDatum[];
  height?: number;
  tone?: string;
  title?: string;
}

const PALETTES: Record<string, string[]> = {
  default: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'],
  primary: ['#3b82f6', '#6366f1', '#8b5cf6', '#0ea5e9', '#06b6d4', '#2563eb'],
  success: ['#10b981', '#22c55e', '#14b8a6', '#84cc16', '#059669'],
  warning: ['#f59e0b', '#f97316', '#eab308', '#fbbf24', '#d97706'],
  danger: ['#ef4444', '#f43f5e', '#dc2626', '#e11d48', '#fb7185'],
  info: ['#06b6d4', '#0ea5e9', '#3b82f6', '#14b8a6', '#38bdf8'],
  muted: ['#94a3b8', '#6b7280', '#a1a1aa', '#9ca3af', '#71717a'],
};

const AXIS_COLOR = '#94a3b8';
const SPLIT_COLOR = 'rgba(148, 163, 184, 0.22)';

export default function GenUIChart({ kind, data, height = 260, tone = 'default', title }: GenUIChartProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);

  const option = useMemo<EChartsOption>(() => {
    const palette = PALETTES[tone] ?? PALETTES.default;
    const labels = data.map((d) => d.label);
    const values = data.map((d) => d.value);

    const base: EChartsOption = {
      backgroundColor: 'transparent',
      color: palette,
      animationDuration: 320,
      ...(title
        ? {
            title: {
              text: title,
              left: 4,
              top: 0,
              textStyle: { fontSize: 13, fontWeight: 600, color: 'inherit' },
            },
          }
        : {}),
      tooltip: {
        trigger: kind === 'pie' ? 'item' : 'axis',
        confine: true,
        backgroundColor: 'rgba(24, 24, 27, 0.92)',
        borderWidth: 0,
        textStyle: { color: '#fafafa', fontSize: 12 },
      },
    };

    if (kind === 'pie') {
      return {
        ...base,
        series: [
          {
            type: 'pie',
            radius: ['38%', '68%'],
            center: ['50%', '55%'],
            data: data.map((d) => ({ name: d.label, value: d.value })),
            label: { color: AXIS_COLOR, fontSize: 11 },
            labelLine: { lineStyle: { color: SPLIT_COLOR } },
            itemStyle: { borderColor: 'transparent', borderWidth: 1, borderRadius: 4 },
          },
        ],
      };
    }

    return {
      ...base,
      grid: { left: 8, right: 16, top: title ? 34 : 16, bottom: 4, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLine: { lineStyle: { color: SPLIT_COLOR } },
        axisTick: { show: false },
        axisLabel: { color: AXIS_COLOR, fontSize: 11, width: 90, overflow: 'truncate' },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: AXIS_COLOR, fontSize: 11 },
        splitLine: { lineStyle: { color: SPLIT_COLOR, type: 'dashed' } },
      },
      series: [
        kind === 'bar'
          ? {
              type: 'bar',
              data: values,
              barMaxWidth: 44,
              itemStyle: { borderRadius: [5, 5, 0, 0] },
            }
          : {
              type: 'line',
              data: values,
              smooth: true,
              symbolSize: 6,
              lineStyle: { width: 2 },
              areaStyle: { opacity: 0.12 },
            },
      ],
    };
  }, [kind, data, title, tone]);

  useEffect(() => {
    const el = ref.current;
    if (!el || data.length === 0) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.setOption(option, true);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [data.length, option]);

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground"
        style={{ height }}
      >
        {t('task.runCode.chartEmpty')}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="img"
      aria-label={title ?? '数据图表'}
      className="w-full"
      style={{ height }}
    />
  );
}
