// src/modules/tools/run_code/runtime/sanitize.test.ts
// 返回值净化与参数违规定位测试。

import { describe, expect, test } from 'bun:test';
import { findJsonViolation, sanitizeForJson } from './sanitize';

describe('sanitizeForJson', () => {
  test('常见非 JSON 值被转换并记录警告', () => {
    const result = sanitizeForJson({
      a: undefined,
      d: new Date('2026-11-01T00:00:00Z'),
      m: new Map([['k', 1]]),
      s: new Set([1, 2]),
      b: 10n,
      n: Number.NaN,
      fn: () => 1,
    });
    expect(result.value).toEqual({
      d: '2026-11-01T00:00:00.000Z',
      m: [['k', 1]],
      s: [1, 2],
      b: '10',
      n: null,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.path === 'root.a')).toBe(true);
    expect(result.warnings.some((warning) => warning.path === 'root.d')).toBe(true);
  });

  test('数组中的 undefined 变成 null', () => {
    const result = sanitizeForJson([1, undefined, 3]);
    expect(result.value).toEqual([1, null, 3]);
  });

  test('循环引用不抛错', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    const result = sanitizeForJson(value);
    expect(result.value).toEqual({ a: 1, self: '[Circular]' });
    expect(result.warnings.some((warning) => warning.reason.includes('循环引用'))).toBe(true);
  });

  test('Error 转对象', () => {
    const result = sanitizeForJson(new Error('boom'));
    expect(result.value).toEqual(expect.objectContaining({ name: 'Error', message: 'boom' }));
  });
});

describe('findJsonViolation', () => {
  test('定位第一个非法路径', () => {
    expect(findJsonViolation({ a: 1, b: undefined }, 'args')?.path).toBe('args.b');
    expect(findJsonViolation({ a: [1, () => 1] }, 'args')?.path).toBe('args.a[1]');
    expect(findJsonViolation({ a: new Date() }, 'args')?.reason).toContain('Date');
  });

  test('合法 JSON 返回 null', () => {
    expect(findJsonViolation({ a: [1, 'x', null, true] }, 'args')).toBeNull();
  });

  test('检测循环引用', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(findJsonViolation(value, 'args')?.reason).toContain('cyclic');
  });
});
