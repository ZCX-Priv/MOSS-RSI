// webui/src/render/genui/types.ts
// Intelligent UI 前端类型（与后端 src/modules/tools/run_code/ui/spec.ts 对齐）。
// UI 只是 JSON 规格，前端按组件目录渲染；不执行任意 JS/HTML。

export type GenUIStateValue = string | number | boolean | null;

export type GenUIAction =
  | { kind: 'set'; key: string }
  | { kind: 'toggle'; key: string }
  | { kind: 'apply'; key: string; expr: string }
  | { kind: 'reset' }
  | { kind: 'seq'; actions: GenUIAction[] }
  | { kind: 'copy'; text: string | GenUIBinding }
  | { kind: 'open'; href: string | GenUIBinding };

export type GenUIBinding =
  | { $state: string }
  | { $expr: string }
  | { $action: GenUIAction };

export interface GenUINode {
  type: string;
  props?: Record<string, GenUIPropValue>;
  children?: Array<GenUINode | string | GenUIBinding>;
}

export type GenUIPropValue =
  | GenUIStateValue
  | GenUIBinding
  | GenUIPropValue[]
  | { [key: string]: GenUIPropValue };

export interface GenUISpec {
  version: 1;
  title?: string;
  root: GenUINode;
  state: Record<string, GenUIStateValue>;
}

export interface GenUIDiagnostic {
  code: string;
  path: string;
  detail?: string;
  severity: 'warning' | 'error';
}

export const GENUI_LIMITS = {
  maxNodes: 500,
  maxDepth: 20,
  maxTextChars: 20_000,
  maxSpecBytes: 262_144,
  maxExprChars: 512,
  /** 动作序列：单个 seq 的动作数与嵌套深度 */
  maxSeqActions: 32,
  maxActionDepth: 4,
} as const;

/** 绑定判定：只认三种精确形状，避免把业务对象误判为绑定 */
export function asGenUIBinding(value: unknown): GenUIBinding | null {
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
    return isGenUIAction(v) ? { $action: v } : null;
  }
  return null;
}

export function isGenUIAction(value: unknown, depth = 0): value is GenUIAction {
  if (depth > GENUI_LIMITS.maxActionDepth) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  if (a.kind === 'set' || a.kind === 'toggle') return typeof a.key === 'string';
  if (a.kind === 'apply') {
    return typeof a.key === 'string' && typeof a.expr === 'string' && a.expr.length > 0;
  }
  if (a.kind === 'reset') return true;
  if (a.kind === 'seq') {
    return (
      Array.isArray(a.actions) &&
      a.actions.length <= GENUI_LIMITS.maxSeqActions &&
      a.actions.every((child) => isGenUIAction(child, depth + 1))
    );
  }
  if (a.kind === 'copy') return typeof a.text === 'string' || asGenUIBinding(a.text) !== null;
  if (a.kind === 'open') return typeof a.href === 'string' || asGenUIBinding(a.href) !== null;
  return false;
}

/** 判断未知值是否像 UISpec（历史回放/跨版本防御） */
export function isGenUISpec(value: unknown): value is GenUISpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as Record<string, unknown>;
  if (spec.version !== 1) return false;
  const root = spec.root;
  return !!root && typeof root === 'object' && typeof (root as { type?: unknown }).type === 'string';
}
