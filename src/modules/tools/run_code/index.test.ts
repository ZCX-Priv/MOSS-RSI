// src/modules/tools/run_code/index.test.ts
// 命名空间预检：只识别真实代码访问，不被字符串/注释/成员访问误触发。

import { describe, expect, test } from 'bun:test';
import { exceedsNestedDepth, referencesNamespace } from './index';

describe('referencesNamespace', () => {
  test('命中真实命名空间访问', () => {
    expect(referencesNamespace('ui.render(ui.box({}, "x"));', 'ui')).toBe(true);
    expect(referencesNamespace("const node = ui['box'];", 'ui')).toBe(true);
    expect(referencesNamespace('team.run();', 'team')).toBe(true);
  });

  test('字符串 / 注释 / 成员访问不误判', () => {
    expect(referencesNamespace("const s = 'ui.render';", 'ui')).toBe(false);
    expect(referencesNamespace('const t = "team.run";', 'team')).toBe(false);
    expect(referencesNamespace('// ui.render\nconst x = 1;', 'ui')).toBe(false);
    expect(referencesNamespace('/* team.run */ const x = 1;', 'team')).toBe(false);
    expect(referencesNamespace('const x = obj.ui.render;', 'ui')).toBe(false);
  });
});

describe('exceedsNestedDepth', () => {
  test('顶层算第 1 层', () => {
    expect(exceedsNestedDepth(1, 1)).toBe(false);
    expect(exceedsNestedDepth(2, 1)).toBe(true);
  });

  test('0 = 不限制', () => {
    expect(exceedsNestedDepth(1, 0)).toBe(false);
    expect(exceedsNestedDepth(99, 0)).toBe(false);
  });

  test('上限内允许，超过拒绝', () => {
    expect(exceedsNestedDepth(2, 2)).toBe(false);
    expect(exceedsNestedDepth(3, 2)).toBe(true);
    expect(exceedsNestedDepth(32, 32)).toBe(false);
    expect(exceedsNestedDepth(33, 32)).toBe(true);
  });
});
