// src/modules/context/compiler/system-prompt.test.ts
// 回归：getSystemSections 不得往 mtime 缓存数组里追加动态段。
// 旧实现每轮请求 push 一份「代码模式 (PTC)」，长会话面板会出现十几条重复段。

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEnvironment } from '../../../core/env';
import type { Environment } from '../../../core/types';
import { getSystemSections } from './system-prompt';

const dir = mkdtempSync(join(tmpdir(), 'moss-system-prompt-'));
const base = detectEnvironment();
const env: Environment = {
  ...base,
  dataDir: dir,
  configDir: join(dir, 'config'),
  logsDir: join(dir, 'logs'),
  pidFile: join(dir, 'moss.pid'),
};

const extra = {
  id: 'code-mode',
  title: '代码模式 (PTC)',
  content: 'PTC SDK '.repeat(200),
};

describe('getSystemSections 缓存隔离', () => {
  test('连续调用不会重复追加动态段', () => {
    const first = getSystemSections(env, undefined, undefined, null, [extra]);
    const firstCount = first.length;
    expect(first.filter((s) => s.id === extra.id)).toHaveLength(1);

    for (let i = 0; i < 10; i++) {
      const sections = getSystemSections(env, undefined, undefined, null, [extra]);
      expect(sections.length).toBe(firstCount);
      expect(sections.filter((s) => s.id === extra.id)).toHaveLength(1);
    }
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
