// src/modules/im/render.ts
// 出站文本处理：Markdown → 可读纯文本；按渠道上限分段（优先段落/换行边界）。

import type { ImChannelId } from './types';

/** 各渠道单条消息字符上限（留出余量，避免平台硬截断） */
export const CHANNEL_TEXT_LIMIT: Record<ImChannelId, number> = {
  'qq-official': 2000,
  'wechat-ilink': 1800,
};

/**
 * 代码围栏保护：围栏内只去掉语言标记与收尾围栏，正文原样保留。
 * 不能对代码内容跑 Markdown 正则（会把 `foo_bar`、`a*b` 之类误删）。
 */
function stripCodeFence(fence: string): string {
  return fence
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '');
}

/** 行内 Markdown → 纯文本（保守：只处理成对强调，避免破坏标识符） */
function stripInlineMarkdown(text: string): string {
  let out = text;
  // 行内代码：去掉反引号，保留内容
  out = out.replace(/`([^`\n]+)`/g, '$1');
  // 标题前缀
  out = out.replace(/^#{1,6}\s+/gm, '');
  // 粗体 / 斜体 / 删除线：要求标记两侧不是单词字符（避免 __init__ / foo_bar 被吃掉）
  out = out.replace(/(^|[^\w])\*\*(?=\S)([\s\S]*?\S)\*\*(?![\w])/g, '$1$2');
  out = out.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, '$1$2');
  out = out.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1$2');
  out = out.replace(/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, '$1$2');
  out = out.replace(/(^|[^\w])~~(?=\S)([\s\S]*?\S)~~(?![\w])/g, '$1$2');
  // 链接 [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 图片 ![alt](url) → alt (url)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 表格分隔行 |---|:---:| → 删除
  out = out.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/gm, '');
  return out;
}

/**
 * Markdown → 纯文本：去掉渲染标记但保留内容与换行。
 * 代码围栏整体保护（正文不参与 Markdown 转换），避免代码/标识符丢字。
 */
export function toPlainText(markdown: string): string {
  const source = markdown.replace(/\r\n/g, '\n');
  const parts = source.split(/(```[\s\S]*?```)/g);
  const text = parts
    .map((part) => (part.startsWith('```') ? stripCodeFence(part) : stripInlineMarkdown(part)))
    .join('');
  // 列表符号保留（IM 里可读），但收敛多余空行
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** 硬切长行：边界避开 UTF-16 代理对，emoji 不会被劈成乱码 */
function hardSplit(line: string, limit: number): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < line.length) {
    let end = Math.min(line.length, index + limit);
    if (end < line.length) {
      const code = line.charCodeAt(end - 1);
      // 高代理项：退一格，保证代理对完整落在同一段
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      if (end <= index) end = Math.min(line.length, index + limit + 1);
    }
    chunks.push(line.slice(index, end));
    index = end;
  }
  return chunks;
}

/**
 * 分段：优先按空行（段落），其次按行，最后按字符硬切。
 * 每段都 trim；空段丢弃。
 */
export function splitText(text: string, limit: number): string[] {
  const source = text.trim();
  if (!source) return [];
  if (source.length <= limit) return [source];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };

  const blocks = source.split(/\n{2,}/);
  for (const block of blocks) {
    if (block.length <= limit) {
      if (current.length + block.length + 2 > limit) flush();
      current = current ? `${current}\n\n${block}` : block;
      continue;
    }
    flush();
    const lines = block.split('\n');
    for (const line of lines) {
      if (line.length <= limit) {
        if (current.length + line.length + 1 > limit) flush();
        current = current ? `${current}\n${line}` : line;
        continue;
      }
      flush();
      chunks.push(...hardSplit(line, limit));
    }
  }
  flush();
  return chunks;
}

/** 按渠道能力准备待发送分段 */
export function prepareOutbound(channel: ImChannelId, markdown: string, supportsMarkdown: boolean): string[] {
  const text = supportsMarkdown ? markdown.trim() : toPlainText(markdown);
  return splitText(text, CHANNEL_TEXT_LIMIT[channel]);
}
