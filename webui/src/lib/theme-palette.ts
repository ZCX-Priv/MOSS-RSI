// webui/src/lib/theme-palette.ts
// 项目级色卡（唯一色彩来源）：
//   每套主题色（蓝 / 绿 / 紫 / 橙 / 玫红 / 青）× 亮/暗模式，
//   分别定义图表、上下文构成、文件操作、日志等级、连接状态等组件的色彩组成。
// 使用方式：
//   1) 外观设置变化时 applyAppearanceToDom → applyThemePaletteToDom 写入 :root 的 --palette-* 变量；
//   2) 组件通过 CSS 变量 / global.css 中的 @theme 映射（text-success、bg-danger/15 等）消费；
//   3) Canvas/ECharts 通过 readThemePaletteFromDom() 读取当前生效色卡。

export type AccentId = 'blue' | 'green' | 'purple' | 'orange' | 'rose' | 'teal';
export type ThemeMode = 'light' | 'dark';

export interface ChartPalette {
  /** 8 阶同色系色卡（由浅到深）；ramp[1] / ramp[3] / ramp[5] 为参考图三色 */
  ramp: string[];
  trendLine: string;
  trendFillFrom: string;
  trendFillTo: string;
  tokenCached: string;
  tokenUncached: string;
  tokenOutput: string;
  timingModel: string;
  timingTool: string;
  resourceCpu: string;
  resourceMemory: string;
  resourceDisk: string;
  resourceNetwork: string;
  /** logs / memory / live / tasks / todo / terminals / other / free */
  categories: string[];
  /** 技能 / 工具 / 命令等名称色（8 个） */
  tally: string[];
  axis: string;
  grid: string;
}

export interface ThemePalette {
  primary: string;
  primaryStrong: string;
  /** 主题色作为文字/图标时的颜色（暗色模式自动提亮，保证对比度） */
  primaryText: string;
  success: string;
  warning: string;
  danger: string;
  /** FATAL / 强危险（比 danger 更深的文字色） */
  dangerStrong: string;
  info: string;
  chart: ChartPalette;
  /** 上下文构成条 */
  context: {
    system: string;
    env: string;
    summary: string;
    history: string;
    rules: string;
    memory: string;
  };
  /** 文件操作 */
  fileOps: {
    create: string;
    update: string;
    move: string;
    delete: string;
  };
  /** 日志等级 */
  log: {
    debug: string;
    info: string;
    warn: string;
    error: string;
    fatal: string;
  };
  /** 连接状态 */
  connection: {
    online: string;
    pending: string;
    offline: string;
    error: string;
  };
}

/** 主题色预设（设置页与外观应用共用） */
export const ACCENT_PRESETS: Array<{ id: AccentId; color: string }> = [
  { id: 'blue', color: 'oklch(0.546 0.245 263.4)' },
  { id: 'green', color: 'oklch(0.627 0.194 149.2)' },
  { id: 'purple', color: 'oklch(0.541 0.281 293.0)' },
  { id: 'orange', color: 'oklch(0.646 0.222 41.0)' },
  { id: 'rose', color: 'oklch(0.586 0.225 16.5)' },
  { id: 'teal', color: 'oklch(0.6 0.118 184.5)' },
];

/** 主题色默认蓝的 hex（仅用于 <input type="color"> 这类必须 hex 的场景） */
export const DEFAULT_ACCENT_HEX = '#2563EB';

/**
 * 每套主题色的 8 阶图表色卡（由浅到深）。
 * 蓝色前三阶与参考图对齐：#A0DCFD / #60B3FE / #0C70F3（ramp[1] / [3] / [5]）。
 * 其它主题取同色相 Tailwind 100→800 色阶。
 */
