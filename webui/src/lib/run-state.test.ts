// webui/src/lib/run-state.test.ts
// 终止集合的簿记约束：刚开始运行的 run 不得被历史终止记录吞掉。
// 这正是「停止/中断发送后立刻发新消息 → 永久停在响应中」的根因所在。

import { describe, expect, test } from 'bun:test';
import { appendTerminatedRunId, isRunTerminated, withoutTerminatedRunId } from './run-state';

describe('withoutTerminatedRunId', () => {
  test('清掉同名 runId，保留其它历史记录', () => {
    expect(withoutTerminatedRunId(['run_old', 'run_new'], 'run_new')).toEqual(['run_old']);
  });

  test('不存在时返回原引用（避免无意义的 store 写入）', () => {
    const list = ['run_old'];
    expect(withoutTerminatedRunId(list, 'run_new')).toBe(list);
    expect(withoutTerminatedRunId(undefined, 'run_new')).toBeUndefined();
  });

  test('清空最后一项后回落 undefined（isRunTerminated 对空集合返回 false）', () => {
    expect(withoutTerminatedRunId(['run_new'], 'run_new')).toBeUndefined();
  });
});

describe('终止集合语义', () => {
  test('append 去重 + FIFO 截断', () => {
    let list: string[] | undefined;
    list = appendTerminatedRunId(list, 'a');
    list = appendTerminatedRunId(list, 'b');
    expect(list).toEqual(['a', 'b']);
    expect(appendTerminatedRunId(list, 'b')).toBe(list);
  });

  test('isRunTerminated 不把空 runId 当作通配', () => {
    expect(isRunTerminated({ s1: ['a'] }, 's1', undefined)).toBe(false);
    expect(isRunTerminated({ s1: ['a'] }, 's1', 'b')).toBe(false);
    expect(isRunTerminated({ s1: ['a'] }, 's1', 'a')).toBe(true);
  });
});
