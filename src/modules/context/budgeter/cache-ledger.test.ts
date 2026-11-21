import { describe, expect, test } from 'bun:test';
import { decomposeCacheMiss } from './cache-ledger';

describe('decomposeCacheMiss', () => {
  test('恒等式：missed = newContent + compactionRepayment + ttlRepayment', () => {
    const cases = [
      { input: 1000, cached: 800, previousInput: 900, compactionTriggered: false },
      { input: 1000, cached: 200, previousInput: 950, compactionTriggered: true },
      { input: 500, cached: 500, previousInput: 400, compactionTriggered: true },
      { input: 1200, cached: 0, previousInput: 0, compactionTriggered: false },
    ];
    for (const c of cases) {
      const b = decomposeCacheMiss(c);
      expect(b.newContent + b.compactionRepayment + b.ttlRepayment).toBe(b.missed);
      expect(b.missed).toBe(Math.max(0, c.input - c.cached));
    }
  });

  test('无压缩时剩余 miss 归入 TTL/改写', () => {
    const b = decomposeCacheMiss({ input: 1000, cached: 500, previousInput: 1000, compactionTriggered: false });
    expect(b.newContent).toBe(0);
    expect(b.compactionRepayment).toBe(0);
    expect(b.ttlRepayment).toBe(500);
  });

  test('压缩轮：增长之外的 miss 归入压缩重付', () => {
    const b = decomposeCacheMiss({ input: 1000, cached: 500, previousInput: 900, compactionTriggered: true });
    expect(b.newContent).toBe(100);
    expect(b.compactionRepayment).toBe(400);
    expect(b.ttlRepayment).toBe(0);
  });
});
