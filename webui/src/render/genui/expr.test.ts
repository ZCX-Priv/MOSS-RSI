// webui/src/render/genui/expr.test.ts
// 受限表达式解释器：白名单、短路、错误隔离、拒绝属性穿透/任意代码。

import { describe, expect, test } from 'bun:test';
import { evaluateExpr } from './expr';

describe('genui expression evaluator', () => {
  test('evaluates arithmetic and state reads', () => {
    expect(evaluateExpr('seats * 29', { seats: 8 })).toBe(232);
    expect(evaluateExpr('(seats + 2) / 2', { seats: 8 })).toBe(5);
  });

  test('supports string concatenation and ternary', () => {
    expect(evaluateExpr("'Hello ' + name", { name: 'MOSS' })).toBe('Hello MOSS');
    expect(evaluateExpr('seats > 5 ? "many" : "few"', { seats: 8 })).toBe('many');
  });

  test('supports whitelisted functions', () => {
    expect(evaluateExpr('round(2.6)', {})).toBe(3);
    expect(evaluateExpr('min(3, 1, 2)', {})).toBe(1);
    expect(evaluateExpr("len('abc')", {})).toBe(3);
  });

  test('short-circuits logical operators', () => {
    const errors: string[] = [];
    expect(evaluateExpr('true || missing', {}, (m) => errors.push(m))).toBe(true);
    expect(errors.length).toBe(0);
  });

  test('rejects property access, indexing and assignment', () => {
    for (const source of ['user.name', 'items[0]', 'a = 1', 'obj["x"]', '`x`']) {
      const errors: string[] = [];
      const value = evaluateExpr(source, { user: 1 }, (m) => errors.push(m));
      expect(value).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  test('rejects eval/Function/constructor', () => {
    for (const source of ['eval("1")', 'Function("return 1")()', 'constructor']) {
      const errors: string[] = [];
      expect(evaluateExpr(source, {}, (m) => errors.push(m))).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  test('returns null for unknown state and division by zero', () => {
    const errors: string[] = [];
    expect(evaluateExpr('missing + 1', {}, (m) => errors.push(m))).toBeNull();
    expect(evaluateExpr('1 / 0', {}, (m) => errors.push(m))).toBeNull();
    expect(errors.length).toBe(2);
  });
});
