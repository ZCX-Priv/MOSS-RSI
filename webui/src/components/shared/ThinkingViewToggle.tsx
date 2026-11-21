// webui/src/components/shared/ThinkingViewToggle.tsx
// 思维链「原文 / 翻译」胶囊（分段）切换：与设置页 TabsList/TabsTrigger 同源的紧凑样式。
// 纯展示组件：受控 view + onChange；仅在存在译文（或翻译已开始）时由调用方渲染。

import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type ThinkingView = 'original' | 'translation';

export interface ThinkingViewToggleProps {
  view: ThinkingView;
  onChange: (view: ThinkingView) => void;
  /** 译文正在生成：禁用译文按钮并显示「翻译中…」 */
  pending?: boolean;
  /** 禁用译文切换（如思考仍在生成） */
  disabled?: boolean;
  className?: string;
}

const ITEM = 'inline-flex h-full items-center justify-center rounded-[4px] px-2 text-[11px] font-medium transition-colors';
const ACTIVE = 'bg-background text-foreground shadow-sm';
const INACTIVE =
  'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground';

export function ThinkingViewToggle({
  view,
  onChange,
  pending = false,
  disabled = false,
  className,
}: ThinkingViewToggleProps) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t('task.thinkingViewLabel')}
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-md bg-muted p-[2px] text-muted-foreground',
        className,
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === 'original'}
        onClick={() => onChange('original')}
        className={cn(ITEM, view === 'original' ? ACTIVE : INACTIVE)}
      >
        {t('task.thinkingOriginal')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'translation'}
        disabled={disabled || pending}
        onClick={() => onChange('translation')}
        className={cn(
          ITEM,
          view === 'translation' ? ACTIVE : INACTIVE,
          (disabled || pending) && 'cursor-not-allowed opacity-60',
        )}
      >
        {pending ? t('task.thinkingTranslating') : t('task.thinkingTranslation')}
      </button>
    </div>
  );
}
