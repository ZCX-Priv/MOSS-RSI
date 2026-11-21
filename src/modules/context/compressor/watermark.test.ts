// src/modules/context/compressor/watermark.test.ts
// 物理折叠后的记忆蒸馏水位重算：确保 slice(watermark) 不会跳过新消息或恒为空。

import { describe, test, expect } from 'bun:test';
import { rebaseDistillWatermark } from './watermark';
import type { ContextMessage } from '../types';

function msg(content: string): ContextMessage {
  return { role: 'user', content };
}

describe('rebaseDistillWatermark', () => {
  test('删除点全部在水位之前：水位按删除数量回退', () => {
    const keep1 = msg('k1');
    const keep2 = msg('k2');
    const tail1 = msg('t1');
    const tail2 = msg('t2');
    const old = [keep1, keep2, tail1, tail2];
    // 水位 4（全部已蒸馏），删掉前两条
    const next = rebaseDistillWatermark(old, [tail1, tail2], 4);
    expect(next).toBe(2);
  });

  test('删除点全部在水位之后：水位不变', () => {
    const a = msg('a');
    const b = msg('b');
    const c = msg('c');
    const d = msg('d');
    const old = [a, b, c, d];
    // 水位 2，删掉 c/d
    const next = rebaseDistillWatermark(old, [a, b], 2);
    expect(next).toBe(2);
  });

  test('混合删除：水位落在第一个未蒸馏旧消息处', () => {
    const a = msg('a');
    const b = msg('b');
    const c = msg('c');
    const d = msg('d');
    const e = msg('e');
    const old = [a, b, c, d, e];
    // 水位 3（a/b/c 已蒸馏），删 b/c；剩下 a/d/e
    const next = rebaseDistillWatermark(old, [a, d, e], 3);
    expect(next).toBe(1); // a 之后、d 之前
  });

  test('摘要消息没有旧下标：视为未蒸馏，水位停在它之后', () => {
    const a = msg('a');
    const b = msg('b');
    const summary = msg('summary');
    const old = [a, b];
    // 水位 1（a 已蒸馏），b 被折叠为摘要
    const next = rebaseDistillWatermark(old, [a, summary], 1);
    expect(next).toBe(2); // 摘要之后（distiller 会按 name/role 过滤它）
  });

  test('水位未初始化时原样返回 undefined', () => {
    expect(rebaseDistillWatermark([msg('a')], [msg('a')], undefined)).toBeUndefined();
  });

  test('水位大于新长度时收敛到新长度', () => {
    const a = msg('a');
    const b = msg('b');
    const next = rebaseDistillWatermark([a, b], [], 2);
    expect(next).toBe(0);
  });
});
