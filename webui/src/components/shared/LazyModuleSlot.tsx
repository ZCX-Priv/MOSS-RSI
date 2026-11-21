// webui/src/components/shared/LazyModuleSlot.tsx
// 消息内懒加载子组件的统一槽位：
// - 加载中只占位，不阻塞消息正文；
// - 加载失败按错误签名去重展示，可手动重试；
// - 加载成功后再包一层卡片级错误边界，隔离子组件运行时渲染异常。

import type { ReactNode } from 'react';
import { useRetryableImport } from '../../lib/lazy-module';
import { MessageErrorBoundary, RenderErrorNotice } from './MessageErrorBoundary';

interface LazyModuleSlotProps<T> {
  /** 稳定的模块缓存键（同一模块的多个实例共用一次加载） */
  moduleKey: string;
  importer: () => Promise<T>;
  /** 相同错误中 orderKey 最小者展示合并卡 */
  orderKey: string;
  /** 加载中的占位（保持一行高度，避免消息跳动） */
  fallback?: ReactNode;
  children: (module: T) => ReactNode;
}

export function LazyModuleSlot<T>({
  moduleKey,
  importer,
  orderKey,
  fallback = null,
  children,
}: LazyModuleSlotProps<T>) {
  const [state, retry] = useRetryableImport(moduleKey, importer);

  if (state.status === 'loading') return <>{fallback}</>;
  if (state.status === 'error') {
    return (
      <RenderErrorNotice
        error={state.error}
        scope="card"
        orderKey={orderKey}
        onRetry={retry}
      />
    );
  }

  return (
    <MessageErrorBoundary scope="card" orderKey={orderKey} onRetry={retry}>
      {children(state.module)}
    </MessageErrorBoundary>
  );
}
