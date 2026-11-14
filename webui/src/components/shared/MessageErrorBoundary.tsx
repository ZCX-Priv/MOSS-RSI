import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

interface MessageErrorBoundaryProps {
  children: ReactNode;
  /** 出错时的兜底文案（缺省按 <html lang> 双语直出，避免依赖 i18n） */
  label?: string;
  /**
   * 重置键：变化时清除错误态并重新渲染子内容。
   * 流式消息每次增长都应传入（如 id+content.length），否则一次瞬时异常会让该条消息永久显示错误卡。
   */
  resetKey?: string;
}

interface MessageErrorBoundaryState {
  error: Error | null;
}

/**
 * 逐条消息错误边界：单条消息渲染异常只降级该条，不牵连整个任务页。
 * 之前任何一条消息（如超长 Markdown 块）抛错都会冒泡到顶层 ErrorBoundary，
 * 把整页换成「界面出现错误」，用户完全看不到其余消息。
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

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isZh = (document.documentElement.lang || 'zh').startsWith('zh');
    const summary = `${error.name}: ${error.message}`;

    return (
      <div className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />
          <span>
            {this.props.label ??
              (isZh ? '该消息渲染失败，已跳过' : 'This message failed to render and was skipped')}
          </span>
        </div>
        <pre className="mono max-h-32 overflow-auto whitespace-pre-wrap break-all text-[11px] text-destructive/80">
          {summary}
        </pre>
      </div>
    );
  }
}
