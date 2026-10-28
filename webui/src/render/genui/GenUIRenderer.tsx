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

export function GenUIRenderer({ spec, className }: GenUIRendererProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<Record<string, GenUIStateValue>>(() => ({ ...(spec.state ?? {}) }));
  const compiledRef = useRef<Map<string, CompiledExpr | null>>(new Map());

  // 规格变化（历史回放/重新渲染）时复位本地状态与表达式缓存；刷新后回到初始 state。
  useEffect(() => {
    setState({ ...(spec.state ?? {}) });
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

  const resolve = useCallback(
    (value: unknown): unknown => {
      const binding = asGenUIBinding(value);
      if (binding) {
        if ('$state' in binding) {
          return Object.prototype.hasOwnProperty.call(state, binding.$state) ? state[binding.$state] : null;
        }
        if ('$expr' in binding) {
          const compiled = getCompiled(binding.$expr);
          return compiled
            ? evaluateCompiled(compiled, state, (message) => console.debug('[genui]', message))
            : null;
        }
        return value; // $action 保留，由组件绑定事件
      }
      if (Array.isArray(value)) return value.map(resolve);
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          out[key] = resolve(child);
        }
        return out;
      }
      return value;
    },
    [state, getCompiled],
  );

  const resolveText = useCallback(
    (value: unknown): string => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      const resolved = resolve(value);
      if (Array.isArray(resolved)) return resolved.map((child) => resolveText(child)).join('');
      if (resolved && typeof resolved === 'object') {
        const node = resolved as GenUINode;
        if (typeof node.type === 'string' && Array.isArray(node.children)) {
          return node.children.map((child) => resolveText(child)).join('');
        }
        return '';
      }
      return resolved === null || resolved === undefined ? '' : String(resolved);
    },
    [resolve],
  );

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

  const runAction = useCallback(
    (action: GenUIAction, eventValue?: GenUIStateValue): void => {
      switch (action.kind) {
        case 'set':
          setState((prev) => ({ ...prev, [action.key]: eventValue ?? null }));
          break;
        case 'toggle':
          setState((prev) => ({ ...prev, [action.key]: !prev[action.key] }));
          break;
        case 'copy': {
          const text = typeof action.text === 'string' ? action.text : resolveText(action.text);
          if (!text) break;
          void copyText(text).then((ok) => {
            if (ok) toast.success(t('task.runCode.copied'));
            else toast.error(t('task.runCode.copyFailed'));
          });
          break;
        }
        case 'open': {
          const href = typeof action.href === 'string' ? action.href : resolveText(action.href);
          if (isSafeHref(href)) window.open(href, '_blank', 'noopener,noreferrer');
          else toast.error(t('task.runCode.openBlocked'));
          break;
        }
        default:
          break;
      }
    },
    [resolveText, t],
  );

  const action = useCallback(
    (value: unknown) => {
      const binding = asGenUIBinding(value);
      if (!binding || !('$action' in binding)) return undefined;
      return (eventValue?: GenUIStateValue): void => runAction(binding.$action, eventValue);
    },
    [runAction],
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
    <div className={cn('flex flex-col gap-3', className)}>
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
