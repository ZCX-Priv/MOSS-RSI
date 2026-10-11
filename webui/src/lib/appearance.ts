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

/** 主题色预设（与设置页色板保持一致） */
const ACCENT_PRESETS: Record<string, string> = {
  blue: 'oklch(0.546 0.245 263.4)',
  green: 'oklch(0.627 0.194 149.2)',
  purple: 'oklch(0.541 0.281 293.0)',
  orange: 'oklch(0.646 0.222 41.0)',
  rose: 'oklch(0.586 0.225 16.5)',
  teal: 'oklch(0.6 0.118 184.5)',
};

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

export function applyAppearanceToDom(state: AppearanceState): void {
  const root = document.documentElement;

  // 主题色：覆盖主题变量（按钮 / 链接 / 指示器 / 图表）
  const color = state.accentColor.startsWith('#')
    ? state.accentColor
    : (ACCENT_PRESETS[state.accentColor] ?? ACCENT_PRESETS.blue);
  root.style.setProperty('--primary', color);
  root.style.setProperty('--primary-strong', color);
  root.style.setProperty('--ring', color);
  root.style.setProperty('--sidebar-primary', color);
  root.style.setProperty('--sidebar-ring', color);
  root.style.setProperty('--chart-1', color);
  root.style.setProperty('--chart-2', color);

  // 字号：根字号（body 以 1rem 继承，见 global.css）
  root.style.fontSize = FONT_SIZE_MAP[state.fontSize] ?? FONT_SIZE_MAP.medium;

  // 界面密度：交由 global.css 的 html[data-density] 规则覆写 --spacing
  root.setAttribute('data-density', state.uiDensity);

  // 圆角
  root.style.setProperty('--radius', RADIUS_MAP[state.cornerRadius] ?? RADIUS_MAP.standard);
}