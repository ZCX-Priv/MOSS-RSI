// render/core/block-splitter.ts
// 块分割器：流式渲染不闪烁的核心。
//
// 设计原理：LLM 输出是 append-only 文本流。以空行为块边界把全文切成块序列，
// 已闭合块（后面出现过空行）的 raw 永不再变化 → MarkdownBlock 用 React.memo 冻结，
// 每个流式 token 只重渲染最后一个活跃块。代码块/数学块只在闭合时高亮/排版一次。
//
// 顶层围栏快速通道：列 0 的 ``` / ~~~ 围栏直接产出「代码体 + fenceLang」块，
// 绕过 markdown-it —— 流式过程中即可渲染为代码卡片，而不是等整轮结束才解析。
// 缩进围栏（列表/引用内）仍交给 markdown-it，避免破坏嵌套结构。
//
// 跨空行结构：代码围栏（``` / ~~~）与 $$ 数学块内部的空行不视为边界（状态机吸收）。

import type { RenderBlock } from './types';

/** 围栏行：```lang 或 ~~~lang（允许缩进，覆盖列表内嵌代码块） */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
/** 顶层开栏行：列 0 的 ``` / ~~~（快速通道） */
const TOP_FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
/** 顶层闭栏行：0–3 空格缩进 + 同字符且长度 ≥ 开栏长度的反引号/波浪号 + 仅空白 */
const TOP_FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** 判断一行是否空行（仅空白） */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** 去掉行尾 \r（CRLF 输入统一按 LF 处理） */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 统计一行中 `$$` 出现次数（用于奇偶判定数学块开合） */
function countDollarDollar(line: string): number {
  let count = 0;
  let i = 0;
  while ((i = line.indexOf('$$', i)) !== -1) {
    count++;
    i += 2;
  }
  return count;
}

/**
 * 从 start（开栏行之后的下一行）起收集围栏代码体。
 * 返回 closed=是否找到闭合行，nextIndex=闭合行下标（未闭合为末尾下标），body=代码体各行。
 */
function collectTopFence(
  lines: readonly string[],
  start: number,
  openChar: string,
  openLength: number,
): { body: string[]; closed: boolean; nextIndex: number } {
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = stripCr(lines[i]);
    const close = TOP_FENCE_CLOSE_RE.exec(line);
    if (close && close[1][0] === openChar && close[1].length >= openLength) {
      return { body, closed: true, nextIndex: i };
    }
    body.push(line);
  }
  return { body, closed: false, nextIndex: lines.length - 1 };
}

/**
 * 把 markdown 文本切成块序列。
 *
 * closed 语义：块结束由空行分隔 → true；块到达文本末尾 → false（活跃块，可能继续增长）。
 * 顶层围栏块：raw 为围栏内部代码体，fenceLang 为 info 首词；流式未闭合时 closed=false。
 */
export function splitBlocks(text: string): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  if (!text) return blocks;

  const lines = text.split('\n');
  let current: string[] = [];
  let inFence = false;
  let fenceChar = '`';
  let mathOpen = false; // 块内 $$ 计数为奇（跨行数学未闭合）
  let inBlock = false;

  const flush = (closed: boolean) => {
    if (current.length === 0) return;
    blocks.push({ index: blocks.length, raw: current.join('\n'), closed });
    current = [];
    inBlock = false;
    // fence/math 状态在 flush 时必须已归零（空行仅在非 fence/math 下才分块）
  };

  for (let i = 0; i < lines.length; i++) {
    const line = stripCr(lines[i]);

    if (isBlank(line) && !inFence && !mathOpen) {
      flush(true);
      continue;
    }

    // 顶层围栏快速通道：直接成代码块（流式期间即可渲染代码卡片）
    if (!inFence && !mathOpen) {
      const open = TOP_FENCE_OPEN_RE.exec(line);
      if (open) {
        const marker = open[1];
        const info = open[2].trim();
        // CommonMark：反引号围栏的 info 不允许再含反引号 → 不是围栏
        if (!(marker[0] === '`' && info.includes('`'))) {
          flush(true);
          const fence = collectTopFence(lines, i + 1, marker[0], marker.length);
          blocks.push({
            index: blocks.length,
            raw: fence.body.join('\n'),
            closed: fence.closed,
            fenceLang: info.split(/\s+/)[0] ?? '',
          });
          i = fence.nextIndex;
          continue;
        }
      }
    }

    if (!inBlock) {
      inBlock = true;
    }
    current.push(line);

    if (inFence) {
      // 尝试闭合：同字符、长度 >= 开栏长度、内容仅空白
      const m = FENCE_RE.exec(line);
      if (m && m[2][0] === fenceChar) {
        inFence = false;
        mathOpen = false;
      }
      continue;
    }

    // 围栏开栏检测（fence 行内的 $$ 不计数）
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[2][0];
      mathOpen = false;
      continue;
    }

    // 数学块奇偶追踪（单行 $$x$$ 计数 2 → 不改变状态；单独 $$ → 切换）
    if (countDollarDollar(line) % 2 === 1) {
      mathOpen = !mathOpen;
    }
  }

  // 文本末尾的块 = 活跃块
  flush(false);
  return blocks;
}