const ACCENT_RAMPS: Record<AccentId, string[]> = {
  blue: ['#DFF3FE', '#A0DCFD', '#7CC9FB', '#60B3FE', '#2E8FF7', '#0C70F3', '#0A5BC4', '#084A9E'],
  green: ['#D1FAE5', '#A7F3D0', '#6EE7B7', '#34D399', '#10B981', '#059669', '#047857', '#065F46'],
  purple: ['#EDE9FE', '#DDD6FE', '#C4B5FD', '#A78BFA', '#8B5CF6', '#7C3AED', '#6D28D9', '#5B21B6'],
  orange: ['#FFEDD5', '#FED7AA', '#FDBA74', '#FB923C', '#F97316', '#EA580C', '#C2410C', '#9A3412'],
  rose: ['#FFE4E6', '#FECDD3', '#FDA4AF', '#FB7185', '#F43F5E', '#E11D48', '#BE123C', '#9F1239'],
  teal: ['#CCFBF1', '#99F6E4', '#5EEAD4', '#2DD4BF', '#14B8A6', '#0D9488', '#0F766E', '#115E59'],
};

/** 主题色（preset id 或自定义 hex）→ 实际使用的 hex（供后端 computer 光标取最近调色板色） */
export function resolveAccentHex(value: string): string {
  if (value.startsWith('#')) return value.toUpperCase();
  return (ACCENT_RAMPS[value as AccentId]?.[5] ?? DEFAULT_ACCENT_HEX).toUpperCase();
}

/** 状态色（语义稳定，不随主题色变化；亮暗各一套） */
const STATUS_COLORS: Record<ThemeMode, {
  success: string;
  warning: string;
  danger: string;
  dangerStrong: string;
  info: string;
  axis: string;
  grid: string;
}> = {
  light: {
    success: '#059669',
    warning: '#D97706',
    danger: '#DC2626',
    dangerStrong: '#991B1B',
    info: '#0284C7',
    axis: 'var(--muted-foreground)',
    grid: 'var(--border)',
  },
  dark: {
    success: '#34D399',
    warning: '#FBBF24',
    danger: '#F87171',
    dangerStrong: '#FCA5A5',
    info: '#38BDF8',
    axis: 'var(--muted-foreground)',
    grid: 'var(--border)',
  },
};

