// src/modules/context/budgeter/cache-ledger.ts
// 缓存 miss 归因：把一次请求的 miss 拆成
//   newContent（新追加的合法内容）+ compactionRepayment（压缩导致的缓存重付）
//   + ttlRepayment（无法归因：上游 TTL / 客户端改写）
// 恒等式：missed = newContent + compactionRepayment + ttlRepayment。
// 纯函数，不依赖任何 provider 口径（input 已归一化为“含 cached”）。

export interface CacheMissInput {
  /** 本次输入 token（含缓存命中部分） */
  input: number;
  /** 缓存命中 token */
  cached: number;
  /** 上一次请求的输入 token（无样本传 0） */
  previousInput: number;
  /** 本轮是否发生压缩折叠 */
  compactionTriggered: boolean;
}

export interface CacheMissBreakdown {
  missed: number;
  newContent: number;
  compactionRepayment: number;
  ttlRepayment: number;
}

export function decomposeCacheMiss(input: CacheMissInput): CacheMissBreakdown {
  const total = Math.max(0, Math.round(input.input));
  const cached = Math.max(0, Math.min(Math.round(input.cached), total));
  const missed = total - cached;
  if (missed === 0) {
    return { missed: 0, newContent: 0, compactionRepayment: 0, ttlRepayment: 0 };
  }
  const prev = Math.max(0, Math.round(input.previousInput));
  // 输入增长是“新内容”的上界；无上一轮样本时全部视为新内容。
  const growth = prev > 0 ? Math.max(0, total - prev) : total;
  const newContent = Math.min(missed, growth);
  const remaining = missed - newContent;
  const compactionRepayment = input.compactionTriggered ? remaining : 0;
  const ttlRepayment = remaining - compactionRepayment;
  return { missed, newContent, compactionRepayment, ttlRepayment };
}
