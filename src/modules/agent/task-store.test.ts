// task-store 测试 —— 前端预分配会话 id（乐观导航）的关键行为：
//   1. 传入 id 时沿用该 id 作为 task.id 与 sessionId（task.id 即 sessionId）
//   2. 传入的 id 已被占用时回退随机 UUID，绝不覆盖已有任务
//   3. 未传 id 时生成随机 UUID（原有行为不变）

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, Environment } from '../../core/types';
import { TaskStore } from './task-store';

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
  setLevel: () => {},
  getLevel: () => 'info',
};

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'moss-task-store-test-'));
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄延迟释放
  }
});

function makeStore(): TaskStore {
  return new TaskStore({ dataDir } as Environment, logger);
}

describe('TaskStore.createTask（前端预分配 id）', () => {
  it('传入 id 时沿用该 id 作为 task.id 与 sessionId', () => {
    const store = makeStore();
    const task = store.createTask('标题', undefined, 'fixed-id-1');
    expect(task.id).toBe('fixed-id-1');
    expect(task.sessionId).toBe('fixed-id-1');
    expect(store.getTask('fixed-id-1')?.id).toBe('fixed-id-1');
  });

  it('传入的 id 已被占用时回退随机 UUID（不覆盖已有任务）', () => {
    const store = makeStore();
    const first = store.createTask('第一个', undefined, 'dup-id');
    const second = store.createTask('第二个', undefined, 'dup-id');
    expect(second.id).not.toBe('dup-id');
    expect(second.id).not.toBe(first.id);
    // 原任务保持不变
    expect(store.getTask('dup-id')?.title).toBe('第一个');
  });

  it('未传 id 时生成随机 UUID（原有行为不变）', () => {
    const store = makeStore();
    const task = store.createTask('无 id');
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.sessionId).toBe(task.id);
  });
});

describe('TaskStore.listGroupTasks（分组内查询 / 分页）', () => {
  it('仅返回指定分组的任务，并按组内 order asc 排序（不混入他组）', () => {
    const store = makeStore();
    const a = store.createGroup('A', 'manual');
    const b = store.createGroup('B', 'manual');
    const a1 = store.createTask('A1', a.id, 'a1'); // order 0
    const a2 = store.createTask('A2', a.id, 'a2'); // order -1
    const a3 = store.createTask('A3', a.id, 'a3'); // order -2
    store.createTask('B1', b.id, 'b1');

    const { tasks, total } = store.listGroupTasks(a.id);
    expect(total).toBe(3);
    expect(tasks.map((t) => t.id)).toEqual([a3.id, a2.id, a1.id]);
    expect(tasks.every((t) => t.groupId === a.id)).toBe(true);
  });

  it('limit/offset 切片且 total 为分组任务总数', () => {
    const store = makeStore();
    const g = store.createGroup('G', 'manual');
    const ids = ['g1', 'g2', 'g3'].map((id, i) => store.createTask(`T${i}`, g.id, id).id);
    // orders：g1=0、g2=-1、g3=-2 → 组内排序后为 [g3, g2, g1]
    const first = store.listGroupTasks(g.id, { limit: 2 });
    expect(first.tasks.map((t) => t.id)).toEqual([ids[2], ids[1]]);
    expect(first.total).toBe(3);

    const second = store.listGroupTasks(g.id, { limit: 2, offset: 2 });
    expect(second.tasks.map((t) => t.id)).toEqual([ids[0]]);
    expect(second.total).toBe(3);
  });

  it('未知分组返回空列表', () => {
    const store = makeStore();
    const { tasks, total } = store.listGroupTasks('no-such-group');
    expect(tasks).toEqual([]);
    expect(total).toBe(0);
  });
});