function fillOf(color: string, opacity: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(opacity * 100)}%, transparent)`;
}

function buildPalette(ramp: string[], mode: ThemeMode, primary: string): ThemePalette {
  const status = STATUS_COLORS[mode];
  const trendLine = ramp[5];
  return {
    primary,
    primaryStrong: primary,
    primaryText: mode === 'dark' ? ramp[3] : primary,
    success: status.success,
    warning: status.warning,
    danger: status.danger,
    dangerStrong: status.dangerStrong,
    info: status.info,
    chart: {
      ramp,
      trendLine,
      trendFillFrom: fillOf(trendLine, 0.28),
      trendFillTo: fillOf(trendLine, 0.02),
      tokenCached: ramp[1],
      tokenUncached: ramp[3],
      tokenOutput: ramp[5],
      timingModel: ramp[5],
      timingTool: ramp[3],
      resourceCpu: ramp[5],
      resourceMemory: ramp[3],
      resourceDisk: ramp[1],
      resourceNetwork: ramp[4],
      categories: [ramp[5], ramp[4], ramp[3], ramp[2], ramp[1], ramp[0], ramp[6], 'var(--muted)'],
      tally: [...ramp.slice(0, 6), status.success, status.warning],
      axis: status.axis,
      grid: status.grid,
    },
    context: {
      system: ramp[5],
      env: status.info,
      summary: status.warning,
      history: ramp[2],
      rules: ramp[4],
      memory: ramp[6],
    },
    fileOps: {
      create: status.success,
      update: status.warning,
      move: status.info,
      delete: status.danger,
    },
    log: {
      debug: status.info,
      info: mode === 'dark' ? ramp[3] : primary,
      warn: status.warning,
      error: status.danger,
      fatal: status.dangerStrong,
    },
    connection: {
      online: status.success,
      pending: mode === 'dark' ? ramp[3] : primary,
      offline: 'var(--muted-foreground)',
      error: status.danger,
    },
  };
}

/** 自定义主题色：以用户 hex 为 ramp[5]，其余阶用 color-mix 派生 */
function customRamp(hex: string): string[] {
  return [
    `color-mix(in oklab, ${hex} 20%, white)`,
    `color-mix(in oklab, ${hex} 32%, white)`,
    `color-mix(in oklab, ${hex} 46%, white)`,
    `color-mix(in oklab, ${hex} 62%, white)`,
    `color-mix(in oklab, ${hex} 80%, white)`,
    hex,
    `color-mix(in oklab, ${hex} 80%, black)`,
    `color-mix(in oklab, ${hex} 62%, black)`,
  ];
}

/** 每套主题色 × 亮/暗模式的完整色卡 */
const ACCENT_PALETTES: Record<AccentId, Record<ThemeMode, ThemePalette>> = (() => {
  const out = {} as Record<AccentId, Record<ThemeMode, ThemePalette>>;
  for (const preset of ACCENT_PRESETS) {
    out[preset.id] = {
      light: buildPalette(ACCENT_RAMPS[preset.id], 'light', preset.color),
      dark: buildPalette(ACCENT_RAMPS[preset.id], 'dark', preset.color),
    };
  }
  return out;
})();

/** 解析当前主题色（预设 id 或自定义 hex）→ 色卡 */
export function resolveThemePalette(accentColor: string, mode: ThemeMode): ThemePalette {
  if (accentColor.startsWith('#')) {
    return buildPalette(customRamp(accentColor), mode, accentColor);
  }
  const preset = ACCENT_PRESETS.find((item) => item.id === accentColor) ?? ACCENT_PRESETS[0];
  return ACCENT_PALETTES[preset.id][mode];
}

function setVar(root: HTMLElement, name: string, value: string): void {
  root.style.setProperty(name, value);
}

/** 把色卡写入 :root 的 --palette-* 变量（全站组件共用） */
export function applyThemePaletteToDom(palette: ThemePalette): void {
  const root = document.documentElement;
  setVar(root, '--palette-primary', palette.primary);
  setVar(root, '--palette-primary-strong', palette.primaryStrong);
  setVar(root, '--palette-primary-text', palette.primaryText);
  setVar(root, '--palette-success', palette.success);
  setVar(root, '--palette-warning', palette.warning);
  setVar(root, '--palette-danger', palette.danger);
  setVar(root, '--palette-danger-strong', palette.dangerStrong);
  setVar(root, '--palette-info', palette.info);

  palette.chart.ramp.forEach((color, index) => {
    setVar(root, `--palette-series-${index + 1}`, color);
  });
  setVar(root, '--palette-chart-trend-line', palette.chart.trendLine);
  setVar(root, '--palette-chart-trend-fill-from', palette.chart.trendFillFrom);
  setVar(root, '--palette-chart-trend-fill-to', palette.chart.trendFillTo);
  setVar(root, '--palette-chart-token-cached', palette.chart.tokenCached);
  setVar(root, '--palette-chart-token-uncached', palette.chart.tokenUncached);
  setVar(root, '--palette-chart-token-output', palette.chart.tokenOutput);
  setVar(root, '--palette-chart-timing-model', palette.chart.timingModel);
  setVar(root, '--palette-chart-timing-tool', palette.chart.timingTool);
  setVar(root, '--palette-chart-res-cpu', palette.chart.resourceCpu);
  setVar(root, '--palette-chart-res-memory', palette.chart.resourceMemory);
  setVar(root, '--palette-chart-res-disk', palette.chart.resourceDisk);
  setVar(root, '--palette-chart-res-network', palette.chart.resourceNetwork);

  const categoryKeys = ['logs', 'memory', 'live', 'tasks', 'todo', 'terminals', 'other', 'free'];
  palette.chart.categories.forEach((color, index) => {
    setVar(root, `--palette-chart-cat-${categoryKeys[index] ?? index}`, color);
  });
  palette.chart.tally.forEach((color, index) => {
    setVar(root, `--palette-chart-tally-${index + 1}`, color);
  });
  setVar(root, '--palette-chart-axis', palette.chart.axis);
  setVar(root, '--palette-chart-grid', palette.chart.grid);

  setVar(root, '--palette-context-system', palette.context.system);
  setVar(root, '--palette-context-env', palette.context.env);
  setVar(root, '--palette-context-summary', palette.context.summary);
  setVar(root, '--palette-context-history', palette.context.history);
  setVar(root, '--palette-context-rules', palette.context.rules);
  setVar(root, '--palette-context-memory', palette.context.memory);

  setVar(root, '--palette-file-create', palette.fileOps.create);
  setVar(root, '--palette-file-update', palette.fileOps.update);
  setVar(root, '--palette-file-move', palette.fileOps.move);
  setVar(root, '--palette-file-delete', palette.fileOps.delete);

  setVar(root, '--palette-log-debug', palette.log.debug);
  setVar(root, '--palette-log-info', palette.log.info);
  setVar(root, '--palette-log-warn', palette.log.warn);
  setVar(root, '--palette-log-error', palette.log.error);
  setVar(root, '--palette-log-fatal', palette.log.fatal);

  setVar(root, '--palette-conn-online', palette.connection.online);
  setVar(root, '--palette-conn-pending', palette.connection.pending);
  setVar(root, '--palette-conn-offline', palette.connection.offline);
  setVar(root, '--palette-conn-error', palette.connection.error);
}

function readVar(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

/** Canvas 需要真实颜色：把 var()/color-mix() 通过探针元素解析为 rgb()/hex */
function resolveColor(value: string): string {
  if (!value || !/^(var\(|color-mix\()/.test(value)) return value;
  try {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved || value;
  } catch {
    return value;
  }
}

/** Canvas / ECharts 使用：从 :root 读回当前生效色卡（颜色已解析为真实值） */
export function readThemePaletteFromDom(): ThemePalette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string => resolveColor(readVar(style, name));
  const ramp = Array.from({ length: 8 }, (_, index) => read(`--palette-series-${index + 1}`));
  return {
    primary: read('--palette-primary'),
    primaryStrong: read('--palette-primary-strong'),
    primaryText: read('--palette-primary-text'),
    success: read('--palette-success'),
    warning: read('--palette-warning'),
    danger: read('--palette-danger'),
    dangerStrong: read('--palette-danger-strong'),
    info: read('--palette-info'),
    chart: {
      ramp,
      trendLine: read('--palette-chart-trend-line'),
      trendFillFrom: read('--palette-chart-trend-fill-from'),
      trendFillTo: read('--palette-chart-trend-fill-to'),
      tokenCached: read('--palette-chart-token-cached'),
      tokenUncached: read('--palette-chart-token-uncached'),
      tokenOutput: read('--palette-chart-token-output'),
      timingModel: read('--palette-chart-timing-model'),
      timingTool: read('--palette-chart-timing-tool'),
      resourceCpu: read('--palette-chart-res-cpu'),
      resourceMemory: read('--palette-chart-res-memory'),
      resourceDisk: read('--palette-chart-res-disk'),
      resourceNetwork: read('--palette-chart-res-network'),
      categories: ['logs', 'memory', 'live', 'tasks', 'todo', 'terminals', 'other', 'free'].map((key) =>
        read(`--palette-chart-cat-${key}`),
      ),
      tally: Array.from({ length: 8 }, (_, index) => read(`--palette-chart-tally-${index + 1}`)),
      axis: read('--palette-chart-axis'),
      grid: read('--palette-chart-grid'),
    },
    context: {
      system: read('--palette-context-system'),
      env: read('--palette-context-env'),
      summary: read('--palette-context-summary'),
      history: read('--palette-context-history'),
      rules: read('--palette-context-rules'),
      memory: read('--palette-context-memory'),
    },
    fileOps: {
      create: read('--palette-file-create'),
      update: read('--palette-file-update'),
      move: read('--palette-file-move'),
      delete: read('--palette-file-delete'),
    },
    log: {
      debug: read('--palette-log-debug'),
      info: read('--palette-log-info'),
      warn: read('--palette-log-warn'),
      error: read('--palette-log-error'),
      fatal: read('--palette-log-fatal'),
    },
    connection: {
      online: read('--palette-conn-online'),
      pending: read('--palette-conn-pending'),
      offline: read('--palette-conn-offline'),
      error: read('--palette-conn-error'),
    },
  };
}
