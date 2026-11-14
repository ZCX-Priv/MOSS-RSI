// render/core/PreviewModeToggle.tsx
// 「预览 / 代码」胶囊（分段）切换：Markdown / LaTeX / HTML 等文本类预览器共用。
// 纯展示组件：受控 mode + onChange；文案走 i18n，图标 Eye / Code2。
// compact：嵌在代码卡片头部（与复制按钮并排）时的紧凑尺寸。

import { useTranslation } from 'react-i18next';
import { Code2, Eye } from 'lucide-react';
import { cn } from '../../lib/utils';

export type PreviewMode = 'preview' | 'code';

export interface PreviewModeToggleProps {
  mode: PreviewMode;
  onChange: (mode: PreviewMode) => void;
  /** 紧凑尺寸（代码卡片头部） */
  compact?: boolean;
}

const ITEM = 'inline-flex items-center gap-1.5 rounded-full transition-colors';
const ITEM_NORMAL = 'h-7 px-3 text-xs';
const ITEM_COMPACT = 'h-6 px-2 text-[11px]';
const ICON_NORMAL = 'size-3.5';
const ICON_COMPACT = 'size-3';
const ACTIVE = 'bg-background text-foreground shadow-sm';
const INACTIVE = 'text-muted-foreground hover:text-foreground';

export function PreviewModeToggle({ mode, onChange, compact = false }: PreviewModeToggleProps) {
  const { t } = useTranslation();
  const itemClass = cn(ITEM, compact ? ITEM_COMPACT : ITEM_NORMAL);
  const iconClass = compact ? ICON_COMPACT : ICON_NORMAL;
  return (
    <div
      role="tablist"
      aria-label={t('preview.modePreview')}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-muted/40 p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'preview'}
        onClick={() => onChange('preview')}
        className={cn(itemClass, mode === 'preview' ? ACTIVE : INACTIVE)}
      >
        <Eye className={iconClass} />
        {t('preview.modePreview')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'code'}
        onClick={() => onChange('code')}
        className={cn(itemClass, mode === 'code' ? ACTIVE : INACTIVE)}
      >
        <Code2 className={iconClass} />
        {t('preview.modeCode')}
      </button>
    </div>
  );
}
