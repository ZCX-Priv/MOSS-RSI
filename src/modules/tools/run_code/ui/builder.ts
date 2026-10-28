// src/modules/tools/run_code/ui/builder.ts
// 子进程内注入的 ui.* 构建器：模型用普通函数调用构建 UISpec，不接触 DOM/HTML。
// 本文件必须保持“纯”：只依赖 spec/catalog 类型与常量，不 import 任何宿主服务，
// 这样 bootstrap.ts 可以直接在同目录 import 它（开发与 dist 结构一致）。

import {
  asBinding,
  isSafeExprSource,
  isValidStateKey,
  UI_LIMITS,
  type UIAction,
  type UIBinding,
  type UIDiagnostic,
  type UINode,
  type UIPropValue,
  type UIStateValue,
} from './spec';

type UiChild = UINode | string | UIBinding | null | undefined;
type UiChildrenInput = UiChild | UiChild[];
type UiProps = Record<string, unknown>;

/** 组件工厂统一签名：支持 (props, children)、(children)、(props) 三种写法 */
export type UiComponentFactory = (props?: UiProps | UiChildrenInput, children?: UiChildrenInput) => UINode;

export interface UiCore {
  state(key: string, initial: UIStateValue): UIBinding;
  expr(source: string): UIBinding;
  set(key: string): UIBinding;
  toggle(key: string): UIBinding;
  copy(text: string | UIBinding): UIBinding;
  open(href: string | UIBinding): UIBinding;
  render(root: UINode, options?: { title?: string }): void;
  markdown(text: string): UINode;
}

export interface UiNamespace extends UiCore {
  box: UiComponentFactory;
  card: UiComponentFactory;
  divider: UiComponentFactory;
  title: UiComponentFactory;
  text: UiComponentFactory;
  badge: UiComponentFactory;
  table: UiComponentFactory;
  chart: UiComponentFactory;
  keyValue: UiComponentFactory;
  progress: UiComponentFactory;
  slider: UiComponentFactory;
  numberInput: UiComponentFactory;
  textInput: UiComponentFactory;
  select: UiComponentFactory;
  switch: UiComponentFactory;
  button: UiComponentFactory;
  tabs: UiComponentFactory;
  image: UiComponentFactory;
  callout: UiComponentFactory;
  emptyState: UiComponentFactory;
}

export interface UiBuildResult {
  hasUi: boolean;
  root?: UINode;
  state: Record<string, UIStateValue>;
  title?: string;
  diagnostics: UIDiagnostic[];
}

export interface UiBuilder {
  ui: UiNamespace;
  /** 程序结束后取构建结果（由 bootstrap 组装 result 帧） */
  getResult(): UiBuildResult;
}

