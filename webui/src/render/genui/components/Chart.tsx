// webui/src/render/genui/components/Chart.tsx
// Intelligent UI 图表：ECharts Canvas 渲染（不是手绘 SVG）。
// 该组件由 GenUIRenderer 懒加载，首屏不引入 ECharts。

import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import { useTheme } from '@/contexts/ThemeContext';
import { readThemePaletteFromDom } from '@/lib/theme-palette';

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

/** 按当前项目级色卡生成 ECharts 调色板（随主题色/亮暗模式变化） */
function buildPalettes(): Record<string, string[]> {
  const palette = readThemePaletteFromDom();
  const ramp = palette.chart.ramp;
  return {
    default: [ramp[5], ramp[3], ramp[1], palette.success, palette.warning, palette.info, ramp[6]],
    primary: [ramp[5], ramp[4], ramp[3], ramp[2], ramp[1], ramp[0]],
    success: [palette.success, ramp[3], ramp[1], palette.info],
    warning: [palette.warning, ramp[3], ramp[1]],
    danger: [palette.danger, palette.warning, ramp[3]],
    info: [palette.info, ramp[3], ramp[1]],
    muted: [ramp[4], ramp[2], palette.connection.offline],
  };
}

export default function GenUIChart({ kind, data, height = 260, tone = 'default', title }: GenUIChartProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const { resolvedTheme } = useTheme();
  const themePalette = useMemo(() => readThemePaletteFromDom(), [resolvedTheme]);

  const option = useMemo<EChartsOption>(() => {
    const palettes = buildPalettes();
    const palette = palettes[tone] ?? palettes.default;
    const axisColor = themePalette.chart.axis;
    const splitColor = themePalette.chart.grid;
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
        backgroundColor: themePalette.chart.ramp[7],
        borderWidth: 0,
        textStyle: { color: themePalette.chart.ramp[0], fontSize: 12 },
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
            label: { color: axisColor, fontSize: 11 },
            labelLine: { lineStyle: { color: splitColor } },
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
        axisLine: { lineStyle: { color: splitColor } },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 11, width: 90, overflow: 'truncate' },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 11 },
        splitLine: { lineStyle: { color: splitColor, type: 'dashed' } },
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
  }, [kind, data, title, tone, themePalette]);

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
