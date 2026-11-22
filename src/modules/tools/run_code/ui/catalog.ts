// src/modules/tools/run_code/ui/catalog.ts
// Intelligent UI 组件目录（单一真相源之一）：组件名、属性、子节点规则与 SDK 文本。
// 前端 webui/src/render/genui/catalog.tsx 按同一份组件名实现渲染器；
// 后端 validate.ts 用本文件做属性白名单与字面量校验，sdk-text 用本文件生成声明。

/** 属性类型（校验器据此判断字面量） */
export type UIPropKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'columns'
  | 'rows'
  | 'chartData'
  | 'keyValueItems'
  | 'listItems'
  | 'timelineItems'
  | 'numbers'
  | 'options'
  | 'tabItems'
  | 'bindingOrValue'
  | 'bindingOrAction';

export interface UIPropSpec {
  kind: UIPropKind;
  required?: boolean;
  /** enum 允许值 */
  values?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface UIComponentSpec {
  name: string;
  description: string;
  props: Record<string, UIPropSpec>;
  /** 是否允许 children（文本或子节点） */
  children?: boolean;
  /** 是否要求至少一个 child（文本类组件） */
  requiredChildren?: boolean;
}

const TONE = ['default', 'muted', 'primary', 'success', 'warning', 'danger', 'info'] as const;
const SIZE = ['sm', 'md', 'lg', 'xl'] as const;
const WEIGHT = ['normal', 'medium', 'semibold', 'bold'] as const;
const RADIUS = ['none', 'sm', 'md', 'lg', 'xl', 'full'] as const;
const SHADOW = ['none', 'sm', 'md'] as const;
const SURFACE = ['none', 'soft', 'solid'] as const;
const BUTTON_VARIANT = ['primary', 'secondary', 'ghost', 'danger'] as const;

/**
 * 内置图标白名单（lucide 名字的子集）。
 * 前后端共用同一份名字；前端未命中时回退 Sparkles。
 */
export const UI_ICONS = [
  'activity',
  'alert-triangle',
  'arrow-right',
  'arrow-up-right',
  'bar-chart-3',
  'bell',
  'book-open',
  'bot',
  'calendar',
  'check',
  'check-circle',
  'chevron-right',
  'clock',
  'code',
  'copy',
  'cpu',
  'database',
  'download',
  'external-link',
  'eye',
  'file',
  'file-text',
  'flag',
  'folder',
  'globe',
  'heart',
  'help-circle',
  'home',
  'info',
  'layers',
  'lightbulb',
  'link',
  'list',
  'lock',
  'mail',
  'map-pin',
  'message-circle',
  'package',
  'play',
  'plus',
  'refresh-cw',
  'search',
  'settings',
  'shield',
  'star',
  'terminal',
  'trash',
  'trending-down',
  'trending-up',
  'user',
  'users',
  'wallet',
  'x',
  'x-circle',
  'zap',
] as const;

export type UIIconName = (typeof UI_ICONS)[number];

export const UI_COMPONENTS: readonly UIComponentSpec[] = [
  {
    name: 'Box',
    description: '一维布局容器：方向、对齐、间距、内边距、边框、圆角、表面、阴影、宽高',
    props: {
      direction: { kind: 'enum', values: ['row', 'col'] },
      align: { kind: 'enum', values: ['start', 'center', 'end', 'stretch'] },
      justify: { kind: 'enum', values: ['start', 'center', 'end', 'between'] },
      gap: { kind: 'number', min: 0, max: 8 },
      padding: { kind: 'number', min: 0, max: 8 },
      border: { kind: 'boolean' },
      tone: { kind: 'enum', values: TONE },
      surface: { kind: 'enum', values: SURFACE },
      radius: { kind: 'enum', values: RADIUS },
      shadow: { kind: 'enum', values: SHADOW },
      width: { kind: 'bindingOrValue' },
      wrap: { kind: 'boolean' },
      height: { kind: 'number', min: 8, max: 600 },
    },
    children: true,
  },
  {
    name: 'Grid',
    description: '严格网格：columns 列等宽，适合卡片组、多列布局与棋盘',
    props: {
      columns: { kind: 'number', required: true, min: 1, max: 24 },
      gap: { kind: 'number', min: 0, max: 8 },
      padding: { kind: 'number', min: 0, max: 8 },
      align: { kind: 'enum', values: ['start', 'center', 'stretch'] },
    },
    children: true,
  },
  {
    name: 'Card',
    description: '分组卡片：可选标题/副标题，默认带边框、圆角与轻阴影',
    props: {
      title: { kind: 'string', maxLength: 2000 },
      subtitle: { kind: 'string', maxLength: 2000 },
      tone: { kind: 'enum', values: TONE },
      padding: { kind: 'number', min: 0, max: 8 },
      border: { kind: 'boolean' },
      radius: { kind: 'enum', values: RADIUS },
      shadow: { kind: 'enum', values: SHADOW },
      /** 紧凑模式：减小标题与内容间距 */
      compact: { kind: 'boolean' },
    },
    children: true,
  },
  {
    name: 'Section',
    description: '小节：标题 + 说明 + 内容，自动留出上下间距',
    props: {
      title: { kind: 'string', maxLength: 2000 },
      description: { kind: 'string', maxLength: 2000 },
      gap: { kind: 'number', min: 0, max: 8 },
    },
    children: true,
  },
  {
    name: 'Divider',
    description: '分隔线，可带中置标签',
    props: { label: { kind: 'string', maxLength: 200 } },
  },
  {
    name: 'Title',
    description: '标题文本',
    props: {
      size: { kind: 'enum', values: SIZE },
      tone: { kind: 'enum', values: TONE },
      weight: { kind: 'enum', values: WEIGHT },
      align: { kind: 'enum', values: ['left', 'center', 'right'] },
    },
    children: true,
    requiredChildren: true,
  },
  {
    name: 'Text',
    description: '正文文本（支持内联 Text/Badge 子节点）',
    props: {
      size: { kind: 'enum', values: ['xs', 'sm', 'md', 'lg'] as const },
      tone: { kind: 'enum', values: TONE },
      weight: { kind: 'enum', values: WEIGHT },
      align: { kind: 'enum', values: ['left', 'center', 'right'] },
      mono: { kind: 'boolean' },
      truncate: { kind: 'boolean' },
    },
    children: true,
    requiredChildren: true,
  },
  {
    name: 'Markdown',
    description: 'Markdown 文本（复用站内安全渲染管线）',
    props: {},
    children: true,
    requiredChildren: true,
  },
  {
    name: 'Badge',
    description: '状态徽标：soft/solid/outline 三种样式，可带圆点',
    props: {
      tone: { kind: 'enum', values: TONE },
      variant: { kind: 'enum', values: ['soft', 'solid', 'outline'] as const },
      dot: { kind: 'boolean' },
    },
    children: true,
    requiredChildren: true,
  },
  {
    name: 'Stat',
    description: '指标卡：标签 + 数值 + 提示 + 变化量（上涨/下跌）',
    props: {
      label: { kind: 'string', required: true, maxLength: 200 },
      value: { kind: 'bindingOrValue', required: true },
      hint: { kind: 'string', maxLength: 500 },
      delta: { kind: 'bindingOrValue' },
      trend: { kind: 'enum', values: ['up', 'down', 'flat'] as const },
      tone: { kind: 'enum', values: TONE },
      size: { kind: 'enum', values: ['md', 'lg'] as const },
    },
  },
  {
    name: 'List',
    description: '列表：每项 label + 可选描述/右侧值/图标/色调',
    props: {
      items: { kind: 'listItems', required: true },
      dense: { kind: 'boolean' },
      dividers: { kind: 'boolean' },
    },
  },
  {
    name: 'Timeline',
    description: '时间线：每项 label + 描述 + 时间 + 图标/色调',
    props: { items: { kind: 'timelineItems', required: true } },
  },
  {
    name: 'Table',
    description: '数据表格：列定义 + 行数据（单元格可为绑定）',
    props: {
      columns: { kind: 'columns', required: true },
      rows: { kind: 'rows', required: true },
      striped: { kind: 'boolean' },
      dense: { kind: 'boolean' },
    },
  },
  {
    name: 'Chart',
    description: '图表：柱状/折线/面积/饼图（ECharts 渲染，非手绘 SVG）',
    props: {
      kind: { kind: 'enum', values: ['bar', 'line', 'area', 'pie'], required: true },
      data: { kind: 'chartData', required: true },
      height: { kind: 'number', min: 120, max: 600 },
      tone: { kind: 'enum', values: TONE },
      title: { kind: 'string', maxLength: 200 },
    },
  },
  {
    name: 'Sparkline',
    description: '迷你折线（无坐标轴，适合指标卡内的趋势）',
    props: {
      values: { kind: 'numbers', required: true },
      height: { kind: 'number', min: 24, max: 160 },
      tone: { kind: 'enum', values: TONE },
    },
  },
  {
    name: 'KeyValue',
    description: '键值列表',
    props: {
      items: { kind: 'keyValueItems', required: true },
      columns: { kind: 'number', min: 1, max: 4 },
    },
  },
  {
    name: 'Progress',
    description: '进度条：可显示百分比数值',
    props: {
      value: { kind: 'number', required: true, min: 0, max: 100 },
      max: { kind: 'number', min: 1, max: 1000 },
      label: { kind: 'string', maxLength: 500 },
      tone: { kind: 'enum', values: TONE },
      showValue: { kind: 'boolean' },
    },
  },
  {
    name: 'Slider',
    description: '滑块输入：value 绑定 state，onChange 写 state',
    props: {
      min: { kind: 'number' },
      max: { kind: 'number' },
      step: { kind: 'number' },
      value: { kind: 'bindingOrValue' },
      label: { kind: 'string', maxLength: 500 },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'NumberInput',
    description: '数字输入',
    props: {
      min: { kind: 'number' },
      max: { kind: 'number' },
      step: { kind: 'number' },
      value: { kind: 'bindingOrValue' },
      label: { kind: 'string', maxLength: 500 },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'TextInput',
    description: '文本输入',
    props: {
      placeholder: { kind: 'string', maxLength: 500 },
      value: { kind: 'bindingOrValue' },
      label: { kind: 'string', maxLength: 500 },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'Select',
    description: '下拉选择',
    props: {
      options: { kind: 'options', required: true },
      value: { kind: 'bindingOrValue' },
      label: { kind: 'string', maxLength: 500 },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'Switch',
    description: '开关',
    props: {
      checked: { kind: 'bindingOrValue' },
      label: { kind: 'string', maxLength: 500 },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'Checkbox',
    description: '复选框',
    props: {
      checked: { kind: 'bindingOrValue' },
      label: { kind: 'string', maxLength: 500 },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'RadioGroup',
    description: '单选组：options + value + onChange',
    props: {
      options: { kind: 'options', required: true },
      value: { kind: 'bindingOrValue' },
      label: { kind: 'string', maxLength: 500 },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'SegmentedControl',
    description: '分段选择器：options + value + onChange（紧凑的标签切换）',
    props: {
      options: { kind: 'options', required: true },
      value: { kind: 'bindingOrValue' },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'Button',
    description: '按钮：value 作为点击事件值写回 state；onClick 绑定本地动作',
    props: {
      label: { kind: 'string', required: true, maxLength: 500 },
      variant: { kind: 'enum', values: BUTTON_VARIANT },
      size: { kind: 'enum', values: ['sm', 'md', 'lg'] as const },
      full: { kind: 'boolean' },
      icon: { kind: 'enum', values: UI_ICONS },
      value: { kind: 'bindingOrValue' },
      onClick: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'Icon',
    description: '图标：内置 lucide 名字白名单',
    props: {
      name: { kind: 'enum', values: UI_ICONS, required: true },
      size: { kind: 'number', min: 12, max: 64 },
      tone: { kind: 'enum', values: TONE },
    },
  },
  {
    name: 'Avatar',
    description: '头像：取名字首字母，或使用图片地址',
    props: {
      name: { kind: 'string', maxLength: 200 },
      src: { kind: 'string', maxLength: 4000 },
      size: { kind: 'enum', values: ['sm', 'md', 'lg'] as const },
      tone: { kind: 'enum', values: TONE },
    },
  },
  {
    name: 'Code',
    description: '等宽代码块（不执行、不解析）',
    props: {
      code: { kind: 'string', required: true, maxLength: 20000 },
      lang: { kind: 'string', maxLength: 40 },
      height: { kind: 'number', min: 60, max: 600 },
    },
  },
  {
    name: 'Tabs',
    description: '标签页：items[].content 为子节点',
    props: {
      items: { kind: 'tabItems', required: true },
      value: { kind: 'bindingOrValue' },
      onChange: { kind: 'bindingOrAction' },
    },
  },
  {
    name: 'Image',
    description: '图片：src 只允许 /api/filesystem/media 本机媒体通道',
    props: {
      src: { kind: 'string', required: true, maxLength: 4000 },
      alt: { kind: 'string', maxLength: 500 },
      height: { kind: 'number', min: 40, max: 800 },
      fit: { kind: 'enum', values: ['cover', 'contain'] as const },
      radius: { kind: 'enum', values: RADIUS },
    },
  },
  {
    name: 'Callout',
    description: '提示块：info/success/warning/danger，可带图标',
    props: {
      tone: { kind: 'enum', values: ['info', 'success', 'warning', 'danger'] as const },
      title: { kind: 'string', maxLength: 500 },
      icon: { kind: 'enum', values: UI_ICONS },
    },
    children: true,
    requiredChildren: true,
  },
  {
    name: 'Embed',
    description: '嵌入完整 HTML/TSX 页面（沙箱 iframe）；TSX 由服务端编译；mode/source 必须是字面量，source 建议 < 150KB',
    props: {
      mode: { kind: 'enum', values: ['html', 'tsx'] as const, required: true },
      source: { kind: 'string', required: true, maxLength: 150_000 },
      title: { kind: 'string', maxLength: 500 },
      height: { kind: 'number', min: 240, max: 1200 },
    },
  },
  {
    name: 'EmptyState',
    description: '空状态占位',
    props: {
      title: { kind: 'string', maxLength: 500 },
      text: { kind: 'string', maxLength: 2000 },
      icon: { kind: 'enum', values: UI_ICONS },
    },
  },
];

/** 组件名 → 规格 */
export const UI_COMPONENT_MAP: ReadonlyMap<string, UIComponentSpec> = new Map(
  UI_COMPONENTS.map((c) => [c.name, c]),
);

/** 稳定排序的组件名列表（SDK 文本/测试用） */
export const UI_COMPONENT_NAMES: readonly string[] = UI_COMPONENTS.map((c) => c.name)
  .slice()
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** 生成本次 ui 命名空间的 TypeScript 声明（系统提示 SDK 代码块；说明文字在 agent/prompt/code-mode/ui-sdk.md） */
export function buildUiDeclarations(): string {
  const lines: string[] = [
    '```ts',
    'type UIStateValue = string | number | boolean | null;',
    'type UIBinding = { $state: string } | { $expr: string } | { $action: UIAction };',
    'type UIAction =',
    "  | { kind: 'set'; key: string }",
    "  | { kind: 'toggle'; key: string }",
    "  | { kind: 'apply'; key: string; expr: string }",
    "  | { kind: 'reset' }",
    "  | { kind: 'seq'; actions: UIAction[] }",
    "  | { kind: 'copy'; text: string | UIBinding }",
    "  | { kind: 'open'; href: string | UIBinding };",
    'type UINode = { type: string; props?: Record<string, unknown>; children?: Array<UINode | string | UIBinding> };',
    `type UIIconName = ${UI_ICONS.map((value) => `'${value}'`).join(' | ')};`,
    '```',
  ];

  // 组件工厂声明（按字典序，保证系统提示字节稳定）；Markdown 用特化签名
  for (const name of UI_COMPONENT_NAMES) {
    if (name === 'Markdown') continue;
    const spec = UI_COMPONENT_MAP.get(name);
    if (!spec) continue;
    lines.push(`/** ${spec.description} */`);
    const props = Object.entries(spec.props)
      .map(([key, p]) => `${key}${p.required ? '' : '?'}: ${propTsType(p)}`)
      .join('; ');
    const propsArg = props ? `{ ${props} }` : 'Record<string, never>';
    const childrenArg = spec.children
      ? ', children?: UINode | string | UIBinding | Array<UINode | string | UIBinding>'
      : '';
    lines.push(`ui.${lowerFirst(name)}(props?: ${propsArg}${childrenArg}): UINode;`);
  }

  lines.push(
    'ui.markdown(text: string): UINode;',
    'ui.state(key: string, initial: UIStateValue): UIBinding;',
    'ui.expr(source: string): UIBinding;',
    'ui.set(key: string): UIBinding;',
    'ui.apply(key: string, expr: string): UIBinding;',
    'ui.reset(): UIBinding;',
    'ui.seq(...actions: UIBinding[]): UIBinding;',
    'ui.toggle(key: string): UIBinding;',
    'ui.copy(text: string | UIBinding): UIBinding;',
    'ui.open(href: string | UIBinding): UIBinding;',
    'ui.render(root: UINode, options?: { title?: string; framed?: boolean }): void;',
    '```',
  );
  return lines.join('\n');
}

function propTsType(p: UIPropSpec): string {
  switch (p.kind) {
    case 'string':
      return 'string | UIBinding';
    case 'number':
      return 'number | UIBinding';
    case 'boolean':
      return 'boolean | UIBinding';
    case 'enum': {
      // 图标白名单很长：用共享类型名，避免 4 个组件各重复一遍
      if (p.values === UI_ICONS) return 'UIIconName | UIBinding';
      const union = (p.values ?? []).map((v) => `'${v}'`).join(' | ') || 'string';
      return `${union} | UIBinding`;
    }
    case 'columns':
      return 'Array<{ key: string; label: string; align?: \'left\' | \'center\' | \'right\' }>';
    case 'rows':
      return 'Array<Array<UIStateValue | UIBinding>>';
    case 'chartData':
      return 'Array<{ label: string; value: number }>';
    case 'keyValueItems':
      return 'Array<{ label: string; value: UIStateValue | UIBinding }>';
    case 'listItems':
      return 'Array<{ label: string; description?: string; value?: UIStateValue | UIBinding; icon?: string; tone?: string }>';
    case 'timelineItems':
      return 'Array<{ label: string; description?: string; time?: string; tone?: string }>';
    case 'numbers':
      return 'number[]';
    case 'options':
      return 'Array<{ value: string; label: string }>';
    case 'tabItems':
      return 'Array<{ value: string; label: string; content: UINode }>';
    case 'bindingOrValue':
      return 'UIStateValue | UIBinding';
    case 'bindingOrAction':
      return 'UIBinding';
    default:
      return 'unknown';
  }
}

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
