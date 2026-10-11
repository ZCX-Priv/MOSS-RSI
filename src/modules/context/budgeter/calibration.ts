// src/modules/context/budgeter/calibration.ts
// tokPerChar 校准：从真实 usage 反推 tokens/char 比率。
// 有效域 (0.05, 2)：忽略异常比率；无校准数据时回退 0.25（~4 chars/token）。

/** 无校准数据时的回退比率（tokens per char） */
const FALLBACK_TOK_PER_CHAR = 0.25;
/** 校准比率有效域（provider 返回异常 usage 时防污染） */
const RATIO_MIN = 0.05;
const RATIO_MAX = 2.0;

export class TokenCalibrator {
  private ratio: number | null = null;
  /** 校准样本数（遥测用） */
  private samples = 0;

  /**
   * 用一轮真实请求校准：promptTokens / promptChars。
   * chars 为发送内容的字符口径（见 estimator.messagesChars）。
   */
  calibrate(promptTokens: number, promptChars: number): void {
    if (promptTokens <= 0 || promptChars <= 0) return;
    const r = promptTokens / promptChars;
    if (r > RATIO_MIN && r < RATIO_MAX) {
      this.ratio = r;
      this.samples++;
    }
  }

  /** 当前 tokens/char 比率（未校准时为 fallback） */
  getTokPerChar(): number {
    return this.ratio ?? FALLBACK_TOK_PER_CHAR;
  }

  /** 是否已获得校准 */
  isCalibrated(): boolean {
    return this.ratio !== null;
  }

  /** 校准样本数 */
  getSamples(): number {
    return this.samples;
  }
}
