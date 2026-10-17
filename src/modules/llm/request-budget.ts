// src/modules/llm/request-budget.ts
// 请求体字节护栏（发送前）：精确测量序列化字节 + 逐级降级。
// 只做两件事：① 丢图片（base64 是最常见的"token 不可见"体积膨胀源）；
// ② 截断超长的 tool/assistant content（保留头尾）。
// **绝不删除消息、绝不动 system 消息** —— 保住 tool_calls ↔ tool 的配对关系，避免触发 400。
// 消息级删减由 context governor 的压缩/硬兜底负责（那里有 sanitize/align 配对对齐）。

import type { UnifiedMessage } from './types';

/** 图片省略提示（附在 content 末尾，让模型知道自己缺了图） */
const IMAGE_OMITTED_NOTE = '\n\n[图片因请求体字节超限已省略，此消息的图片内容本轮不可用]';
/** 中段截断标记 */
const CONTENT_TRUNCATED_MARK = '\n\n[... 内容因请求体字节超限已截断（保留头尾）...]\n\n';

/** 序列化 body 的 UTF-8 字节数（与 fetch 实际发送体积同口径） */
export function serializedBodyBytes(body: unknown): number {
  try {
    const text = JSON.stringify(body);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    // 无法序列化（循环引用等）：视为超限，交由上层降级处理
    return Number.POSITIVE_INFINITY;
  }
}

export interface ShrinkOptions {
  /** 保留的头部字符数 */
  keepHeadChars: number;
  /** 保留的尾部字符数 */
  keepTailChars: number;
}

export interface ShrinkResult {
  messages: UnifiedMessage[];
  /** 本次是否发生了降级（false = 无可降级目标） */
  changed: boolean;
  /** 本次丢弃的图片张数 */
  droppedImages: number;
  /** 本次被截断的消息数 */
  truncatedContents: number;
}

/** 一条消息内联图片的 base64 总字符数（无图返回 0） */
function imagesChars(m: UnifiedMessage): number {
  if (!m.images || m.images.length === 0) return 0;
  let n = 0;
  for (const img of m.images) n += img.data.length;
  return n;
}

/** 头尾保留式截断 */
function truncateMiddle(text: string, keepHead: number, keepTail: number): string {
  if (text.length <= keepHead + keepTail) return text;
  return `${text.slice(0, keepHead)}${CONTENT_TRUNCATED_MARK}${text.slice(text.length - keepTail)}`;
}

/**
 * 执行**一步**降级（不修改入参，返回新数组）：
 * 步骤 1：丢图片——选 base64 体积最大的带图消息，清空其 images 并追加省略提示；
 * 步骤 2：截断——选 content 最长的 tool/assistant 消息做头尾保留截断（不动 system/user）。
 * 调用方配合"transform → 测字节 → 未达标再调一次"的循环使用。
 */
export function shrinkUnifiedRequest(
  messages: readonly UnifiedMessage[],
  opts: ShrinkOptions,
): ShrinkResult {
  // 步骤 1：丢图片（体积最大者优先）
  let imgIdx = -1;
  let imgBest = 0;
  for (let i = 0; i < messages.length; i++) {
    const n = imagesChars(messages[i]);
    if (n > imgBest) {
      imgBest = n;
      imgIdx = i;
    }
  }
  if (imgIdx >= 0) {
    const next = [...messages];
    const target = next[imgIdx];
    const count = target.images?.length ?? 0;
    next[imgIdx] = {
      ...target,
      content: `${target.content}${IMAGE_OMITTED_NOTE}`,
      images: undefined,
    };
    return { messages: next, changed: true, droppedImages: count, truncatedContents: 0 };
  }

  // 步骤 2：截断超长 content（仅 tool/assistant；system/user 不动）
  const minLen = opts.keepHeadChars + opts.keepTailChars;
  let cIdx = -1;
  let cLen = minLen;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool' && m.role !== 'assistant') continue;
    if (m.content.length > cLen) {
      cLen = m.content.length;
      cIdx = i;
    }
  }
  if (cIdx >= 0) {
    const next = [...messages];
    const target = next[cIdx];
    next[cIdx] = {
      ...target,
      content: truncateMiddle(target.content, opts.keepHeadChars, opts.keepTailChars),
    };
    return { messages: next, changed: true, droppedImages: 0, truncatedContents: 1 };
  }

  return { messages: [...messages], changed: false, droppedImages: 0, truncatedContents: 0 };
}
