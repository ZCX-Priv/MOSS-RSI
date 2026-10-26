// components/shared/DiffView.tsx
// Inline diff 渲染：双行号 + 红绿行背景 + hunk 间「N 行已隐藏」折叠条。
// 视觉对齐 VS Code / Cursor 的源代码变更视图（深色/浅色主题均适配）。

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseUnifiedDiff } from '../../lib/unified-diff';

export interface DiffViewProps {
  /** unified diff 文本 */
  diff: string;
  /** 最大高度（px），超出内部滚动；默认 420 */
  maxHeight?: number;
}

export function DiffView({ diff, maxHeight = 420 }: DiffViewProps) {
  const { t } = useTranslation();
  const hunks = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (hunks.length === 0) {
    // 非行级 diff（例如 [diff skipped: file too large] 占位）原样提示
    return (
      <div className="px-3 py-2 text-[10px] text-muted-foreground">{diff.trim()}</div>
    );
  }

  return (
    <div className="overflow-auto font-mono text-[11px] leading-[1.55]" style={{ maxHeight }}>
      <div className="min-w-max">
        {hunks.map((hunk, hi) => (
          <div key={`${hunk.header}-${hi}`}>
            {hunk.skippedBefore > 0 && (
              <div className="my-1 flex items-center justify-center gap-1 bg-muted/30 py-0.5 text-[10px] text-muted-foreground">
                <ArrowDownToLine className="size-3 shrink-0" />
                {t('fileChanges.hiddenLines', { count: hunk.skippedBefore })}
              </div>
            )}
            {hunk.lines.map((line, li) => (
              <div
                key={`${hi}-${li}`}
                className={cn(
                  'grid grid-cols-[3.4rem_3.4rem_1fr]',
                  line.type === 'add' && 'bg-emerald-500/15',
                  line.type === 'del' && 'bg-red-500/15',
                )}
              >
                <span
                  className={cn(
                    'select-none pr-2 text-right tabular-nums',
                    line.type === 'add' && 'text-emerald-600/70 dark:text-emerald-400/70',
                    line.type === 'del' && 'text-red-500/70 dark:text-red-400/70',
                    line.type === 'context' && 'text-muted-foreground/60',
                  )}
                >
                  {line.oldNo ?? ''}
                </span>
                <span
                  className={cn(
                    'select-none pr-2 text-right tabular-nums',
                    line.type === 'add' && 'text-emerald-600/70 dark:text-emerald-400/70',
                    line.type === 'del' && 'text-red-500/70 dark:text-red-400/70',
                    line.type === 'context' && 'text-muted-foreground/60',
                  )}
                >
                  {line.newNo ?? ''}
                </span>
                <span
                  className={cn(
                    'whitespace-pre pr-3',
                    line.type === 'add' && 'text-emerald-700 dark:text-emerald-200',
                    line.type === 'del' && 'text-red-700 dark:text-red-200',
                    line.type === 'context' && 'text-foreground/90',
                  )}
                >
                  <span className="select-none opacity-60">
                    {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                  </span>
                  {line.content || ' '}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
