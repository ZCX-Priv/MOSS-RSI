// src/modules/tools/run_code/runtime/value.ts
// ToolResult ↔ CodeValue 转换。
// MOSS 工具返回文本 + 图片路径，没有统一的 typed JSON 契约；因此：
//   1. 优先使用 metadata.value（未来 typed-return 约定）；
//   2. 其次 metadata.structuredContent（MCP structured output）；
//   3. 纯文本若整体是合法 JSON，则解析为 JSON 值；
//   4. 否则返回字符串；
//   5. 含图片时返回 { text, images: [{ path, mimeType }] }，不把 base64 送进程序。

import type { ToolResult } from '../../types';
import {
  isLosslessJsonValue,
  MAX_TOOL_RESULT_BYTES,
  truncateToBytes,
  type CodeValue,
} from './protocol';

/** 程序内可 catch 的工具失败（宿主回传为同 name 的错误） */
export class ToolCallError extends Error {
  readonly toolName: string;
  readonly details?: string;

  constructor(toolName: string, message: string, details?: string) {
    super(message);
    this.name = 'ToolCallError';
    this.toolName = toolName;
    if (details) this.details = details;
  }
}

/** ToolResult 的文本部分 */
export function toolResultText(result: ToolResult): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}

/** ToolResult 的图片路径部分（不含 base64） */
export function toolResultImages(result: ToolResult): Array<{ path?: string; mimeType: string }> {
  const out: Array<{ path?: string; mimeType: string }> = [];
  for (const c of result.content) {
    if (c.type !== 'image') continue;
    out.push({
      ...(c.path ? { path: c.path } : {}),
      mimeType: c.source?.mimeType ?? 'application/octet-stream',
    });
  }
  return out;
}

/** 成功结果 → 程序可见值（带字节上限保护） */
export function toolResultToCodeValue(result: ToolResult): CodeValue {
  const meta = result.metadata;
  if (meta && 'value' in meta && isLosslessJsonValue(meta.value)) {
    return capValue(meta.value);
  }
  if (meta && 'structuredContent' in meta && isLosslessJsonValue(meta.structuredContent)) {
    return capValue(meta.structuredContent);
  }

  const text = toolResultText(result);
  const images = toolResultImages(result);
  if (images.length > 0) {
    const imagesForCode: CodeValue[] = images.map((img) => {
      const item: { [key: string]: CodeValue } = { mimeType: img.mimeType };
      if (img.path) item.path = img.path;
      return item;
    });
    return capValue({
      text: truncateToBytes(text, MAX_TOOL_RESULT_BYTES),
      images: imagesForCode,
    });
  }

  const capped = truncateToBytes(text, MAX_TOOL_RESULT_BYTES);
  const parsed = tryParseJson(capped);
  if (parsed !== undefined) return parsed;
  return capped;
}

function tryParseJson(text: string): CodeValue | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"') || /^-?\d/.test(trimmed) || trimmed === 'true' || trimmed === 'false' || trimmed === 'null')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isLosslessJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function capValue(value: CodeValue): CodeValue {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') <= MAX_TOOL_RESULT_BYTES) return value;
  if (typeof value === 'string') return truncateToBytes(value, MAX_TOOL_RESULT_BYTES);
  if (Array.isArray(value)) {
    return { truncated: true, note: `result exceeded ${MAX_TOOL_RESULT_BYTES} bytes`, preview: truncateToBytes(json, MAX_TOOL_RESULT_BYTES) };
  }
  if (value && typeof value === 'object') {
    return { truncated: true, note: `result exceeded ${MAX_TOOL_RESULT_BYTES} bytes`, preview: truncateToBytes(json, MAX_TOOL_RESULT_BYTES) };
  }
  return value;
}

/** 错误结果 → 程序内错误消息（保留工具名与可读细节） */
export function toolResultErrorMessage(result: ToolResult, toolName: string): string {
  const text = toolResultText(result).trim();
  return `${toolName} failed${text ? `: ${truncateToBytes(text, 8000)}` : ''}`;
}
