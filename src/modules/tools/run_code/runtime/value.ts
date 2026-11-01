// src/modules/tools/run_code/runtime/value.ts
// ToolResult ↔ CodeValue 转换。
// MOSS 工具返回文本 + 图片路径；PTC 内优先拿到结构化数据（完整、不按展示文本截断）：
//   1. metadata.value（工具的 typed-return 约定，如 web search/fetch、terminal raw）；
//   2. metadata.structured（MCP structured output，AgentEngine 实际写入的键）；
//   3. metadata.structuredContent（兼容 MCP 规范命名）；
//   4. 纯文本整体为合法 JSON → 解析为 JSON 值；
//   5. 否则返回完整文本字符串；
//   6. 含图片时返回 { text, images: [{ path, mimeType }] }，不把 base64 送进程序。
// 所有结构化值都会经过 sanitizeForJson，避免 Date/undefined 等导致调用失败。

import type { ToolResult } from '../../types';
import { sanitizeForJson } from './sanitize';
import { truncateToBytes, type CodeValue } from './protocol';

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

/** 成功结果 → 程序可见值（结构化优先；不按输出预算截断） */
export function toolResultToCodeValue(result: ToolResult): CodeValue {
  const meta = result.metadata;
  if (meta) {
    for (const candidate of [meta.value, meta.structured, meta.structuredContent]) {
      if (candidate === undefined) continue;
      return sanitizeForJson(candidate).value;
    }
  }

  const text = toolResultText(result);
  const images = toolResultImages(result);
  if (images.length > 0) {
    const imagesForCode: CodeValue[] = images.map((img) => {
      const item: { [key: string]: CodeValue } = { mimeType: img.mimeType };
      if (img.path) item.path = img.path;
      return item;
    });
    return { text, images: imagesForCode };
  }

  const parsed = tryParseJson(text);
  if (parsed !== undefined) return parsed;
  return text;
}

function tryParseJson(text: string): CodeValue | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (
    !(
      trimmed.startsWith('{') ||
      trimmed.startsWith('[') ||
      trimmed.startsWith('"') ||
      /^-?\d/.test(trimmed) ||
      trimmed === 'true' ||
      trimmed === 'false' ||
      trimmed === 'null'
    )
  ) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return sanitizeForJson(parsed).value;
  } catch {
    return undefined;
  }
}

/** 错误结果 → 程序内错误消息（保留工具名与可读细节） */
export function toolResultErrorMessage(result: ToolResult, toolName: string): string {
  const text = toolResultText(result).trim();
  return `${toolName} failed${text ? `: ${truncateToBytes(text, 8000)}` : ''}`;
}
