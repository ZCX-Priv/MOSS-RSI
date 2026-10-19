// read/handlers/image.ts
// 图片文件处理：读取图片二进制，返回 base64 + mimeType。
// 使用 ToolResultContent 的 image 类型，供多模态 LLM 视觉分析。
// 不做 sharp 缩放，原样返回（降低依赖复杂度，LLM 可直接处理原图）。

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { ToolResult } from '../../types';

/** 扩展名 → MIME 类型映射（不含 .svg —— SVG 由 text handler 作为代码读取） */
const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/**
 * 读取图片文件，返回 base64 编码 + MIME 类型。
 * 图片以 ToolResultContent.image 类型返回，供多模态 LLM 直接视觉分析。
 */
export async function readImage(path: string): Promise<ToolResult> {
  const buf = readFileSync(path);
  const mime = MIME_MAP[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const base64 = buf.toString('base64');

  return {
    content: [{ type: 'image', source: { data: base64, mimeType: mime }, path }],
    metadata: {
      type: 'image',
      mimeType: mime,
      sizeBytes: buf.length,
    },
  };
}
