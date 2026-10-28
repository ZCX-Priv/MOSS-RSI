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
    description: '布局容器：方向、间距、内边距、边框、圆角、色调',
    props: {
      direction: { kind: 'enum', values: ['row', 'col'] },
      gap: { kind: 'number', min: 0, max: 8 },
      padding: { kind: 'number', min: 0, max: 8 },
      border: { kind: 'boolean' },
      radius: { kind: 'enum', values: ['sm', 'md', 'lg'] },
      tone: { kind: 'enum', values: TONE },
    },
    children: true,
  },
  {
    name: 'Card',
    description: '卡片容器：可带标题、内边距与色调',
    props: {
      title: { kind: 'string', maxLength: 2000 },
      tone: { kind: 'enum', values: TONE },
      padding: { kind: 'number', min: 0, max: 8 },
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
    description: '按钮：onClick 绑定本地动作（copy/open/toggle/set）',
    props: {
      label: { kind: 'string', required: true, maxLength: 500 },
      variant: { kind: 'enum', values: BUTTON_VARIANT },
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
    '在 run_code 程序内用 `ui.*` 构建可交互界面。界面由受约束的原生组件渲染，不是 HTML/CSS/JS。',
    '状态与交互在浏览器本地闭环：拖动滑块/输入只改 state 并重算表达式，不会调用模型。',
    '',
    '```ts',
    'type UIStateValue = string | number | boolean | null;',
    'type UIBinding = { $state: string } | { $expr: string } | { $action: UIAction };',
    'type UIAction =',
    "  | { kind: 'set'; key: string }",
    "  | { kind: 'toggle'; key: string }",
    "  | { kind: 'copy'; text: string | UIBinding }",
    "  | { kind: 'open'; href: string | UIBinding };",
    'type UINode = { type: string; props?: Record<string, unknown>; children?: Array<UINode | string | UIBinding> };',
  ];

  // 组件工厂声明（按字典序，保证系统提示字节稳定）；Markdown 用特化签名
  for (const name of UI_COMPONENT_NAMES) {
    if (name === 'Markdown') continue;
    const spec = UI_COMPONENT_MAP.get(name);
    if (!spec) continue;
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
    "ui.markdown(text: string): UINode;",
    "ui.state(key: string, initial: UIStateValue): UIBinding;",
    "ui.expr(source: string): UIBinding;",
    "ui.set(key: string): UIBinding;",
    "ui.toggle(key: string): UIBinding;",
    "ui.copy(text: string | UIBinding): UIBinding;",
    "ui.open(href: string | UIBinding): UIBinding;",
    "ui.render(root: UINode, options?: { title?: string }): void;",
    '```',
    '',
    '规则：',
    '- state key 只能是 `[A-Za-z_][A-Za-z0-9_]{0,63}`；禁止 `__proto__`/`prototype`/`constructor`。',
    '- 表达式只支持 `+ - * / %`、比较、`&& || !`、三元、括号与函数 `round/floor/ceil/min/max/abs/len/number/string`；只能读取 state 顶层键，禁止属性访问/索引/赋值。',
    '- `ui.set(key)` 把输入组件的当前值写入 state；`ui.toggle(key)` 翻转布尔；`ui.copy(...)`/`ui.open(...)` 本地执行。',
    '- `Image.src` 只允许 `/api/filesystem/media?...` 本机媒体地址；不支持外链与 data URL。',
    '- 界面渲染失败会回退到文本结果，并附诊断；不要让整段程序只依赖 UI。',
  );
  return lines.join('\n');
}

function propTsType(p: UIPropSpec): string {
  switch (p.kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return (p.values ?? []).map((v) => `'${v}'`).join(' | ') || 'string';
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
