// webui/src/components/shared/FoldableContent.tsx
// 简洁挡位的模型正文折叠：默认裁成约 3 行，底部渐变提示 + 展开全文。
// 非简洁挡位（folded=false）原样渲染，不产生额外 DOM/状态影响。

import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { usePersistentState } from '../../lib/ui-state';

export interface FoldableContentProps {
  children: ReactNode;
  /** 是否处于简洁挡位（需要折叠正文） */
  folded: boolean;
  /** 跨虚拟列表卸载保持展开状态（建议带会话/消息/挡位） */
  stateKey: string;
  className?: string;
}

export function FoldableContent({ children, folded, stateKey, className }: FoldableContentProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = usePersistentState(stateKey, false);

  if (!folded) return <>{children}</>;

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div className="relative min-w-0">
        <div className={cn('min-w-0 overflow-hidden', !expanded && 'max-h-[4.5rem]')}>
          {children}
        </div>
        {!expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-0.5 self-start text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? t('task.step.contentCollapse') : t('task.step.contentExpand')}
      </button>
    </div>
  );
}
