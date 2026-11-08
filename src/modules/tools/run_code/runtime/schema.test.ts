// src/modules/tools/run_code/runtime/schema.test.ts
// PTC 参数校验与签名生成。

import { describe, expect, test } from 'bun:test';
import { buildToolSignature, validateToolArguments } from './schema';

const readSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'file path' },
    offset: { type: 'integer' },
    limit: { type: 'integer' },
  },
  required: ['path'],
};

describe('buildToolSignature', () => {
  test('必填/可选参数与类型', () => {
    expect(buildToolSignature('read', readSchema)).toBe(
      'read(path: string, offset?: integer, limit?: integer)',
    );
  });

  test('无 properties → 空签名', () => {
    expect(buildToolSignature('todo', { type: 'object' })).toBe('todo()');
  });
});

describe('validateToolArguments', () => {
  test('缺少必填参数：返回签名与实际入参', () => {
    const result = validateToolArguments('read', { pth: 'a.txt' }, readSchema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('read.path 为必填参数');
    expect(result.message).toContain('read(path: string, offset?: integer, limit?: integer)');
    expect(result.message).toContain('pth');
  });

  test('类型不匹配', () => {
    const result = validateToolArguments('read', { path: 123 }, readSchema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('read.path 应为 string');
  });

  test('字符串化 JSON 自动解析', () => {
    const result = validateToolArguments('read', '{"path":"a.txt","limit":10}', readSchema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toEqual({ path: 'a.txt', limit: 10 });
    expect(result.note).toContain('自动解析');
  });

  test('非法字符串参数报错', () => {
    const result = validateToolArguments('read', 'not-json', readSchema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('参数应为对象');
  });

  test('enum 校验', () => {
    const schema = {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b'] } },
      required: ['mode'],
    };
    const bad = validateToolArguments('demo', { mode: 'c' }, schema);
    expect(bad.ok).toBe(false);
    const good = validateToolArguments('demo', { mode: 'a' }, schema);
    expect(good.ok).toBe(true);
  });

  test('嵌套对象与数组元素校验', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
      required: ['items'],
    };
    const result = validateToolArguments('demo', { items: [{ id: 'x' }, { name: 'y' }] }, schema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('items[1].id 为必填参数');
  });

  test('默认放行未知字段；additionalProperties=false 才拒绝', () => {
    const loose = validateToolArguments('read', { path: 'a', extra: 1 }, readSchema);
    expect(loose.ok).toBe(true);

    const strict = validateToolArguments(
      'read',
      { path: 'a', extra: 1 },
      { ...readSchema, additionalProperties: false },
    );
    expect(strict.ok).toBe(false);
    if (strict.ok) return;
    expect(strict.message).toContain('read.extra 不是该工具支持的参数');
  });

  test('schema 缺失时放行', () => {
    const result = validateToolArguments('unknown', { any: true }, undefined);
    expect(result.ok).toBe(true);
  });
});
