// src/modules/context/governor/pressure.ts
// 压力提醒判定（纯函数）：增长/档位驱动，避免占用 ≥ 阈值后每轮重复注入。

import type { ContextPressureConfig, ContextPressureState } from '../types';

export interface PressureDecision {
  inject: boolean;
  band: number;
}

/**
 * @param prev 上次提醒水位（无则 undefined）
 * @param effectiveTotal 当前有效 token 估算
 * @param windowTokens 上下文窗口
 * @param config 压力提醒配置
 */
export function decidePressureReminder(
  prev: ContextPressureState | undefined,
  effectiveTotal: number,
  windowTokens: number,
  config: ContextPressureConfig,
): PressureDecision {
  if (!config.enabled || windowTokens <= 0) return { inject: false, band: 0 };
  const ratio = effectiveTotal / windowTokens;
  const bandStep = config.bandStep > 0 ? config.bandStep : 0.1;
  // 加 epsilon：0.6 / 0.1 在浮点下是 5.999…，直接 floor 会少一档
  const band = Math.floor(ratio / bandStep + 1e-9);
  if (ratio < config.ratio) return { inject: false, band };
  const inject =
    !prev ||
    band > prev.lastBand ||
    config.growthTokens <= 0 ||
    effectiveTotal - prev.lastTokens >= config.growthTokens;
  return { inject, band };
}
