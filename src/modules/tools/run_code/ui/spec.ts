// src/modules/tools/run_code/ui/spec.ts
// Intelligent UI 的声明式规格：组件树 + 状态 + 受限绑定。
// 设计原则（对齐 OpenAI Intelligent UI 的架构原则）：
//   1. UI 是受组件目录约束的程序化产物，不是 HTML/DOM；
//   2. 模型不能注入任意标签/CSS/JS，只能产出 JSON 规格；
//   3. 交互由前端受限表达式解释器在本地完成，不触发模型调用；
//   4. 所有绑定只允许三种：读 state、受限表达式、事件动作。

/** JSON 可表示的状态值（UI 状态只允许标量，避免复杂对象污染） */
export type UIStateValue = string | number | boolean | null;

/**
 * 事件动作：本地闭环，不调用模型。
 * apply/seq/reset 提供受限的本地状态计算（无循环/定时器/随机数），
 * 用于回合制棋盘、逐步试算等需要「一次点击推进多步状态」的场景。
 */
export type UIAction =
  | { kind: 'set'; key: string }
  | { kind: 'toggle'; key: string }
  | { kind: 'apply'; key: string; expr: string }
  | { kind: 'reset' }
  | { kind: 'seq'; actions: UIAction[] }
  | { kind: 'copy'; text: string | UIBinding }
  | { kind: 'open'; href: string | UIBinding };

/** 属性绑定：读状态 / 受限表达式 / 事件动作 */
export type UIBinding =
  | { $state: string }
  | { $expr: string }
  | { $action: UIAction };

/** 组件树节点：children 允许字符串（文本）、子节点或文本绑定（{expr}/{state}） */
export interface UINode {
  type: string;
  props?: Record<string, UIPropValue>;
  children?: Array<UINode | string | UIBinding>;
}

/** 属性值：标量 / 绑定 / 嵌套数组或对象（用于表格、图表等结构化数据） */
export type UIPropValue =
  | UIStateValue
  | UIBinding
  | UIPropValue[]
  | { [key: string]: UIPropValue };

/** 一次 run_code 产生的界面规格 */
export interface UISpec {
  version: 1;
  title?: string;
  root: UINode;
  /** 初始状态（刷新后回到这里；不在会话中持久化交互后的值） */
  state: Record<string, UIStateValue>;
}

/** 编译/校验诊断 */
export interface UIDiagnostic {
  /** 稳定机器码（前端可做 i18n） */
  code: string;
  /** 节点路径，如 root.children[0].props.value */
  path: string;
  /** 人类可读补充信息（英文，技术细节） */
  detail?: string;
  severity: 'warning' | 'error';
}

/** 规格上限（与前端渲染器共享同一组常量语义） */
export const UI_LIMITS = {
  /** 节点总数 */
  maxNodes: 500,
  /** 树深度 */
  maxDepth: 20,
  /** 单个文本节点字符数 */
  maxTextChars: 20_000,
  /** 序列化后的规格字节数 */
  maxSpecBytes: 262_144,
  /** 单条表达式字符数 */
  maxExprChars: 512,
  /** 一个节点的子节点数（与 maxNodes 同量级；允许 20×20 棋盘） */
  maxChildren: 500,
  /** 表格列数 / 行数 */
  maxTableColumns: 12,
  maxTableRows: 200,
  /** 图表数据点 */
  maxChartPoints: 100,
  /** KeyValue / Select / Tabs 条目数 */
  maxListItems: 50,
  maxTabs: 12,
} as const;

/** 合法的 state key / 表达式标识符 */
export const UI_STATE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 禁止作为状态键的名称（原型污染面） */
const FORBIDDEN_STATE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** 判断一个字符串是否可作为 UI state key */
export function isValidStateKey(key: string): boolean {
  return UI_STATE_KEY_RE.test(key) && !FORBIDDEN_STATE_KEYS.has(key);
}

/** 判断是否为绑定对象（只认三种精确形状，避免误判业务对象） */
export function asBinding(value: unknown): UIBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (key === '$state') {
    const v = (value as { $state?: unknown }).$state;
    return typeof v === 'string' ? { $state: v } : null;
  }
  if (key === '$expr') {
    const v = (value as { $expr?: unknown }).$expr;
    return typeof v === 'string' ? { $expr: v } : null;
  }
  if (key === '$action') {
    const v = (value as { $action?: unknown }).$action;
    return isUIAction(v) ? { $action: v } : null;
  }
  return null;
}

/** 动作序列上限（校验器与前端执行器共享语义） */
export const UI_ACTION_LIMITS = {
  /** 单个 seq 的动作数 */
  maxSeqActions: 32,
  /** seq 嵌套深度 */
  maxDepth: 4,
} as const;

/** 判断是否为合法 UIAction（递归校验 seq；depth 防止恶意深嵌套） */
export function isUIAction(value: unknown, depth = 0): value is UIAction {
  if (depth > UI_ACTION_LIMITS.maxDepth) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  const kind = a.kind;
  if (kind === 'set' || kind === 'toggle') {
    return typeof a.key === 'string' && isValidStateKey(a.key);
  }
  if (kind === 'apply') {
    if (typeof a.key !== 'string' || !isValidStateKey(a.key)) return false;
    if (typeof a.expr !== 'string') return false;
    return isSafeExprSource(a.expr).ok;
  }
  if (kind === 'reset') return true;
  if (kind === 'seq') {
    // 空 seq 是合法 no-op（构建器在参数非法时用它兜底）
    if (!Array.isArray(a.actions) || a.actions.length > UI_ACTION_LIMITS.maxSeqActions) return false;
    return a.actions.every((child) => isUIAction(child, depth + 1));
  }
  if (kind === 'copy') {
    return typeof a.text === 'string' || asBinding(a.text) !== null;
  }
  if (kind === 'open') {
    return typeof a.href === 'string' || asBinding(a.href) !== null;
  }
  return false;
}

/** 表达式静态检查：只做安全与长度约束，完整求值在前端解释器。 */
export function isSafeExprSource(source: string): { ok: true } | { ok: false; reason: string } {
  if (source.length === 0) return { ok: false, reason: 'empty expression' };
  if (source.length > UI_LIMITS.maxExprChars) {
    return { ok: false, reason: `expression exceeds ${UI_LIMITS.maxExprChars} chars` };
  }
  // 先剥离字符串字面量与数字字面量，避免其中合法的 . [ ] 被误判；
  // 再剥离比较运算符（== != <= >=），最后剩余字符里出现属性穿透、索引、
  // 对象/数组字面量、赋值、语句分隔即拒绝。
  const withoutStrings = source.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
  const withoutNumbers = withoutStrings.replace(/(?:\d+(?:\.\d*)?|\.\d+)/g, '0');
  const withoutComparisons = withoutNumbers.replace(/==|!=|<=|>=/g, ' ');
  if (/[.[\]{};=]/.test(withoutComparisons)) {
    return { ok: false, reason: 'property access, indexing, literals, assignment and statements are not allowed' };
  }
  if (/`/.test(withoutComparisons)) return { ok: false, reason: 'template literals are not allowed' };
  if (/(^|[^A-Za-z0-9_$])(eval|Function|constructor|prototype|__proto__)([^A-Za-z0-9_$]|$)/.test(source)) {
    return { ok: false, reason: 'forbidden identifier' };
  }
  return { ok: true };
}

/** 图片地址白名单：只允许本机媒体通道，避免外链追踪/数据注入 */
export function isSafeImageSrc(src: string): boolean {
  return src.startsWith('/api/filesystem/media?') || src.startsWith('/api/filesystem/media/');
}
