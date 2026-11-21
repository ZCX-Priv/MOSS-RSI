import { describe, expect, test } from 'bun:test';
import { decidePressureReminder } from './pressure';
import { DEFAULT_CONTEXT_PRESSURE_CONFIG } from '../types';

const cfg = DEFAULT_CONTEXT_PRESSURE_CONFIG;

describe('decidePressureReminder', () => {
  test('低于阈值不提醒', () => {
    expect(decidePressureReminder(undefined, 400, 1000, cfg).inject).toBe(false);
  });

  test('首次越过阈值提醒一次', () => {
    const d = decidePressureReminder(undefined, 600, 1000, cfg);
    expect(d.inject).toBe(true);
    expect(d.band).toBe(6);
  });

  test('同档位增长不足不重复提醒', () => {
    const prev = { lastAt: Date.now(), lastTokens: 600, lastBand: 6 };
    expect(decidePressureReminder(prev, 6100, 10000, cfg).inject).toBe(false);
  });

  test('同档位累计增长达到 growthTokens 再次提醒', () => {
    const prev = { lastAt: Date.now(), lastTokens: 6000, lastBand: 6 };
    expect(decidePressureReminder(prev, 14500, 10000, cfg).inject).toBe(true);
  });

  test('跨档位立即提醒', () => {
    const prev = { lastAt: Date.now(), lastTokens: 5100, lastBand: 5 };
    expect(decidePressureReminder(prev, 6200, 10000, cfg).inject).toBe(true);
  });
});
