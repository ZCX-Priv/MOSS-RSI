// webui/src/components/shared/ThinkingPreview.tsx
// 思考状态行的单行预览：把最新片段放在预览自身的横向滚动容器里，
// 文本增长时自动滚到最右端（始终可见最新内容）。
//
// 关键约束：横向滚动只发生在这里，绝不撑宽消息/会话布局。
// 父级 flex 链必须保持 min-w-0（调用方 summary 已具备），本组件自身也声明 min-w-0/flex-1。
// 展开思考正文后由 group-open:hidden 隐藏（与既有交互一致）。

import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export function ThinkingPreview({ text, className }: { text: string; className?: string }) {
  const textRef = useRef<HTMLSpanElement | null>(null);

  // 文本每次增长都把内部横向滚动推到最右端；容器宽度不变，布局不抖动。
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || !text) return;
    el.scrollLeft = el.scrollWidth;
  }, [text]);

  if (!text) return null;

  return (
    <span className={cn('group-open:hidden flex min-w-0 flex-1 items-center gap-1.5', className)}>
      <span className="shrink-0">·</span>
      <span
        ref={textRef}
        className="no-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-left text-muted-foreground/70"
      >
        {text}
      </span>
    </span>
  );
}
