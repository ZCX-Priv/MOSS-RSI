// webui/src/components/shared/CompactionCard.tsx
// 消息流压缩卡片：上下文压缩完成时插入消息流，展示压缩时间/前后 token 对比/
// 被压缩消息数；摘要可折叠展开（七段式 Markdown 渲染）。

import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Loader2, Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format-duration';
import { Button } from '@/components/ui/button';
import type { CompactionRecord } from '../../types/api';

export const CompactionCard = memo(function CompactionCard({
  compaction,
}: {
  compaction: CompactionRecord;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const beforeTokens = compaction.beforeTokens ?? 0;
  const afterTokens = compaction.afterTokens ?? 0;
  const saved = Math.max(0, beforeTokens - afterTokens);
  const savedPercent = beforeTokens > 0 ? Math.round((saved / beforeTokens) * 100) : 0;

  return (
    <div className="flex justify-center py-1">
      <div
        className={cn(
          'w-full max-w-2xl rounded-lg border border-dashed border-border bg-muted/40',
          'px-3 py-2.5 text-xs text-muted-foreground',
        )}
      >
        {/* 标题行：图标 + 时间 + 触发方式 */}
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <Package className="size-3.5 shrink-0 text-primary-strong" />
          <span className="font-medium text-foreground">
            {t('context.compactionCardTitle')}
          </span>
          <span className="ml-1">
            {compaction.trigger === 'manual' ? t('context.triggerManual') : t('context.triggerAuto')}
          </span>
          <span className="ml-auto flex items-center gap-2 tabular-nums">
            <span>
              {beforeTokens.toLocaleString()} →{' '}
              {afterTokens.toLocaleString()}
            </span>
            <span className="text-emerald-500">
              -{savedPercent}%（{(saved / 1000).toFixed(1)}k）
            </span>
          </span>
        </button>

        {/* 展开区：压缩明细 + 摘要全文 */}
        {open && (
          <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
              <span>
                {t('context.compactedMessages')}: {compaction.compactedCount ?? 0}
              </span>
              <span>
                {t('context.duration')}: {formatDuration(compaction.durationMs ?? 0)}
              </span>
              <span>
                {t('context.summaryModel')}: {compaction.summaryModel}
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md bg-background/60 p-2 leading-relaxed">
              <div className="whitespace-pre-wrap break-words">{compaction.summary}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

/** 压缩进行中占位卡片（compaction-started 后、completed 前的短暂状态） */
export function CompactionPendingCard() {
  const { t } = useTranslation();
  return (
    <div className="flex justify-center py-1">
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin text-primary-strong" />
        <span>{t('context.compactionRunning')}</span>
      </div>
    </div>
  );
}

/** 压缩按钮专用导出（保持 Button 引用避免 tree-shake 抖掉） */
export { Button as CompactionCardButton };