/** 创建一次 run 的 ui 命名空间（内部状态一次性，不跨 run 复用） */
export function createUiBuilder(): UiBuilder {
  const stateStore: Record<string, UIStateValue> = Object.create(null) as Record<string, UIStateValue>;
  const diagnostics: UIDiagnostic[] = [];
  let root: UINode | undefined;
  let specTitle: string | undefined;
  let rendered = false;

  const record = (
    code: string,
    path: string,
    severity: 'warning' | 'error' = 'warning',
    detail?: string,
  ): void => {
    diagnostics.push({ code, path, ...(detail ? { detail } : {}), severity });
  };

  const isNode = (v: unknown): v is UINode =>
    !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { type?: unknown }).type === 'string';

  const normalizeChildren = (
    input: UiChildrenInput | undefined,
    path: string,
  ): Array<UINode | string | UIBinding> | undefined => {
    if (input === undefined || input === null) return undefined;
    const list = Array.isArray(input) ? input : [input];
    const out: Array<UINode | string | UIBinding> = [];
    for (let i = 0; i < list.length; i++) {
      const child = list[i];
      if (child === null || child === undefined) continue;
      if (typeof child === 'string') {
        if (child.length > UI_LIMITS.maxTextChars) {
          record('text_too_long', `${path}[${i}]`, 'warning', `> ${UI_LIMITS.maxTextChars}`);
        }
        out.push(child.slice(0, UI_LIMITS.maxTextChars));
        continue;
      }
      if (isNode(child)) {
        if (out.length >= UI_LIMITS.maxChildren) {
          record('too_many_children', path, 'warning', `> ${UI_LIMITS.maxChildren}`);
          break;
        }
        out.push(child);
        continue;
      }
      const binding = asBinding(child);
      if (binding && !('$action' in binding)) {
        out.push(binding);
        continue;
      }
      record('invalid_child', `${path}[${i}]`, 'warning');
    }
    return out.length > 0 ? out : undefined;
  };

  const makeNode = (type: string, propsOrChildren?: UiProps | UiChildrenInput, children?: UiChildrenInput): UINode => {
    let props: UiProps | undefined;
    let childInput: UiChildrenInput | undefined = children;
    if (isNode(propsOrChildren) || typeof propsOrChildren === 'string' || Array.isArray(propsOrChildren)) {
      childInput = propsOrChildren as UiChildrenInput;
    } else if (propsOrChildren !== undefined && propsOrChildren !== null) {
      if (typeof propsOrChildren !== 'object') {
        record('invalid_props', `${type}.props`, 'warning');
      } else {
        props = propsOrChildren as UiProps;
      }
    }

    const cleanProps: UiProps = {};
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined) continue;
        if (typeof value === 'function') {
          record('invalid_prop_value', `${type}.props.${key}`, 'warning', 'functions are not allowed');
          continue;
        }
        cleanProps[key] = value;
      }
    }

    const node: UINode = { type };
    if (Object.keys(cleanProps).length > 0) node.props = cleanProps as Record<string, UIPropValue>;
    const normalizedChildren = normalizeChildren(childInput, `${type}.children`);
    if (normalizedChildren) node.children = normalizedChildren;
    return node;
  };

  const factory =
    (type: string): UiComponentFactory =>
    (propsOrChildren, children) =>
      makeNode(type, propsOrChildren, children);

  const assertKey = (key: unknown, path: string): key is string => {
    if (typeof key !== 'string' || !isValidStateKey(key)) {
      record('invalid_state_key', path, 'error', String(key));
      return false;
    }
    return true;
  };

  const core: UiCore = {
    state(key: string, initial: UIStateValue): UIBinding {
      if (!assertKey(key, `state.${String(key)}`)) {
        return { $state: String(key) };
      }
      const safeInitial: UIStateValue =
        initial === null ||
        typeof initial === 'string' ||
        typeof initial === 'boolean' ||
        (typeof initial === 'number' && Number.isFinite(initial))
          ? initial
          : null;
      if (typeof initial === 'number' && !Number.isFinite(initial)) {
        record('invalid_state_value', `state.${key}`, 'warning', 'non-finite number');
      }
      if (!(key in stateStore)) {
        stateStore[key] = safeInitial;
      } else if (stateStore[key] !== safeInitial) {
        record('state_redefined', `state.${key}`, 'warning', 'initial value differs; first value kept');
      }
      return { $state: key };
    },

    expr(source: string): UIBinding {
      if (typeof source !== 'string') {
        record('invalid_expr', 'expr', 'warning', 'expected string');
        return { $expr: 'null' };
      }
      const check = isSafeExprSource(source);
      if (!check.ok) {
        record('invalid_expr', 'expr', 'warning', check.reason);
        return { $expr: 'null' };
      }
      return { $expr: source };
    },

    set(key: string): UIBinding {
      const action: UIAction = { kind: 'set', key };
      if (!assertKey(key, `action.set.${String(key)}`)) action.key = '__invalid__';
      return { $action: action };
    },

    toggle(key: string): UIBinding {
      const action: UIAction = { kind: 'toggle', key };
      if (!assertKey(key, `action.toggle.${String(key)}`)) action.key = '__invalid__';
      return { $action: action };
    },

    copy(text: string | UIBinding): UIBinding {
      if (typeof text === 'string' && text.length > 10_000) {
        record('text_too_long', 'action.copy.text', 'warning', '> 10000 chars');
        text = text.slice(0, 10_000);
      }
      return { $action: { kind: 'copy', text } };
    },

    open(href: string | UIBinding): UIBinding {
      return { $action: { kind: 'open', href } };
    },

    render(node: UINode, options?: { title?: string }): void {
      if (!isNode(node)) {
        record('invalid_root', 'root', 'error');
        return;
      }
      if (rendered) record('multiple_render', 'root', 'warning', 'last render wins');
      rendered = true;
      root = node;
      if (options && typeof options.title === 'string') {
        specTitle = options.title.slice(0, 200);
      }
    },

    markdown(text: string): UINode {
      return makeNode('Markdown', undefined, text);
    },
  };

  const ui: UiNamespace = {
    ...core,
    box: factory('Box'),
    card: factory('Card'),
    divider: factory('Divider'),
    title: factory('Title'),
    text: factory('Text'),
    badge: factory('Badge'),
    table: factory('Table'),
    chart: factory('Chart'),
    keyValue: factory('KeyValue'),
    progress: factory('Progress'),
    slider: factory('Slider'),
    numberInput: factory('NumberInput'),
    textInput: factory('TextInput'),
    select: factory('Select'),
    switch: factory('Switch'),
    button: factory('Button'),
    tabs: factory('Tabs'),
    image: factory('Image'),
    callout: factory('Callout'),
    emptyState: factory('EmptyState'),
  };

  return {
    ui: Object.freeze(ui),
    getResult(): UiBuildResult {
      const hasState = Object.keys(stateStore).length > 0;
      if (!rendered && hasState) {
        record('missing_render', 'root', 'warning', 'ui.state/expr used but ui.render was not called');
      }
      return {
        hasUi: rendered && !!root,
        ...(root ? { root } : {}),
        state: stateStore,
        ...(specTitle ? { title: specTitle } : {}),
        diagnostics,
      };
    },
  };
}

/** 当 uiEnabled=false 时注入的“访问即报错”占位命名空间（清晰告知模型如何修正） */
export function createDisabledUiNamespace(): UiNamespace {
  const message = 'ui namespace is disabled by config.agent.codeMode.uiEnabled';
  const throwing = new Proxy(Object.create(null) as Record<string, unknown>, {
    get(): never {
      throw new Error(message);
    },
  });
  return throwing as unknown as UiNamespace;
}
