import { describe, expect, test } from 'bun:test';
import type { ContextMessage, ContextSessionLike } from './types';
import { ensureSessionRefs, indexOfRef, parseRef, renderRefTag, stripOwnRefTag } from './refs';

function session(messages: ContextMessage[], refCursor?: number): ContextSessionLike {
  return { id: 's', messages, updatedAt: new Date().toISOString(), ...(refCursor ? { refCursor } : {}) };
}

describe('refs', () => {
  test('首次分配 m00001…，重复调用幂等', () => {
    const s = session([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    expect(ensureSessionRefs(s)).toBe(true);
    expect(s.messages.map(m => m.ref)).toEqual(['m00001', 'm00002']);
    expect(s.refCursor).toBe(2);
    expect(ensureSessionRefs(s)).toBe(false);
  });

  test('物理删除后编号不回退（永不复用）', () => {
    const s = session([
      { role: 'user', content: 'a', ref: 'm00005' },
      { role: 'assistant', content: 'b' },
    ], 5);
    ensureSessionRefs(s);
    expect(s.messages[1].ref).toBe('m00006');
    s.messages.splice(0, 1);
    s.messages.push({ role: 'user', content: 'c' });
    ensureSessionRefs(s);
    expect(s.messages[1].ref).toBe('m00007');
  });

  test('恢复旧会话时从已有最大编号继续', () => {
    const s = session([
      { role: 'user', content: 'a', ref: 'm00042' },
      { role: 'assistant', content: 'b' },
    ]);
    ensureSessionRefs(s);
    expect(s.messages[1].ref).toBe('m00043');
  });

  test('标签渲染与自标签剥离', () => {
    const m: ContextMessage = { role: 'tool', name: 'read', content: '内容', ref: 'm00123' };
    const tag = renderRefTag(m);
    expect(tag).toContain('type="tool:read"');
    expect(tag).toContain('>m00123</acp>');
    expect(stripOwnRefTag(`${tag}内容`, 'm00123')).toBe('内容');
    expect(stripOwnRefTag(`${tag}内容`, 'm00124')).not.toBe('内容');
  });

  test('parseRef / indexOfRef', () => {
    expect(parseRef('m00042')).toBe(42);
    expect(parseRef('m42')).toBe(42);
    expect(parseRef('b5')).toBeNull();
    const s = session([{ role: 'user', content: 'a', ref: 'm00001' }]);
    expect(indexOfRef(s, 'M00001')).toBe(0);
    expect(indexOfRef(s, 'm00002')).toBe(-1);
  });
});
