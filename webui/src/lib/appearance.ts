// lib/appearance.ts
// 外观设置 → DOM 同步（CSS 变量 / data 属性）的纯函数。
//
// 集中在此的原因：
//  1) main.tsx 在「持久化状态 hydrate 之后、首次 render 之前」调用一次 → 首帧即正确，
//     不会先闪一帧默认外观；
//  2) App.tsx 在设置页改动外观时调用同一函数 → 即时生效。
//
// 说明：界面密度（uiDensity）不在此处写值，而是映射到 <html data-density>，
// 由 global.css 的 html[data-density=...] 覆写 Tailwind v4 的 --spacing 实现整体间距缩放。

import { ACCENT_PRESETS, applyThemePaletteToDom, resolveThemePalette } from './theme-palette';

export interface AppearanceState {
  /** 主题色（预设 ID 或自定义 hex 字符串） */
  accentColor: string;
  /** 字号 */
  fontSize: 'small' | 'medium' | 'large';
  /** 界面密度 */
  uiDensity: 'compact' | 'standard' | 'comfortable';
  /** 圆角大小 */
  cornerRadius: 'small' | 'standard' | 'large';
}

/** 字号档位 → 根字号（rem 系 utility 与 --spacing 均随之缩放） */
const FONT_SIZE_MAP: Record<AppearanceState['fontSize'], string> = {
  small: '13px',
  medium: '14px',
  large: '16px',
};

/** 圆角档位 → --radius */
const RADIUS_MAP: Record<AppearanceState['cornerRadius'], string> = {
  small: '0.375rem',
  standard: '0.625rem',
  large: '0.875rem',
};

export function applyAppearanceToDom(state: AppearanceState, mode?: 'light' | 'dark'): void {
  const root = document.documentElement;

  // 主题色：覆盖主题变量（按钮 / 链接 / 指示器 / 图表）
  const color = state.accentColor.startsWith('#')
    ? state.accentColor
    : (ACCENT_PRESETS.find((preset) => preset.id === state.accentColor)?.color ?? ACCENT_PRESETS[0].color);
  root.style.setProperty('--primary', color);
  root.style.setProperty('--primary-strong', color);
  root.style.setProperty('--ring', color);
  root.style.setProperty('--sidebar-primary', color);
  root.style.setProperty('--sidebar-ring', color);
  root.style.setProperty('--chart-1', color);
  root.style.setProperty('--chart-2', color);

  // 项目级色卡：按「主题色 × 亮暗模式」写入全部 --palette-* 变量
  // mode 显式传入（App 的 resolvedTheme）时优先使用，避免与 .dark class 切换时序错位
  const resolvedMode = mode ?? (root.classList.contains('dark') ? 'dark' : 'light');
  applyThemePaletteToDom(resolveThemePalette(state.accentColor, resolvedMode));

  // 字号：根字号（body 以 1rem 继承，见 global.css）
  root.style.fontSize = FONT_SIZE_MAP[state.fontSize] ?? FONT_SIZE_MAP.medium;

  // 界面密度：交由 global.css 的 html[data-density] 规则覆写 --spacing
  root.setAttribute('data-density', state.uiDensity);

  // 圆角
  root.style.setProperty('--radius', RADIUS_MAP[state.cornerRadius] ?? RADIUS_MAP.standard);
}