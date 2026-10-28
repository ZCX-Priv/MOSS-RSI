// webui/src/render/genui/GenUIRenderer.tsx
// Intelligent UI 前端渲染器：
//   - 按 UISpec 递归渲染组件目录；不执行任意 JS/HTML；
//   - state 在本地 useState 中，交互只重算绑定并重渲染，不调用模型；
//   - 表达式由受限解释器求值（expr.ts），单表达式失败显示占位；
//   - 节点级 Error Boundary 隔离单个组件异常。

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import { COMPONENTS } from './catalog';
import type { GenUIRenderContext } from './context';
import { compileExpr, evaluateCompiled, type CompiledExpr } from './expr';
import {
  asGenUIBinding,
  GENUI_LIMITS,
  isGenUISpec,
  type GenUIAction,
  type GenUIBinding,
  type GenUINode,
  type GenUISpec,
  type GenUIStateValue,
} from './types';

export interface GenUIRendererProps {
  spec: GenUISpec;
  className?: string;
}

/** 单次事件最多执行的原子动作数（防 seq 嵌套或异常规格拖死前端） */
const MAX_ACTION_STEPS = 64;

/** 把已解析的值转为展示文本（数组/节点拍平） */
function resolvedToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((child) => resolvedToText(child)).join('');
  if (typeof value === 'object') {
    const node = value as GenUINode;
    if (typeof node.type === 'string' && Array.isArray(node.children)) {
      return node.children.map((child) => resolvedToText(child)).join('');
    }
    return '';
  }
  return String(value);
}

