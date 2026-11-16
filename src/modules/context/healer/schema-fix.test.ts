// src/modules/context/healer/schema-fix.test.ts
// healer schema 自愈单测：覆盖真实工具调用失误（enum 近似值、单值数组、嵌套参数）。

import { describe, expect, test } from 'bun:test';
import { validateAndFixSchema } from './schema-fix';

const toolSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['exec', 'create', 'send', 'read', 'list', 'kill', 'restart'],
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          oldString: { type: 'string' },
          newString: { type: 'string' },
          replaceAll: { type: 'boolean' },
        },
        required: ['oldString', 'newString'],
        additionalProperties: false,
      },
    },
  },
  required: ['action'],
};

describe('validateAndFixSchema', () => {
  test('enum 唯一前缀纠正：execute → exec', () => {
    const result = validateAndFixSchema({ action: 'execute' }, toolSchema, true);
    expect(result.valid).toBe(true);
    expect(result.args.action).toBe('exec');
    expect(result.fixes.some((f) => f.includes('corrected "execute" to enum value "exec"'))).toBe(true);
  });

  test('enum 大小写纠正：EXEC → exec', () => {
    const result = validateAndFixSchema({ action: 'EXEC' }, toolSchema, true);
    expect(result.valid).toBe(true);
    expect(result.args.action).toBe('exec');
  });

  test('单值自动包装为数组', () => {
    const result = validateAndFixSchema({ action: 'exec', tools: 'read' }, toolSchema, true);
    expect(result.valid).toBe(true);
    expect(result.args.tools).toEqual(['read']);
    expect(result.fixes.some((f) => f.includes('wrapped single string into array'))).toBe(true);
  });

  test('嵌套对象字段类型修正 + 未知字段剔除', () => {
    const result = validateAndFixSchema(
      {
        action: 'exec',
        edits: [{ oldString: 'a', newString: 'b', replaceAll: 'true', extra: 1 }],
      },
      toolSchema,
      true,
    );
    expect(result.valid).toBe(true);
    const edits = result.args.edits as Array<Record<string, unknown>>;
    expect(edits[0].replaceAll).toBe(true);
    expect('extra' in edits[0]).toBe(false);
  });

  test('嵌套 required 缺失按完整路径报错', () => {
    const result = validateAndFixSchema(
      { action: 'exec', edits: [{ oldString: 'a' }] },
      toolSchema,
      true,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('edits[0].newString'))).toBe(true);
  });

  test('无法唯一判定的 enum 不猜测，仍报错', () => {
    const schema = {
      type: 'object',
      properties: { action: { type: 'string', enum: ['abcd', 'abce'] } },
      required: ['action'],
    };
    const result = validateAndFixSchema({ action: 'abcX' }, schema, true);
    expect(result.valid).toBe(false);
    expect(result.args.action).toBe('abcX');
  });

  test('关闭修正时 enum 直接报错', () => {
    const result = validateAndFixSchema({ action: 'execute' }, toolSchema, false);
    expect(result.valid).toBe(false);
    expect(result.args.action).toBe('execute');
  });
});
