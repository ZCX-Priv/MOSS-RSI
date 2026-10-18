// components/shared/AskAttachmentStrip.tsx
// ask 卡片的附件横排：左右滚动箭头 + 附件卡片（点击→右侧边栏预览）。
// 多附件时左右箭头显隐逻辑与发送框/Tab 栏一致（ResizeObserver 重算，不占位）。
// - 只读模式（agent 题面附件）：MessageAttachmentCard
// - 可移除模式（用户回答附件）：SendAttachmentCard（带移除按钮）

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fileNameOf } from '../../render/file/detector';
import { MessageAttachmentCard } from './AttachmentCards';
import { SendAttachmentCard } from './AttachmentCard';

export interface AskAttachmentItem {
  path: string;
  name?: string;
  size?: number;
}

interface AskAttachmentStripProps {
  items: AskAttachmentItem[];
  /** 点击卡片 → 打开右侧边栏预览 */
  onOpen: (path: string) => void;
  /** 提供则可移除（渲染带移除按钮的发送框样式卡片） */
  onRemove?: (path: string) => void;
  className?: string;
}

export function AskAttachmentStrip({ items, onOpen, onRemove, className }: AskAttachmentStripProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // 按 path 去重（保留首个）
  const unique: AskAttachmentItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    unique.push(it);
  }

  const updateArrows = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(max > 1 && el.scrollLeft < max - 1);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateArrows();
    const observer = new ResizeObserver(() => updateArrows());
    observer.observe(el);
    return () => observer.disconnect();
  }, [unique.length]);

  if (unique.length === 0) return null;

  const scroll = (dir: -1 | 1) => {
    scrollRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' });
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scroll(-1)}
          title={t('taskInput.scrollAttachmentsLeft')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}
      <div
        ref={scrollRef}
        onScroll={updateArrows}
        className="no-scrollbar flex flex-1 items-center gap-2 overflow-x-auto scroll-smooth"
      >
        {unique.map((it) =>
          onRemove ? (
            <SendAttachmentCard
              key={it.path}
              path={it.path}
              name={it.name ?? fileNameOf(it.path)}
              size={it.size ?? 0}
              onRemove={() => onRemove(it.path)}
              onOpen={() => onOpen(it.path)}
            />
          ) : (
            <MessageAttachmentCard key={it.path} path={it.path} onOpen={onOpen} />
          ),
        )}
      </div>
      {canScrollRight && (
        <button
          type="button"
          onClick={() => scroll(1)}
          title={t('taskInput.scrollAttachmentsRight')}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      )}
    </div>
  );
}
