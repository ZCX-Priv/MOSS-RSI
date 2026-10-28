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

  test('supports string helpers for local computation', () => {
    expect(evaluateExpr("contains('1,2;3,4', '3,4')", {})).toBe(true);
    expect(evaluateExpr("indexOf('a;b;c', ';')", {})).toBe(1);
    expect(evaluateExpr("lastIndexOf('a;b;c', ';')", {})).toBe(3);
    expect(evaluateExpr("slice('abcdef', 1, 4)", {})).toBe('bcd');
    expect(evaluateExpr("part('a,2;b,3', ';', 1)", {})).toBe('b,3');
    expect(evaluateExpr("charAt('abc', 1)", {})).toBe('b');
  });

  test('supports a turn-based snake step sequence', () => {
    let state: Record<string, string | number | boolean | null> = {
      body: '5,5;4,5;3,5',
      dir: 'right',
      hx: 5,
      hy: 5,
      nx: 5,
      ny: 5,
      hit: 0,
      eat: 0,
      status: 0,
      score: 0,
      fx: 7,
      fy: 3,
    };
    const steps: Array<[string, string]> = [
      ['nx', 'status == 2 ? hx : hx + (dir == "left" ? -1 : dir == "right" ? 1 : 0)'],
      ['ny', 'status == 2 ? hy : hy + (dir == "up" ? -1 : dir == "down" ? 1 : 0)'],
      [
        'hit',
        'status == 2 ? 0 : (nx < 0 || nx > 9 || ny < 0 || ny > 9 || contains(slice(body, 0, lastIndexOf(body, ";")), nx + "," + ny) ? 1 : 0)',
      ],
      ['eat', 'hit == 0 && nx == fx && ny == fy ? 1 : 0'],
      ['status', 'hit == 1 ? 2 : status'],
      ['score', 'eat == 1 ? score + 1 : score'],
      [
        'body',
        'hit == 1 ? body : (eat == 1 ? nx + "," + ny + ";" + body : nx + "," + ny + ";" + slice(body, 0, lastIndexOf(body, ";")))',
      ],
      ['hx', 'hit == 1 ? hx : nx'],
      ['hy', 'hit == 1 ? hy : ny'],
    ];

    for (const [key, expression] of steps) {
      state = { ...state, [key]: evaluateExpr(expression, state) };
    }

    expect(state.hx).toBe(6);
    expect(state.hy).toBe(5);
    expect(state.body).toBe('6,5;5,5;4,5');
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
