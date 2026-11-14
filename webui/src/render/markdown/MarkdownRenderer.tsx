// render/markdown/MarkdownRenderer.tsx
// 渲染模块主入口：分块 + 冻结的流式 Markdown 渲染器。
//
//   <MarkdownRenderer text={content} streaming={message.streaming} />
//
// - splitBlocks 把全文切成块序列（闭块 closed=true / 活跃块 closed=false）
// - 闭块由 MarkdownBlock(memo) 冻结，流式 token 只重渲染最后一个活跃块
// - 顶层围栏块自带 fenceLang，直接渲染代码卡片（流式过程中也成立）
// - streaming=false 时所有块视为闭合（代码高亮/图表/公式回退链全部就位）
// - markdownEnabled=false 回退旧纯文本渲染（whitespace-pre-wrap，样式与消息区原实现一致）

import { useMemo, type ReactNode } from 'react';
import { splitBlocks } from '../core/block-splitter';
import { MarkdownBlock } from './MarkdownBlock';
import { useRenderSettings } from '../core/settings';

export interface MarkdownRendererProps {
  text: string;
  /** 是否流式生成中（true 时最后一块视为活跃块；false 时全部冻结） */
  streaming?: boolean;
  /** 追加到容器上的 className */
  className?: string;
  /** normal = 正文样式；compact = 小号弱色（思维链区） */
  variant?: 'normal' | 'compact';
  /** 流式光标（如旋转 spinner）：渲染进文本流末尾，与最后一行文字同行
   *  （markdown 路径依赖 .md-render > p:has(+ .md-cursor) 行内化；末块非段落时掉行为后备） */
  cursor?: ReactNode;
  /** 渐进渲染：闭合长块首帧纯文本占位，帧预算内升级完整 markdown（历史/批量消息用） */
  defer?: boolean;
}

export function MarkdownRenderer({
  text,
  streaming = false,
  className,
  variant = 'normal',
  cursor,
  defer = false,
}: MarkdownRendererProps) {
  const settings = useRenderSettings();
  const blocks = useMemo(() => {
    try {
      return splitBlocks(text);
    } catch {
      // 分块器自身异常不应让消息白屏：退化为单块（内容完整保留，走普通 markdown 渲染）
      return [{ index: 0, raw: text, closed: true }];
    }
  }, [text]);
  const sizeClass = variant === 'compact' ? 'text-xs text-muted-foreground' : 'text-sm text-foreground';

  // 总开关关闭：回退纯文本（与消息区旧渲染完全一致的样式类）
  if (!settings.markdownEnabled) {
    return (
      <div className={`whitespace-pre-wrap break-words ${sizeClass} ${className ?? ''}`}>
        {text}
        {cursor}
      </div>
    );
  }

  return (
    <div className={`md-render ${sizeClass} ${className ?? ''}`}>
      {blocks.map((block) => (
        <MarkdownBlock
          key={block.index}
          raw={block.raw}
          closed={block.closed || !streaming}
          fenceLang={block.fenceLang}
          defer={defer}
        />
      ))}
      {cursor !== undefined && <span className="md-cursor">{cursor}</span>}
    </div>
  );
}
