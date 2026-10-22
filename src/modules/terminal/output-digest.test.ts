// src/modules/terminal/output-digest.test.ts
// 输出精简单测：进度条归一、重复行折叠、错误块保留、成功静默窗口。
import { describe, expect, it } from 'bun:test';
import { digestCommandOutput, normalizeOutput } from './output-digest';

describe('normalizeOutput', () => {
  it('进度条按 \\r 覆盖取最终帧', () => {
    expect(normalizeOutput('Downloading 10%\rDownloading 55%\rDownloading 100%\nDone\n')).toEqual([
      'Downloading 100%',
      'Done',
    ]);
  });

  it('退格回退与 C0 控制符清理', () => {
    // a b \b（删除 b）c \0 d \a → acd
    expect(normalizeOutput('ab\bc\u0000d\u0007\n')).toEqual(['acd']);
  });
});

describe('digestCommandOutput', () => {
  it('连续相同行折叠为 ×N', () => {
    const raw = `${Array.from({ length: 200 }, () => 'spam line').join('\n')}\nfinished\n`;
    const out = digestCommandOutput(raw, { exitCode: 0 });
    expect(out.text).toContain('spam line  [×200]');
    expect(out.text).toContain('finished');
    expect(out.stats.collapsedLines).toBeGreaterThan(0);
  });

  it('大输出中间的 Error/Traceback 块必须保留', () => {
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(i === 200 ? 'ERROR: database exploded' : `filler-${i}`);
    }
    const out = digestCommandOutput(lines.join('\n'), { exitCode: 1, maxChars: 60_000 });
    expect(out.text).toContain('ERROR: database exploded');
    expect(out.stats.omittedLines).toBeGreaterThan(0);
  });

  it('成功且无错误信号时使用更紧的头尾窗口', () => {
    const raw = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n');
    const out = digestCommandOutput(raw, { exitCode: 0 });
    expect(out.text).toContain('line-0');
    expect(out.text).toContain('line-399');
    expect(out.text).not.toContain('line-200');
    expect(out.stats.omittedLines).toBeGreaterThan(300);
  });

  it('小输出原样返回（只归一化，不做窗口裁剪）', () => {
    const out = digestCommandOutput('a\r\nb\r\n', { exitCode: 0 });
    expect(out.text).toBe('a\nb');
    expect(out.stats.omittedLines).toBe(0);
  });
});
