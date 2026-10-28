// src/modules/tools/run_code/ui/validate.ts
// UISpec 校验与净化：组件目录白名单、属性类型、绑定安全、节点/深度/字节上限。
// 这是「宿主边界」的最后一道校验：子进程里的模型代码不可信，只有通过本文件净化后的
// 规格才允许进入 ToolResult.metadata 并持久化到会话，前端再按规格安全渲染。

import {
  UI_COMPONENTS,
  UI_COMPONENT_MAP,
  type UIComponentSpec,
  type UIPropSpec,
} from './catalog';
import {
  asBinding,
  isSafeExprSource,
  isSafeImageSrc,
  isUIAction,
  isValidStateKey,
  UI_LIMITS,
  type UIAction,
  type UIBinding,
  type UIDiagnostic,
  type UINode,
  type UIPropValue,
  type UISpec,
  type UIStateValue,
} from './spec';

export interface UIValidationResult {
  /** 净化后的规格；fatal 或没有 root 时为 undefined */
  spec?: UISpec;
  diagnostics: UIDiagnostic[];
  /** true = 规格不可用（超限/根节点非法），调用方应回退为文本结果 */
  fatal: boolean;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isPrimitive(v: unknown): v is UIStateValue {
  return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * 校验并净化一份 UISpec。
 * 净化策略：未知属性/非法字面量删除并记 warning；未知组件替换为 Unsupported 占位；
 * 缺少结构必需属性或超限则致命失败（调用方回退文本）。
 */
export function validateUISpec(input: unknown): UIValidationResult {
  const diagnostics: UIDiagnostic[] = [];
  let fatal = false;

  if (!isPlainObject(input)) {
    return {
      diagnostics: [{ code: 'invalid_spec', path: 'root', detail: 'spec must be an object', severity: 'error' }],
      fatal: true,
    };
  }
  if (input.version !== 1) {
    return {
      diagnostics: [{ code: 'unsupported_version', path: 'version', detail: String(input.version), severity: 'error' }],
      fatal: true,
    };
  }

  // ---- state ----
  const state: Record<string, UIStateValue> = Object.create(null) as Record<string, UIStateValue>;
  if (input.state !== undefined) {
    if (!isPlainObject(input.state)) {
      diagnostics.push({ code: 'invalid_state', path: 'state', detail: 'state must be an object', severity: 'warning' });
    } else {
      for (const [key, value] of Object.entries(input.state)) {
        if (!isValidStateKey(key)) {
          diagnostics.push({ code: 'invalid_state_key', path: `state.${key}`, severity: 'warning' });
          continue;
        }
        if (!isPrimitive(value)) {
          diagnostics.push({ code: 'invalid_state_value', path: `state.${key}`, severity: 'warning' });
          continue;
        }
        state[key] = value;
      }
    }
  }

  // ---- root ----
  const walkCtx: WalkCtx = { diagnostics, counter: { nodes: 0 }, fatal: false };
  const root = walkNode(input.root, 0, 'root', walkCtx, state);
  if (!root || walkCtx.fatal) fatal = true;

  // ---- title ----
  let title: string | undefined;
  if (typeof input.title === 'string') {
    title = input.title.slice(0, 200);
  }

  const spec: UISpec | undefined = root && !fatal ? { version: 1, ...(title ? { title } : {}), root, state } : undefined;
  if (spec) {
    const bytes = Buffer.byteLength(JSON.stringify(spec), 'utf8');
    if (bytes > UI_LIMITS.maxSpecBytes) {
      diagnostics.push({
        code: 'spec_too_large',
        path: 'root',
        detail: `${bytes} > ${UI_LIMITS.maxSpecBytes} bytes`,
        severity: 'error',
      });
      fatal = true;
    }
  }

  return { spec: fatal ? undefined : spec, diagnostics, fatal };
}

interface WalkCtx {
  diagnostics: UIDiagnostic[];
  counter: { nodes: number };
  fatal: boolean;
}

function diag(
  ctx: WalkCtx,
  code: string,
  path: string,
  severity: 'warning' | 'error' = 'warning',
  detail?: string,
): void {
  ctx.diagnostics.push({ code, path, ...(detail ? { detail } : {}), severity });
}

function walkNode(
  raw: unknown,
  depth: number,
  path: string,
  ctx: WalkCtx,
  state: Record<string, UIStateValue>,
): UINode | null {
  if (ctx.counter.nodes >= UI_LIMITS.maxNodes) {
    diag(ctx, 'too_many_nodes', path, 'error', `> ${UI_LIMITS.maxNodes}`);
    ctx.fatal = true;
    return null;
  }
  if (depth > UI_LIMITS.maxDepth) {
    diag(ctx, 'too_deep', path, 'error', `> ${UI_LIMITS.maxDepth}`);
    ctx.fatal = true;
    return null;
  }
  if (!isPlainObject(raw)) {
    diag(ctx, 'invalid_node', path, 'error');
    return null;
  }
  const type = raw.type;
  if (typeof type !== 'string' || type.length === 0) {
    diag(ctx, 'missing_node_type', path, 'error');
    return null;
  }

  const component = UI_COMPONENT_MAP.get(type);
  if (!component) {
    diag(ctx, 'unknown_component', path, 'warning', type.slice(0, 80));
    return { type: 'Unsupported', props: { component: type } };
  }

  ctx.counter.nodes += 1;
  const props: Record<string, UIPropValue> = {};

  if (raw.props !== undefined) {
    if (!isPlainObject(raw.props)) {
      diag(ctx, 'invalid_props', `${path}.props`, 'warning');
    } else {
      for (const [key, value] of Object.entries(raw.props)) {
        const propSpec = component.props[key];
        if (!propSpec) {
          diag(ctx, 'unknown_prop', `${path}.props.${key}`, 'warning', `${component.name}.${key}`);
          continue;
        }
        const clean = sanitizeProp(value, propSpec, `${path}.props.${key}`, ctx, state, depth);
        if (clean !== undefined) props[key] = clean;
      }
    }
  }

  // 结构必需属性缺失 → 整个组件丢弃（保留会渲染成空壳/报错）
  const missingRequired = requiredPropMissing(component, props);
  if (missingRequired.length > 0) {
    for (const key of missingRequired) {
      diag(ctx, 'missing_prop', `${path}.props.${key}`, 'error', `${component.name}.${key}`);
    }
    return null;
  }

  // ---- children ----
  let children: Array<UINode | string | UIBinding> | undefined;
  if (raw.children !== undefined) {
    if (!component.children) {
      diag(ctx, 'unknown_children', `${path}.children`, 'warning', component.name);
    } else if (!Array.isArray(raw.children)) {
      diag(ctx, 'invalid_children', `${path}.children`, 'warning');
    } else {
      children = [];
      if (raw.children.length > UI_LIMITS.maxChildren) {
        diag(ctx, 'too_many_children', `${path}.children`, 'warning', `> ${UI_LIMITS.maxChildren}`);
      }
      for (let i = 0; i < Math.min(raw.children.length, UI_LIMITS.maxChildren); i++) {
        const child = raw.children[i];
        const childPath = `${path}.children[${i}]`;
        if (typeof child === 'string') {
          if (child.length > UI_LIMITS.maxTextChars) {
            diag(ctx, 'text_too_long', childPath, 'warning', `> ${UI_LIMITS.maxTextChars}`);
          }
          children.push(child.slice(0, UI_LIMITS.maxTextChars));
          continue;
        }
        const binding = asBinding(child);
        if (binding) {
          if ('$action' in binding) {
            diag(ctx, 'invalid_binding', childPath, 'warning', 'action binding cannot be a child');
            continue;
          }
          const clean = sanitizeBinding(binding, { kind: 'bindingOrValue' }, childPath, ctx, state);
          if (clean) children.push(clean);
          continue;
        }
        const node = walkNode(child, depth + 1, childPath, ctx, state);
        if (node) children.push(node);
      }
      if (children.length === 0) children = undefined;
    }
  }

  if (component.requiredChildren && (!children || children.every((c) => typeof c === 'string' && c.trim() === ''))) {
    diag(ctx, 'missing_children', `${path}.children`, 'warning', component.name);
  }

  const node: UINode = { type: component.name };
  if (Object.keys(props).length > 0) node.props = props;
  if (children && children.length > 0) node.children = children;
  return node;
}

/** 缺少哪些「结构必需」属性（缺失则组件无法渲染） */
function requiredPropMissing(component: UIComponentSpec, props: Record<string, UIPropValue>): string[] {
  const missing: string[] = [];
  for (const [key, spec] of Object.entries(component.props)) {
    if (!spec.required) continue;
    if (props[key] === undefined) missing.push(key);
  }
  return missing;
}

/**
 * 净化单个属性值。
 * 返回 undefined 表示删除该属性（并已记录诊断）。
 */
function sanitizeProp(
  value: unknown,
  spec: UIPropSpec,
  path: string,
  ctx: WalkCtx,
  state: Record<string, UIStateValue>,
  depth: number,
): UIPropValue | undefined {
  const binding = asBinding(value);
  if (binding) {
    const clean = sanitizeBinding(binding, spec, path, ctx, state);
    return clean ?? undefined;
  }

  switch (spec.kind) {
    case 'bindingOrAction':
      diag(ctx, 'invalid_action', path, 'warning', 'expected an $action binding');
      return undefined;
    case 'bindingOrValue':
      if (isPrimitive(value)) return value;
      diag(ctx, 'invalid_literal', path, 'warning');
      return undefined;
    case 'string': {
      if (typeof value !== 'string') {
        diag(ctx, 'invalid_literal', path, 'warning', 'expected string');
        return undefined;
      }
      const max = spec.maxLength ?? UI_LIMITS.maxTextChars;
      if (value.length > max) diag(ctx, 'text_too_long', path, 'warning', `> ${max}`);
      return value.slice(0, max);
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        diag(ctx, 'invalid_literal', path, 'warning', 'expected finite number');
        return undefined;
      }
      if (spec.min !== undefined && value < spec.min) {
        diag(ctx, 'invalid_literal', path, 'warning', `< ${spec.min}`);
        return undefined;
      }
      if (spec.max !== undefined && value > spec.max) {
        diag(ctx, 'invalid_literal', path, 'warning', `> ${spec.max}`);
        return undefined;
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        diag(ctx, 'invalid_literal', path, 'warning', 'expected boolean');
        return undefined;
      }
      return value;
    }
    case 'enum': {
      if (typeof value !== 'string' || !(spec.values ?? []).includes(value)) {
        diag(ctx, 'invalid_literal', path, 'warning', `expected one of ${(spec.values ?? []).join(', ')}`);
        return undefined;
      }
      return value;
    }
    case 'columns':
      return sanitizeColumns(value, path, ctx);
    case 'rows':
      return sanitizeRows(value, path, ctx, state);
    case 'chartData':
      return sanitizeChartData(value, path, ctx);
    case 'keyValueItems':
      return sanitizeKeyValue(value, path, ctx, state);
    case 'options':
      return sanitizeOptions(value, path, ctx);
    case 'tabItems':
      return sanitizeTabs(value, path, ctx, state, depth + 1);
    default:
      return undefined;
  }
}

/** 允许 $state/$expr 绑定的属性类型：所有标量属性 + 输入组件的值 */
const BINDABLE_KINDS: ReadonlySet<UIPropSpec['kind']> = new Set([
  'bindingOrValue',
  'string',
  'number',
  'boolean',
  'enum',
]);

function sanitizeBinding(
  binding: UIBinding,
  spec: UIPropSpec,
  path: string,
  ctx: WalkCtx,
  state: Record<string, UIStateValue>,
): UIBinding | undefined {
  if ('$state' in binding) {
    if (!BINDABLE_KINDS.has(spec.kind)) {
      diag(ctx, 'invalid_binding', path, 'warning', 'state binding not allowed for this prop');
      return undefined;
    }
    if (!isValidStateKey(binding.$state)) {
      diag(ctx, 'invalid_state_key', path, 'warning', binding.$state);
      return undefined;
    }
    if (!(binding.$state in state)) {
      diag(ctx, 'unknown_state', path, 'warning', binding.$state);
    }
    return binding;
  }

  if ('$expr' in binding) {
    if (!BINDABLE_KINDS.has(spec.kind)) {
      diag(ctx, 'invalid_binding', path, 'warning', 'expression binding not allowed for this prop');
      return undefined;
    }
    const check = isSafeExprSource(binding.$expr);
    if (!check.ok) {
      diag(ctx, 'invalid_expr', path, 'warning', check.reason);
      return undefined;
    }
    return binding;
  }

  // $action
  if (spec.kind !== 'bindingOrAction') {
    diag(ctx, 'invalid_binding', path, 'warning', 'action binding not allowed for this prop');
    return undefined;
  }
  const action = binding.$action;
  if (!isUIAction(action)) {
    diag(ctx, 'invalid_action', path, 'warning');
    return undefined;
  }
  if ((action.kind === 'set' || action.kind === 'toggle') && !(action.key in state)) {
    diag(ctx, 'unknown_state', path, 'warning', action.key);
  }
  if (action.kind === 'copy' && typeof action.text === 'string' && action.text.length > 10_000) {
    diag(ctx, 'text_too_long', path, 'warning', 'copy text > 10000 chars');
    return undefined;
  }
  if (action.kind === 'open' && typeof action.href === 'string' && !isSafeHref(action.href)) {
    diag(ctx, 'invalid_href', path, 'warning', action.href.slice(0, 200));
    return undefined;
  }
  return binding;
}

function isSafeHref(href: string): boolean {
  return href.startsWith('https://') || href.startsWith('http://') || (href.startsWith('/') && !href.startsWith('//'));
}

function sanitizeColumns(value: unknown, path: string, ctx: WalkCtx): UIPropValue | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    diag(ctx, 'invalid_literal', path, 'warning', 'expected non-empty columns array');
    return undefined;
  }
  const out: UIPropValue[] = [];
  for (let i = 0; i < Math.min(value.length, UI_LIMITS.maxTableColumns); i++) {
    const item = value[i];
    if (!isPlainObject(item) || typeof item.key !== 'string' || typeof item.label !== 'string') {
      diag(ctx, 'invalid_literal', `${path}[${i}]`, 'warning', 'column needs key+label strings');
      continue;
    }
    const align = item.align;
    if (align !== undefined && align !== 'left' && align !== 'center' && align !== 'right') {
      diag(ctx, 'invalid_literal', `${path}[${i}].align`, 'warning');
    }
    out.push({
      key: item.key.slice(0, 200),
      label: item.label.slice(0, 500),
      ...(align === 'left' || align === 'center' || align === 'right' ? { align } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeRows(
  value: unknown,
  path: string,
  ctx: WalkCtx,
  state: Record<string, UIStateValue>,
): UIPropValue | undefined {
  if (!Array.isArray(value)) {
    diag(ctx, 'invalid_literal', path, 'warning', 'expected rows array');
    return undefined;
  }
  const out: UIPropValue[] = [];
  for (let i = 0; i < Math.min(value.length, UI_LIMITS.maxTableRows); i++) {
    const row = value[i];
    if (!Array.isArray(row)) {
      diag(ctx, 'invalid_literal', `${path}[${i}]`, 'warning', 'row must be an array');
      continue;
    }
    const cells: UIPropValue[] = [];
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const binding = asBinding(cell);
      if (binding) {
        if ('$action' in binding) {
          diag(ctx, 'invalid_binding', `${path}[${i}][${j}]`, 'warning');
          cells.push(null);
          continue;
        }
        const clean = sanitizeBinding(binding, { kind: 'bindingOrValue' }, `${path}[${i}][${j}]`, ctx, state);
        cells.push(clean ?? null);
        continue;
      }
      cells.push(isPrimitive(cell) ? cell : null);
    }
    out.push(cells);
  }
  return out;
}

function sanitizeChartData(value: unknown, path: string, ctx: WalkCtx): UIPropValue | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    diag(ctx, 'invalid_literal', path, 'warning', 'expected non-empty data array');
    return undefined;
  }
  const out: UIPropValue[] = [];
  for (let i = 0; i < Math.min(value.length, UI_LIMITS.maxChartPoints); i++) {
    const item = value[i];
    if (!isPlainObject(item) || typeof item.label !== 'string' || typeof item.value !== 'number' || !Number.isFinite(item.value)) {
      diag(ctx, 'invalid_literal', `${path}[${i}]`, 'warning', 'datum needs label:string + value:number');
      continue;
    }
    out.push({ label: item.label.slice(0, 200), value: item.value });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeKeyValue(
  value: unknown,
  path: string,
  ctx: WalkCtx,
  state: Record<string, UIStateValue>,
): UIPropValue | undefined {
  if (!Array.isArray(value)) {
    diag(ctx, 'invalid_literal', path, 'warning', 'expected items array');
    return undefined;
  }
  const out: UIPropValue[] = [];
  for (let i = 0; i < Math.min(value.length, UI_LIMITS.maxListItems); i++) {
    const item = value[i];
    if (!isPlainObject(item) || typeof item.label !== 'string') {
      diag(ctx, 'invalid_literal', `${path}[${i}]`, 'warning', 'item needs label:string');
      continue;
    }
    const rawValue = item.value;
    const binding = asBinding(rawValue);
    let cleanValue: UIPropValue = null;
    if (binding) {
      if ('$action' in binding) {
        diag(ctx, 'invalid_binding', `${path}[${i}].value`, 'warning');
      } else {
        cleanValue = sanitizeBinding(binding, { kind: 'bindingOrValue' }, `${path}[${i}].value`, ctx, state) ?? null;
      }
    } else if (isPrimitive(rawValue)) {
      cleanValue = rawValue;
    }
    out.push({ label: item.label.slice(0, 500), value: cleanValue });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeOptions(value: unknown, path: string, ctx: WalkCtx): UIPropValue | undefined {
  if (!Array.isArray(value)) {
    diag(ctx, 'invalid_literal', path, 'warning', 'expected options array');
    return undefined;
  }
  const out: UIPropValue[] = [];
  for (let i = 0; i < Math.min(value.length, UI_LIMITS.maxListItems); i++) {
    const item = value[i];
    if (!isPlainObject(item) || typeof item.value !== 'string' || typeof item.label !== 'string') {
      diag(ctx, 'invalid_literal', `${path}[${i}]`, 'warning', 'option needs value+label strings');
      continue;
    }
    out.push({ value: item.value.slice(0, 500), label: item.label.slice(0, 500) });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeTabs(
  value: unknown,
  path: string,
  ctx: WalkCtx,
  state: Record<string, UIStateValue>,
  depth: number,
): UIPropValue | undefined {
  if (!Array.isArray(value)) {
    diag(ctx, 'invalid_literal', path, 'warning', 'expected items array');
    return undefined;
  }
  const out: UIPropValue[] = [];
  for (let i = 0; i < Math.min(value.length, UI_LIMITS.maxTabs); i++) {
    const item = value[i];
    if (!isPlainObject(item) || typeof item.value !== 'string' || typeof item.label !== 'string') {
      diag(ctx, 'invalid_literal', `${path}[${i}]`, 'warning', 'tab needs value+label strings');
      continue;
    }
    const content = walkNode(item.content, depth, `${path}[${i}].content`, ctx, state);
    if (!content) {
      diag(ctx, 'invalid_literal', `${path}[${i}].content`, 'warning', 'tab content must be a node');
      continue;
    }
    out.push({ value: item.value.slice(0, 200), label: item.label.slice(0, 500), content } as unknown as UIPropValue);
  }
  return out.length > 0 ? out : undefined;
}

/** 组件目录完整性自检（测试用）：确保每个组件名唯一 */
export function assertCatalogIntegrity(): void {
  const seen = new Set<string>();
  for (const component of UI_COMPONENTS) {
    if (seen.has(component.name)) throw new Error(`duplicate UI component: ${component.name}`);
    seen.add(component.name);
  }
}
