import {
  Component,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import {
  getRenderErrorGroup,
  getRenderErrorVersion,
  registerRenderError,
  retryRenderErrorGroup,
  subscribeRenderErrors,
} from '../../lib/render-errors';

export type RenderErrorScope = 'message' | 'card';

interface MessageErrorBoundaryProps {
  children: ReactNode;
  /** 出错时的兜底文案（缺省按 <html lang> 双语直出，避免依赖 i18n） */
  label?: string;
  /**
   * 重置键：变化时清除错误态并重新渲染子内容。
   * 流式消息每次增长都应传入（如 id+content.length），否则一次瞬时异常会让该条消息永久显示错误卡。
   */
  resetKey?: string;
  /** 错误影响范围：message = 整条消息；card = 消息内的单个子组件（默认 message） */
  scope?: RenderErrorScope;
  /** 合并卡排序键：相同错误中 orderKey 最小的实例展示完整错误卡 */
  orderKey?: string;
  /** 边界自身重置后额外执行（如清除懒加载模块缓存并重新加载） */
  onRetry?: () => void;
}

interface MessageErrorBoundaryState {
  error: Error | null;
}

const isZhDocument = (): boolean => (document.documentElement.lang || 'zh').startsWith('zh');

function errorSignature(error: Error): string {
  return `${error.name}: ${error.message}`;
}

/**
 * 逐条消息 / 逐个子组件的错误边界：
 * - scope=message：单条消息渲染异常只降级该条，不牵连整个任务页；
 * - scope=card：工具卡片等子组件异常只降级该块，消息正文与其它卡片继续渲染。
 * 相同错误由 lib/render-errors 全局合并，只展示一张 ×N 错误卡。
 */
export class MessageErrorBoundary extends Component<MessageErrorBoundaryProps, MessageErrorBoundaryState> {
  state: MessageErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): MessageErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Message render error caught by MessageErrorBoundary:', error, info.componentStack);
  }

  /** resetKey 变化（消息继续增长 / 内容更新）→ 清除错误态，重新尝试渲染 */
  componentDidUpdate(prevProps: MessageErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  /** 手动重试：先复位自身，再执行调用方传入的缓存清理/重新加载 */
  private handleRetry = (): void => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <RenderErrorNotice
        error={error}
        scope={this.props.scope ?? 'message'}
        orderKey={this.props.orderKey ?? ''}
        label={this.props.label}
        onRetry={this.handleRetry}
      />
    );
  }
}

interface RenderErrorNoticeProps {
  error: Error;
  scope?: RenderErrorScope;
  orderKey?: string;
  label?: string;
  onRetry?: () => void;
}

/**
 * 错误提示本体：相同签名只有一个 primary 展示完整错误卡与「重试」，
 * 其余实例只展示一行轻量占位（点击同样触发整组重试）。
 * 供错误边界与 LazyModuleSlot（模块加载失败）共用。
 */
export function RenderErrorNotice({
  error,
  scope = 'message',
  orderKey = '',
  label,
  onRetry,
}: RenderErrorNoticeProps) {
  const id = useId();
  const signature = errorSignature(error);
  // onRetry 每次渲染可能是新函数：放进 ref，注册 effect 不因它反复执行
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;

  useEffect(
    () =>
      registerRenderError({
        id,
        signature,
        orderKey,
        retry: () => retryRef.current?.(),
      }),
    [id, signature, orderKey],
  );

  useSyncExternalStore(subscribeRenderErrors, getRenderErrorVersion);
  const { count, primaryId } = getRenderErrorGroup(signature);
  const isZh = isZhDocument();

  if (primaryId !== id) {
    return (
      <button
        type="button"
        onClick={() => retryRenderErrorGroup(signature)}
        title={isZh ? '点击重试' : 'Click to retry'}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <CircleAlert className="size-3.5 shrink-0 text-warning" />
        <span className="truncate">
          {scope === 'message'
            ? isZh
              ? '该消息渲染失败，已跳过'
              : 'This message failed to render and was skipped'
            : isZh
              ? '该卡片暂时不可用'
              : 'This card is temporarily unavailable'}
        </span>
      </button>
    );
  }

  const title =
    label ??
    (scope === 'message'
      ? isZh
        ? '该消息渲染失败，已跳过'
        : 'This message failed to render and was skipped'
      : isZh
        ? '该卡片渲染失败，已跳过'
        : 'This card failed to render and was skipped');

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
        <CircleAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{title}</span>
        {count > 1 && (
          <span className="shrink-0 rounded bg-destructive/10 px-1 text-[10px] tabular-nums text-destructive/80">
            ×{count}
          </span>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={() => retryRenderErrorGroup(signature)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <RefreshCw className="size-3" />
            {isZh ? '重试' : 'Retry'}
          </button>
        )}
      </div>
      <pre className="mono max-h-32 overflow-auto whitespace-pre-wrap break-all text-[11px] text-destructive/80">
        {signature}
      </pre>
    </div>
  );
}
