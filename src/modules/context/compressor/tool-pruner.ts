// src/modules/context/compressor/tool-pruner.ts
// 工具结果微压缩：超过阈值时保留头尾、中段替换为修剪标记。
// 仅作用于发送视图（session 原文不动），模型需要完整内容时可按提示重新读取。

import type { ToolPruningConfig } from '../types';

/** 中段修剪标记 */
export const PRUNE_MARKER = '\n[... 工具结果中段已修剪（保留头尾），需要完整内容请重新读取 ...]\n';

/**
 * 工具结果修剪（发送视图）。
 * content ≤ threshold 原样返回；否则头部 keepHead + 标记 + 尾部 keepTail。
 */
export function pruneToolResultView(content: string, config: ToolPruningConfig): string {
  const { thresholdChars, keepHeadChars, keepTailChars } = config;
  if (content.length <= thresholdChars) return content;

  const head = content.slice(0, keepHeadChars);
  const tail = content.length > keepTailChars ? content.slice(content.length - keepTailChars) : '';
  return `${head}${PRUNE_MARKER}${tail}`;
}

/**
 * 修剪预览（遥测/统计用）：返回修剪前后长度。
 * 未触发修剪时 after === before。
 */
export function prunePreview(content: string, config: ToolPruningConfig): { before: number; after: number } {
  const pruned = pruneToolResultView(content, config);
  return { before: content.length, after: pruned.length };
}
