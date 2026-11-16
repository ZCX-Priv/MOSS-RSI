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

/** 生成本次 ui 命名空间的 TypeScript 声明（系统提示 SDK 段） */
export function buildUiSdkText(): string {
  const lines: string[] = [
    '### ui 构建器（规格化智能界面）',
    '',
    '在 run_code 程序内用 `ui.*` 构建界面规格；前端会把它渲染在「代码」步骤下方的消息流里。',
    '除 `Embed` 外，它不是 HTML/iframe，也不是工具卡片；交互在浏览器本地闭环（点击/输入只改 state、重算表达式），不会回调模型。',
    '',
    '**何时用**：数据仪表盘、表单、计算器、筛选器、配置器、数据浏览器、状态驱动的棋盘/小游戏。',
    '**何时不用**：一次问答、纯文本结论、代码解释；需要任意 CSS/动画/像素级视觉时，改用 run_code 的 `page` 参数（见「内嵌页面」说明）；在智能界面内部需要局部页面时用 `ui.embed({ mode, source })`。',
    '**禁令**：不要用 `browser` 截图冒充聊天内界面；`browser` 只用于访问/验证外部网页。',
    '',
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
    '',
    '**视觉属性（所有布局/容器/文本组件通用）**',
    "- `tone`：default | muted | primary | success | warning | danger | info",
    '- `radius`：none | sm | md | lg | xl | full；`shadow`：none | sm | md',
    '- `surface`：none（透明）| soft（浅底）| solid（实底）；`border`：布尔',
    '- `gap` / `padding`：0-8 的间距刻度（1 ≈ 4px）',
    '- 小标签用 `Text size="xs"`；数值用 `Stat` 或 `Text` 的 tabular 风格；重点数字用 `Title`',
    '',
    '**布局**',
    '- 多列/等宽/棋盘：用 `ui.grid({ columns })`；一维排列用 `ui.box({ direction, align, justify, gap, wrap })`。',
    '- `Box row` 只放短内容；Table/Chart/长文本让它独占一行，避免被挤压。',
    '- 成组信息优先 `ui.card({ title })`；小节之间用 `ui.section` 或 `ui.divider`。',
    '',
    '**状态与交互**',
    '- 交互状态必须用 `ui.state(key, initial)` 声明；程序里的普通变量在程序结束后不存在。',
    '- `ui.state` 的返回值是绑定对象，只用于 props；表达式字符串里直接写 state key 名（如 `body`），不要写 JS 变量名。',
    '- 必须调用 `ui.render(root)` 才会显示；只构建节点不 render 等于没做。',
    '- `ui.set(key)` 写入输入组件的当前值或 Button 的 `value`；`ui.apply(key, expr)` 用表达式计算并写回。',
    '- `ui.seq(...actions)` 顺序执行，后一步能读到前一步的写入结果；`ui.reset()` 让所有 state 回到初始值。',
    '- 表达式只读 state 顶层键，支持 `+ - * / %`、比较、`&& || !`、三元、括号；函数：`round/floor/ceil/abs/min/max/len/number/string/contains/indexOf/lastIndexOf/slice/part/charAt`。',
    '- 禁止属性访问/索引/赋值/循环/定时器/随机数；只支持事件驱动的回合制交互，不支持实时动画。',
    '- 所有标量属性都可以传 UIBinding 做动态渲染（例如按状态给格子上色）。',
    '',
    '**示例 1：指标仪表盘**',
    '```ts',
    "ui.render(ui.box({ gap: 3 }, [",
    "  ui.box({ direction: 'row', justify: 'between', align: 'center' }, [",
    "    ui.box({ gap: 0.5 }, [ui.title({ size: 'lg' }, '收入概览'), ui.text({ size: 'xs', tone: 'muted' }, '最近 30 天')]),",
    "    ui.badge({ tone: 'success', variant: 'soft', dot: true }, '实时'),",
    '  ]),',
    "  ui.grid({ columns: 3, gap: 2 }, [",
    "    ui.stat({ label: '总收入', value: '¥128,400', delta: '+12.4%', trend: 'up', tone: 'primary' }),",
    "    ui.stat({ label: '订单数', value: '1,284', delta: '+3.1%', trend: 'up' }),",
    "    ui.stat({ label: '退款率', value: '1.2%', delta: '-0.3%', trend: 'down', tone: 'success' }),",
    '  ]),',
    "  ui.chart({ kind: 'area', height: 220, data: [{ label: '周一', value: 12 }, { label: '周二', value: 18 }, { label: '周三', value: 9 }] }),",
    "]), { title: '经营看板' });",
    '```',
    '',
    '**示例 2：回合制贪吃蛇（10×10）**',
    '```ts',
    'const W = 10;',
    "const body = ui.state('body', '5,5;4,5;3,5');",
    "const dir = ui.state('dir', 'right');",
    "ui.state('hx', 5); ui.state('hy', 5);",
    "ui.state('nx', 5); ui.state('ny', 5);",
    "ui.state('hit', 0); ui.state('eat', 0);",
    "ui.state('score', 0); ui.state('status', 0);",
    "ui.state('fx', 7); ui.state('fy', 3);",
    'const cells = [];',
    'for (let y = 0; y < W; y++) {',
    '  for (let x = 0; x < W; x++) {',
    '    cells.push(ui.box({',
    "      height: 26, radius: 'sm', surface: 'soft', border: true,",
    "      tone: ui.expr(`contains(body, '${x},${y}') ? (hx == ${x} && hy == ${y} ? 'primary' : 'success') : (${x} == fx && ${y} == fy ? 'warning' : 'muted')`),",
    '    }));',
    '  }',
    '}',
    "ui.render(ui.card({ title: '贪吃蛇', subtitle: '回合制 · 10×10' }, [",
    "  ui.grid({ columns: 2, gap: 2 }, [",
    "    ui.stat({ label: '得分', value: ui.expr('score'), tone: 'primary' }),",
    "    ui.stat({ label: '状态', value: ui.expr(\"status == 2 ? '已结束' : '进行中'\"), tone: ui.expr(\"status == 2 ? 'danger' : 'success'\") }),",
    '  ]),',
    '  ui.grid({ columns: W, gap: 0.5 }, cells),',
    "  ui.box({ direction: 'row', gap: 2, justify: 'center' }, [",
    "    ui.button({ label: '↑', variant: 'secondary', value: 'up', onClick: ui.set('dir') }),",
    "    ui.button({ label: '←', variant: 'secondary', value: 'left', onClick: ui.set('dir') }),",
    "    ui.button({ label: '↓', variant: 'secondary', value: 'down', onClick: ui.set('dir') }),",
    "    ui.button({ label: '→', variant: 'secondary', value: 'right', onClick: ui.set('dir') }),",
    '  ]),',
    "  ui.box({ direction: 'row', gap: 2 }, [",
    "    ui.button({ label: '前进一步', onClick: ui.seq(",
    `      ui.apply('nx', 'status == 2 ? hx : hx + (dir == "left" ? -1 : dir == "right" ? 1 : 0)'),`,
    `      ui.apply('ny', 'status == 2 ? hy : hy + (dir == "up" ? -1 : dir == "down" ? 1 : 0)'),`,
    `      ui.apply('hit', 'status == 2 ? 0 : (nx < 0 || nx > 9 || ny < 0 || ny > 9 || contains(slice(body, 0, lastIndexOf(body, ";")), nx + "," + ny) ? 1 : 0)'),`,
    `      ui.apply('eat', 'hit == 0 && nx == fx && ny == fy ? 1 : 0'),`,
    `      ui.apply('status', 'hit == 1 ? 2 : status'),`,
    `      ui.apply('score', 'eat == 1 ? score + 1 : score'),`,
    `      ui.apply('body', 'hit == 1 ? body : (eat == 1 ? nx + "," + ny + ";" + body : nx + "," + ny + ";" + slice(body, 0, lastIndexOf(body, ";")))'),`,
    `      ui.apply('hx', 'hit == 1 ? hx : nx'),`,
    `      ui.apply('hy', 'hit == 1 ? hy : ny'),`,
    `      ui.apply('fx', 'eat == 1 ? (score * 3 + 1) % 10 : fx'),`,
    `      ui.apply('fy', 'eat == 1 ? (score * 7 + 3) % 10 : fy')`,
    '    ) }),',
    "    ui.button({ label: '重新开始', variant: 'secondary', onClick: ui.reset() }),",
    '  ]),',
    "  ui.text({ size: 'xs', tone: 'muted' }, ui.expr('\"得分 \" + score + (status == 2 ? \" · 撞到自己了\" : \"\")')),",
    ']), { title: \"贪吃蛇\" });',
    '```',
    '',
    '**规则**',
    '- state key 只能是 `[A-Za-z_][A-Za-z0-9_]{0,63}`；禁止 `__proto__`/`prototype`/`constructor`。',
    '- `Image.src` 只允许 `/api/filesystem/media?...` 本机媒体地址；不支持外链与 data URL。',
    '- 界面渲染失败会回退到文本结果并附诊断；不要让整段程序只依赖 UI。',
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
