// src/modules/context/budgeter/calibration.ts
// tokPerChar 校准：从真实 usage 反推 tokens/char 比率。
// 按模型（provider/model）分键：不同 tokenizer 的比率差异可达数倍，
// 单一全局比率会在切换模型后系统性高估/低估上下文占用。
// 有效域 (0.05, 2)：忽略异常比率；无样本时回退 0.25（~4 chars/token）。

/** 无校准数据时的回退比率（tokens per char） */
const FALLBACK_TOK_PER_CHAR = 0.25;
/** 校准比率有效域（provider 返回异常 usage 时防污染） */
const RATIO_MIN = 0.05;
const RATIO_MAX = 2.0;
/** 未指定模型键时的兜底键 */
const DEFAULT_KEY = '__default__';

export class TokenCalibrator {
  private readonly ratios = new Map<string, number>();
  private readonly samples = new Map<string, number>();

  /**
   * 用一轮真实请求校准指定模型：promptTokens / promptChars。
   * chars 为发送内容的字符口径（见 estimator.messagesChars）。
   */
  calibrate(modelKey: string, promptTokens: number, promptChars: number): void {
    if (promptTokens <= 0 || promptChars <= 0) return;
    const r = promptTokens / promptChars;
    if (r > RATIO_MIN && r < RATIO_MAX) {
      const key = modelKey || DEFAULT_KEY;
      this.ratios.set(key, r);
      this.samples.set(key, (this.samples.get(key) ?? 0) + 1);
    }
  }

  /** 当前模型的 tokens/char 比率（未校准时为 fallback） */
  getTokPerChar(modelKey: string): number {
    return this.ratios.get(modelKey || DEFAULT_KEY) ?? FALLBACK_TOK_PER_CHAR;
  }

  /** 按已校准比率估算 token（用于治理器压力/压缩阈值；未校准时返回 fallback） */
  estimateTokens(modelKey: string, chars: number): number {
    if (!Number.isFinite(chars) || chars <= 0) return 0;
    return Math.max(0, Math.round(chars * this.getTokPerChar(modelKey)));
  }

  /** 指定模型是否已获得校准 */
  isCalibrated(modelKey: string): boolean {
    return this.ratios.has(modelKey || DEFAULT_KEY);
  }

  /** 指定模型的校准样本数 */
  getSamples(modelKey: string): number {
    return this.samples.get(modelKey || DEFAULT_KEY) ?? 0;
  }

  /** 已校准过的模型键（调试/面板用） */
  listCalibratedModels(): string[] {
    return [...this.ratios.keys()];
  }
}
