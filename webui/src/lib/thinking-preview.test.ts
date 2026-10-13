// 思考状态行预览提取单测。
// 运行：bun test webui/src/lib/thinking-preview.test.ts（或根目录 bun test）

import { describe, it, expect } from 'bun:test';
import { thinkingPreview, formatThinkingSeconds } from './thinking-preview';

describe('thinkingPreview', () => {
  it('空 / undefined / 仅空白 → 空串', () => {
    expect(thinkingPreview(undefined)).toBe('');
    expect(thinkingPreview('')).toBe('');
    expect(thinkingPreview('   \n  \n\t')).toBe('');
  });

  it('多行取最后一个非空行（流式最新片段）', () => {
    expect(thinkingPreview('第一步\n第二步\n第三步')).toBe('第三步');
  });

  it('末尾空行 → 回退到最后一个有内容的行', () => {
    expect(thinkingPreview('a\nb\n   \n')).toBe('b');
  });

  it('去标题 / 列表 / 引用行首标记', () => {
    expect(thinkingPreview('## 分析')).toBe('分析');
    expect(thinkingPreview('- 项目一')).toBe('项目一');
    expect(thinkingPreview('1. 第一项')).toBe('第一项');
    expect(thinkingPreview('> 引用文本')).toBe('引用文本');
  });

  it('去加粗 / 代码标记', () => {
    expect(thinkingPreview('车座在 **座管顶部** `(335, 360)`')).toBe('车座在 座管顶部 (335, 360)');
  });

  it('折叠连续空白为单空格并 trim', () => {
    expect(thinkingPreview('多个    空白   值')).toBe('多个 空白 值');
    expect(thinkingPreview('  前后留白  ')).toBe('前后留白');
  });

  it('流式半截单行（无换行）原样清洗返回', () => {
    expect(thinkingPreview('现在我在确定各个连接点的坐标：车座在座管顶部 (335, 360)')).toBe(
      '现在我在确定各个连接点的坐标：车座在座管顶部 (335, 360)',
    );
  });
});

describe('formatThinkingSeconds', () => {
  it('<1s 显示一位小数（不再显示为 0s）', () => {
    expect(formatThinkingSeconds(300)).toBe('0.3');
    expect(formatThinkingSeconds(50)).toBe('0.1');
    expect(formatThinkingSeconds(0)).toBe('0.0');
  });

  it('0.95–0.999s 归为 1，不出现 1.0', () => {
    expect(formatThinkingSeconds(950)).toBe('1');
    expect(formatThinkingSeconds(999)).toBe('1');
  });

  it('≥1s 显示整数秒', () => {
    expect(formatThinkingSeconds(1000)).toBe('1');
    expect(formatThinkingSeconds(1999)).toBe('1');
    expect(formatThinkingSeconds(12800)).toBe('12');
    expect(formatThinkingSeconds(59900)).toBe('59');
    expect(formatThinkingSeconds(60000)).toBe('60');
  });

  it('负值 / 非有限值 → 0.0', () => {
    expect(formatThinkingSeconds(-1)).toBe('0.0');
    expect(formatThinkingSeconds(Number.NaN)).toBe('0.0');
    expect(formatThinkingSeconds(Number.POSITIVE_INFINITY)).toBe('0.0');
  });
});