export function GenUIRenderer({ spec, className }: GenUIRendererProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<Record<string, GenUIStateValue>>(() => ({ ...(spec.state ?? {}) }));
  const stateRef = useRef<Record<string, GenUIStateValue>>({ ...(spec.state ?? {}) });
  const compiledRef = useRef<Map<string, CompiledExpr | null>>(new Map());

  // 规格变化（历史回放/重新渲染）时复位本地状态与表达式缓存；刷新后回到初始 state。
  useEffect(() => {
    const initial = { ...(spec.state ?? {}) };
    stateRef.current = initial;
    setState(initial);
    compiledRef.current.clear();
  }, [spec]);

  const getCompiled = useCallback((source: string): CompiledExpr | null => {
    const cache = compiledRef.current;
    if (cache.has(source)) return cache.get(source) ?? null;
    try {
      const compiled = compileExpr(source);
      cache.set(source, compiled);
      return compiled;
    } catch (err) {
      console.debug('[genui] expression compile failed', err instanceof Error ? err.message : String(err));
      cache.set(source, null);
      return null;
    }
  }, []);

  /** 按给定 state 快照解析绑定（动作序列要读同步草稿，而不是 React 的旧 state） */
  const resolveWith = useCallback(
    (value: unknown, current: Record<string, GenUIStateValue>): unknown => {
      const walk = (input: unknown): unknown => {
        const binding = asGenUIBinding(input);
        if (binding) {
          if ('$state' in binding) {
            return Object.prototype.hasOwnProperty.call(current, binding.$state)
              ? current[binding.$state]
              : null;
          }
          if ('$expr' in binding) {
            const compiled = getCompiled(binding.$expr);
            return compiled
              ? evaluateCompiled(compiled, current, (message) => console.debug('[genui]', message))
              : null;
          }
          return input; // $action 保留，由组件绑定事件
        }
        if (Array.isArray(input)) return input.map(walk);
        if (input && typeof input === 'object') {
          const out: Record<string, unknown> = {};
          for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
            out[key] = walk(child);
          }
          return out;
        }
        return input;
      };
      return walk(value);
    },
    [getCompiled],
  );

  const resolve = useCallback(
    (value: unknown): unknown => resolveWith(value, state),
    [resolveWith, state],
  );

  const resolveText = useCallback((value: unknown): string => resolvedToText(resolve(value)), [resolve]);

  const resolveToNumber = useCallback(
    (value: unknown): number => {
      const resolved = resolve(value);
      const n = typeof resolved === 'number' ? resolved : Number(resolved);
      return Number.isFinite(n) ? n : 0;
    },
    [resolve],
  );

  const resolveToBoolean = useCallback(
    (value: unknown): boolean => {
      const resolved = resolve(value);
      return resolved === true || resolved === 1 || resolved === 'true';
    },
    [resolve],
  );

  /**
   * 执行一个动作（可能是 seq）：在同步草稿上依次写入，
   * 后一步能读到前一步的结果；copy/open 副作用只执行一次。
   */
  const runActions = useCallback(
    (root: GenUIAction, eventValue?: GenUIStateValue): void => {
      let draft: Record<string, GenUIStateValue> = { ...stateRef.current };
      let steps = 0;

      const applyOne = (action: GenUIAction): void => {
        if (steps >= MAX_ACTION_STEPS) return;
        steps += 1;
        switch (action.kind) {
          case 'set':
            draft = { ...draft, [action.key]: eventValue ?? null };
            break;
          case 'toggle':
            draft = { ...draft, [action.key]: !draft[action.key] };
            break;
          case 'apply': {
            const compiled = getCompiled(action.expr);
            const next = compiled
              ? evaluateCompiled(compiled, draft, (message) => console.debug('[genui]', message))
              : null;
            draft = { ...draft, [action.key]: next };
            break;
          }
          case 'reset':
            draft = { ...(spec.state ?? {}) };
            break;
          case 'seq':
            for (const child of action.actions.slice(0, GENUI_LIMITS.maxSeqActions)) applyOne(child);
            break;
          case 'copy': {
            const text =
              typeof action.text === 'string'
                ? action.text
                : resolvedToText(resolveWith(action.text, draft));
            if (text) {
              void copyText(text).then((ok) => {
                if (ok) toast.success(t('task.runCode.copied'));
                else toast.error(t('task.runCode.copyFailed'));
              });
            }
            break;
          }
          case 'open': {
            const href =
              typeof action.href === 'string'
                ? action.href
                : resolvedToText(resolveWith(action.href, draft));
            if (isSafeHref(href)) window.open(href, '_blank', 'noopener,noreferrer');
            else toast.error(t('task.runCode.openBlocked'));
            break;
          }
          default:
            break;
        }
      };

      applyOne(root);
      stateRef.current = draft;
      setState(draft);
    },
    [getCompiled, resolveWith, spec.state, t],
  );

  const action = useCallback(
    (value: unknown) => {
      const binding = asGenUIBinding(value);
      if (!binding || !('$action' in binding)) return undefined;
      return (eventValue?: GenUIStateValue): void => runActions(binding.$action, eventValue);
    },
    [runActions],
  );

  const ctx: GenUIRenderContext = useMemo(
    () => ({ state, resolve, resolveText, resolveToNumber, resolveToBoolean, action }),
    [state, resolve, resolveText, resolveToNumber, resolveToBoolean, action],
  );

  function renderChildren(children: GenUINode['children']): ReactNode {
    if (!children || children.length === 0) return null;
    return children.map((child, index) => {
      if (typeof child === 'string') return <span key={index}>{child}</span>;
      const binding: GenUIBinding | null = asGenUIBinding(child);
      if (binding) {
        if ('$action' in binding) return null;
        return <span key={index}>{resolveText(binding)}</span>;
      }
      return (
        <GenUINodeView
          key={index}
          node={child as GenUINode}
          ctx={ctx}
          renderChildren={renderChildren}
        />
      );
    });
  }

  if (!isGenUISpec(spec)) {
    return (
      <div className={cn('rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground', className)}>
        {t('task.runCode.uiInvalid')}
      </div>
    );
  }

  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-3', className)}>
      {spec.title ? (
        <h3 className="text-base font-semibold leading-snug text-foreground">{spec.title}</h3>
      ) : null}
      <Suspense fallback={<div className="text-xs text-muted-foreground">{t('task.runCode.loadingUi')}</div>}>
        <GenUINodeBoundary fallback={<NodeRenderError />}>
          <GenUINodeView node={spec.root} ctx={ctx} renderChildren={renderChildren} />
        </GenUINodeBoundary>
      </Suspense>
    </div>
  );
}

function GenUINodeView({
  node,
  ctx,
  renderChildren,
}: {
  node: GenUINode;
  ctx: GenUIRenderContext;
  renderChildren: (children: GenUINode['children']) => ReactNode;
}) {
  const Component = COMPONENTS[node.type];
  if (!Component) {
    return <UnsupportedNode node={node} />;
  }
  return (
    <GenUINodeBoundary fallback={<NodeRenderError />}>
      <Component node={node} ctx={ctx} renderChildren={renderChildren} />
    </GenUINodeBoundary>
  );
}

class GenUINodeBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.debug('[genui] node render failed', error.message, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function NodeRenderError() {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {t('task.runCode.nodeError')}
    </div>
  );
}

function UnsupportedNode({ node }: { node: GenUINode }) {
  const { t } = useTranslation();
  const name = typeof node.props?.component === 'string' ? node.props.component : node.type;
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {t('task.runCode.unsupportedComponent', { name })}
    </div>
  );
}

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || (href.startsWith('/') && !href.startsWith('//'));
}
