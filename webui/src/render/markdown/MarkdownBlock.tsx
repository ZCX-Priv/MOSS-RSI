// render/markdown/MarkdownBlock.tsx
// 单块组件：React.memo 浅比较（raw/closed/defer/fenceLang 不变即跳过重渲）——
// append-only 流保证闭块 raw 永不变，实现"闭块冻结、只重渲活跃块"。
//
// 顶层围栏块（fenceLang 存在）：raw 即围栏内代码体，直接交给 CodeBlock，
// 流式过程中即时成卡片（不经过 markdown-it，也不做纯文本降级）。
//
// defer 渐进渲染：长内容块首帧以纯文本段落呈现（markdown 解析成本为 0，段落高度
// ≈最终高度），随后由 hydration-scheduler 在帧预算内逐块升级为完整渲染。
// 流式活跃块（closed=false）与本就廉价的短块直接全量渲染，不占位不闪烁。
//
// 结构注意：完整内容渲染放在子组件 MarkdownBlockContent 中——renderTokens 内部
// 调用 useRenderSettings（hook），若与纯文本占位同处一个组件，两态切换会改变
// hook 数量（"Rendered more hooks than during the previous render"）；
// 子组件拥有独立 hook 链，父组件 hook 数恒定。

import { memo, useEffect, useRef, useState } from 'react';
import { renderBlockToReact } from '../core/token-to-react';
import { scheduleHydration } from '../core/hydration-scheduler';
import { PreviewErrorBoundary } from '../core/PreviewErrorBoundary';
import { CodeBlock } from '../code/CodeBlock';

/** 短于该长度的块直接渲染（成本可忽略，占位→替换反成闪烁） */
const DEFER_MIN_CHARS = 400;

export interface MarkdownBlockProps {
  raw: string;
  closed: boolean;
  /** 顶层围栏代码块的语言标识（'' = 无语言）；普通 markdown 块为 undefined */
  fenceLang?: string;
  /** 渐进渲染（历史/批量到达的消息用）：true 时长块首帧纯文本、帧预算内升级 */
  defer?: boolean;
}

/** 完整 markdown 渲染（renderTokens 的 useRenderSettings hook 挂在本组件的链上） */
function MarkdownBlockContent({ raw, closed }: { raw: string; closed: boolean }) {
  return <>{renderBlockToReact(raw, closed)}</>;
}

function MarkdownBlockImpl({ raw, closed, fenceLang, defer }: MarkdownBlockProps) {
  // 顶层围栏块：代码块本身渲染廉价（高亮异步），不做占位延迟
  const isFence = fenceLang !== undefined;
  // 实际参与延迟的条件：显式开启 + 闭合块（流式活跃块需即时反馈）+ 足够长（值得占位）
  const effectiveDefer =
    !isFence && defer === true && closed && raw.length > DEFER_MIN_CHARS;
  // 一旦水合（或本就不延迟），后续任何变化（如展开截断消息导致 raw 变化）都直接全量渲染
  const hydratedRef = useRef(!effectiveDefer);
  const [hydrated, setHydrated] = useState(!effectiveDefer);

  useEffect(() => {
    if (hydratedRef.current) return;
    if (!closed) {
      // 上游转为流式活跃块：立即全量（延迟条件消失）
      hydratedRef.current = true;
      setHydrated(true);
      return;
    }
    return scheduleHydration(() => {
      hydratedRef.current = true;
      setHydrated(true);
    });
  }, [closed]);

  if (isFence) {
    return (
      <PreviewErrorBoundary resetKey={raw} fallback={<p className="whitespace-pre-wrap break-words">{raw}</p>}>
        <CodeBlock code={raw} lang={fenceLang} closed={closed} />
      </PreviewErrorBoundary>
    );
  }
  if (!hydrated) {
    // 廉价占位：纯文本段落（高度≈最终，水合后无大幅跳动）
    return <p className="whitespace-pre-wrap break-words">{raw}</p>;
  }
  // 块级错误边界：单个块渲染异常只降级该块为纯文本；raw 变化（流式/历史重载）时自动重试，
  // 避免一次异常让该块永久卡在错误态、进而拖垮整条消息。
  return (
    <PreviewErrorBoundary resetKey={raw} fallback={<p className="whitespace-pre-wrap break-words">{raw}</p>}>
      <MarkdownBlockContent raw={raw} closed={closed} />
    </PreviewErrorBoundary>
  );
}

/** memo 冻结：raw 与 closed 均不变时整块（含 Shiki/KaTeX/Mermaid 子树）零重渲 */
export const MarkdownBlock = memo(MarkdownBlockImpl);
