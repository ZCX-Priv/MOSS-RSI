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
const WEIGHT = ['normal', 'medium', 'semibold'] as const;
const BUTTON_VARIANT = ['primary', 'secondary', 'ghost'] as const;

export const UI_COMPONENTS: readonly UIComponentSpec[] = [
  {
    name: 'Box',
    description: '一维布局容器：方向、对齐、间距、内边距、边框、圆角、色调、高度',
    props: {
      direction: { kind: 'enum', values: ['row', 'col'] },
      align: { kind: 'enum', values: ['start', 'center', 'end', 'stretch'] },
      justify: { kind: 'enum', values: ['start', 'center', 'end', 'between'] },
      gap: { kind: 'number', min: 0, max: 8 },
      padding: { kind: 'number', min: 0, max: 8 },
      border: { kind: 'boolean' },
      radius: { kind: 'enum', values: ['sm', 'md', 'lg'] },
      tone: { kind: 'enum', values: TONE },
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
    },
    children: true,
  },
  {
    name: 'Card',
    description: '分组容器：可选标题；无卡片外框，标题作为小节标题',
    props: {
      title: { kind: 'string', maxLength: 2000 },
    },
    children: true,
  },
  { name: 'Divider', description: '分隔线', props: {} },
  {
    name: 'Title',
    description: '标题文本',
    props: {
      size: { kind: 'enum', values: SIZE },
      tone: { kind: 'enum', values: TONE },
      weight: { kind: 'enum', values: WEIGHT },
    },
    children: true,
    requiredChildren: true,
  },
  {
    name: 'Text',
    description: '正文文本（支持内联 Text/Badge 子节点）',
    props: {
      size: { kind: 'enum', values: SIZE },
      tone: { kind: 'enum', values: TONE },
      weight: { kind: 'enum', values: WEIGHT },
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
    description: '状态徽标',
    props: { tone: { kind: 'enum', values: TONE } },
    children: true,
    requiredChildren: true,
  },
  {
    name: 'Table',
    description: '数据表格：列定义 + 行数据（单元格可为绑定）',
    props: {
      columns: { kind: 'columns', required: true },
      rows: { kind: 'rows', required: true },
      striped: { kind: 'boolean' },
    },
  },
  {
    name: 'Chart',
    description: '图表：柱状/折线/饼图（ECharts 渲染，非手绘 SVG）',
    props: {
      kind: { kind: 'enum', values: ['bar', 'line', 'pie'], required: true },
      data: { kind: 'chartData', required: true },
      height: { kind: 'number', min: 120, max: 600 },
      tone: { kind: 'enum', values: TONE },
      title: { kind: 'string', maxLength: 200 },
    },
  },
  {
    name: 'KeyValue',
    description: '键值列表',
    props: { items: { kind: 'keyValueItems', required: true } },
  },
  {
    name: 'Progress',
    description: '进度条',
    props: {
      value: { kind: 'number', required: true, min: 0, max: 100 },
      max: { kind: 'number', min: 1, max: 1000 },
      label: { kind: 'string', maxLength: 500 },
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
    name: 'Button',
    description: '按钮：value 作为点击事件值写回 state；onClick 绑定本地动作',
    props: {
      label: { kind: 'string', required: true, maxLength: 500 },
      variant: { kind: 'enum', values: BUTTON_VARIANT },
      size: { kind: 'enum', values: ['sm', 'md', 'lg'] },
      full: { kind: 'boolean' },
      value: { kind: 'bindingOrValue' },
      onClick: { kind: 'bindingOrAction' },
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
    },
  },
  {
    name: 'Callout',
    description: '提示块：info/success/warning/danger',
    props: {
      tone: { kind: 'enum', values: ['info', 'success', 'warning', 'danger'] },
      title: { kind: 'string', maxLength: 500 },
    },
    children: true,
    requiredChildren: true,
  },
  {
    name: 'EmptyState',
    description: '空状态占位',
    props: {
      title: { kind: 'string', maxLength: 500 },
      text: { kind: 'string', maxLength: 2000 },
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
    '### ui 构建器（Intelligent UI）',
    '',
    '在 run_code 程序内用 `ui.*` 构建界面规格；前端会把结果直接渲染在「代码」步骤下方的消息流里，与正文连成一体。',
    '它不是 HTML/iframe，也不是工具卡片；交互在浏览器本地闭环（点击/输入只改 state、重算表达式），不会回调模型。',
    '',
    '**何时用**：仪表盘、表单、计算器、筛选器、配置器、数据浏览器、状态驱动的棋盘/小游戏。',
    '**何时不用**：一次问答、纯文本结论、代码解释、只需 Markdown 的内容；不要为了用 UI 而用 UI。',
    '**禁令**：不要用 `browser`、HTML、截图去模拟聊天内界面；`browser` 只用于访问/验证外部网页。',
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
    'ui.render(root: UINode, options?: { title?: string }): void;',
    '```',
    '',
    '**布局**',
    '- 多列/等宽/棋盘：用 `ui.grid({ columns })`；一维排列用 `ui.box({ direction, align, justify, gap, wrap })`。',
    '- `Box row` 只放短内容；Table/Chart/长文本让它独占一行，避免被挤压。',
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
    '**示例 1：滑块试算**',
    '```ts',
    "const seats = ui.state('seats', 8);",
    'ui.render(ui.box({ gap: 2 }, [',
    "  ui.text({ tone: 'muted' }, '团队座位与单价试算'),",
    "  ui.slider({ label: '人数', min: 1, max: 50, value: seats, onChange: ui.set('seats') }),",
    '  ui.text({ weight: \'semibold\' }, ui.expr(\'"总价 ¥" + (seats * 29)\')),',
    "]), { title: '座位试算' });",
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
    "      height: 26, radius: 'sm', border: true,",
    "      tone: ui.expr(`contains(body, '${x},${y}') ? (hx == ${x} && hy == ${y} ? 'primary' : 'success') : (${x} == fx && ${y} == fy ? 'warning' : 'muted')`),",
    '    }));',
    '  }',
    '}',
    'ui.render(ui.box({ gap: 3 }, [',
    '  ui.grid({ columns: W, gap: 1 }, cells),',
    "  ui.box({ direction: 'row', gap: 2, justify: 'center' }, [",
    "    ui.button({ label: '↑', value: 'up', onClick: ui.set('dir') }),",
    "    ui.button({ label: '←', value: 'left', onClick: ui.set('dir') }),",
    "    ui.button({ label: '↓', value: 'down', onClick: ui.set('dir') }),",
    "    ui.button({ label: '→', value: 'right', onClick: ui.set('dir') }),",
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
    "  ui.text({ tone: 'muted' }, ui.expr('\"得分 \" + score + (status == 2 ? \" · 撞到自己了\" : \"\")')),",
    "]), { title: '贪吃蛇' });",
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
