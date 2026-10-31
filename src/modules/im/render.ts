// src/modules/im/render.ts
// 出站文本处理：Markdown → 可读纯文本；按渠道上限分段（优先段落/换行边界）。

import type { ImChannelId } from './types';

/** 各渠道单条消息字符上限（留出余量，避免平台硬截断） */
export const CHANNEL_TEXT_LIMIT: Record<ImChannelId, number> = {
  'qq-official': 2000,
  'wechat-ilink': 1800,
};

/**
 * Markdown → 纯文本：去掉渲染标记但保留内容与换行。
 * 只做最小必要转换（完整 Markdown 解析对 IM 纯文本没有价值）。
 */
export function toPlainText(markdown: string): string {
  let text = markdown.replace(/\r\n/g, '\n');
  // 代码围栏：去掉 ```lang 与收尾 ```，保留代码正文
  text = text.replace(/```[^\n]*\n?/g, '');
  // 行内代码
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // 标题前缀
  text = text.replace(/^#{1,6}\s+/gm, '');
  // 粗体 / 斜体 / 删除线
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  // 链接 [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 图片 ![alt](url) → alt (url)
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 表格分隔行 |---|:---:| → 删除
  text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/gm, '');
  // 列表符号保留（IM 里可读），但收敛多余空行
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
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
      for (let index = 0; index < line.length; index += limit) {
        chunks.push(line.slice(index, index + limit));
      }
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
