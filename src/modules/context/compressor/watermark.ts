// src/modules/context/compressor/watermark.ts
// 物理折叠后的会话级水位重算。
// lastDistilledIndex 是 session.messages 的数组下标水位；折叠会从数组中部删除消息，
// 若不重算，slice(watermark) 会跳过新消息（水位偏小）或恒为空（水位大于新长度），
// 表现为压缩一次后记忆蒸馏永久停摆。

import type { ContextMessage } from '../types';

/**
 * 按“折叠后仍然存在、且在旧水位之前的消息数量”重算新水位。
 * 摘要消息没有旧下标，视为未蒸馏内容：若它位于第一个未蒸馏旧消息之前，
 * 水位会停在摘要消息之后，从而不会被 slice 跳过。
 *
 * @param oldMessages 折叠前的 session.messages 快照（保持对象身份）
 * @param newMessages 折叠后的 session.messages
 * @param watermark 旧水位（undefined 表示从未蒸馏）
 * @returns 新水位；入参 watermark 为 undefined 时原样返回
 */
export function rebaseDistillWatermark(
  oldMessages: readonly ContextMessage[],
  newMessages: readonly ContextMessage[],
  watermark: number | undefined,
): number | undefined {
  if (watermark === undefined) return undefined;
  const oldIndex = new Map<ContextMessage, number>();
  oldMessages.forEach((m, i) => oldIndex.set(m, i));

  let next = newMessages.length;
  for (let i = 0; i < newMessages.length; i++) {
    const prev = oldIndex.get(newMessages[i]);
    if (prev !== undefined && prev >= watermark) {
      next = i;
      break;
    }
  }
  return Math.max(0, Math.min(next, newMessages.length));
}
