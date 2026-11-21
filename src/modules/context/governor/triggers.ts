// src/modules/context/governor/triggers.ts
// 触发决策与降级判定：压缩阈值判断（复用 planner.shouldCompact）、
// 溢出兜底启用条件、手动压缩可用性检查。

import { shouldCompact } from '../compressor/planner';
import type { CompactionConfig } from '../types';

export { shouldCompact };

/** 溢出兜底启用：估算（压缩后）仍超过窗口 - 余量 → view-builder 启用尾部裁剪 */
export function needsHardCeiling(estimatedTokens: number, windowTokens: number): boolean {
  if (windowTokens <= 0) return false;
  // 预留输出与协议帧开销（max_tokens 由请求层另行控制，这里只看输入侧）
  return estimatedTokens > windowTokens - 1024;
}

/** 压缩是否启用（开关 + 窗口有效） */
export function compactionActive(config: CompactionConfig, windowTokens: number): boolean {
  return config.enabled && windowTokens > 0;
}
