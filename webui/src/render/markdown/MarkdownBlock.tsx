// render/markdown/MarkdownBlock.tsx
// 单块组件：React.memo 浅比较（raw/closed/defer 不变即跳过重渲）——
// append-only 流保证闭块 raw 永不变，实现"闭块冻结、只重渲活跃块"。
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

/** 短于该长度的块直接渲染（成本可忽略，占位→替换反成闪烁） */
const DEFER_MIN_CHARS = 400;

/**
 * 流式活跃块降级为纯文本的最小长度。
 * 短块保持完整 markdown（即时格式化、无闪烁）；超过阈值的长块在流式期间只做
 * 纯文本渲染（跳过 token 解析/高亮），流结束（closed=true）后自动升级。
 */
const STREAM_PLAIN_MIN_CHARS = 1200;

export interface MarkdownBlockProps {
  raw: string;
  closed: boolean;
  /** 渐进渲染（历史/批量到达的消息用）：true 时长块首帧纯文本、帧预算内升级 */
  defer?: boolean;
  /** 流式活跃块纯文本降级（渲染器在 streaming 时对未闭合块传入） */
  plain?: boolean;
}

/** 完整 markdown 渲染（renderTokens 的 useRenderSettings hook 挂在本组件的链上） */
function MarkdownBlockContent({ raw, closed }: { raw: string; closed: boolean }) {
  return <>{renderBlockToReact(raw, closed)}</>;
}

function MarkdownBlockImpl({ raw, closed, defer, plain }: MarkdownBlockProps) {
  // 流式活跃块：足够长时用纯文本（每个分片不再做 markdown 解析），结束后升级。
  // 注意在有条件分支之前先算好、hooks 之后再 return —— 保持 hook 数量恒定。
  const effectivePlain = plain === true && !closed && raw.length > STREAM_PLAIN_MIN_CHARS;
  // 实际参与延迟的条件：显式开启 + 闭合块（流式活跃块需即时反馈）+ 足够长（值得占位）
  const effectiveDefer =
    !effectivePlain && defer === true && closed && raw.length > DEFER_MIN_CHARS;
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

  if (effectivePlain) {
    // 流式活跃长块：纯文本（每个分片零解析成本）
    return <p className="whitespace-pre-wrap break-words">{raw}</p>;
  }
  if (!hydrated) {
    // 廉价占位：纯文本段落（高度≈最终，水合后无大幅跳动）
    return <p className="whitespace-pre-wrap break-words">{raw}</p>;
  }
  return <MarkdownBlockContent raw={raw} closed={closed} />;
}

/** memo 冻结：raw 与 closed 均不变时整块（含 Shiki/KaTeX/Mermaid 子树）零重渲 */
export const MarkdownBlock = memo(MarkdownBlockImpl);
