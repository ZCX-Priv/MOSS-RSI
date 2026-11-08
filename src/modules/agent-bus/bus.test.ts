// src/modules/agent-bus/bus.test.ts
// AgentBus 核心行为：成员树 / 直发 / 频道广播 / 未运行错误 / 收件箱 / 审计快照。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBusImpl } from './bus';
import type { EventBus, Environment, Logger } from '../../core/types';

let dataDir = '';

function makeEnv(dir: string): Environment {
  return { dataDir: dir } as unknown as Environment;
}

function makeLogger(): Logger {
  const noop = (): void => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => makeLogger(),
    getLevel: () => 'info',
  } as unknown as Logger;
}

function makeBus(dir: string): AgentBusImpl {
  const eventBus = { broadcast: async () => {} } as unknown as EventBus;
  return new AgentBusImpl({ env: makeEnv(dir), eventBus, logger: makeLogger() });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'moss-agent-bus-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('AgentBusImpl', () => {
  test('注册主代理与子代理：短 id、root、depth、父引用', () => {
    const bus = makeBus(dataDir);
    const main = bus.register({
      sessionId: 'main-1',
      kind: 'main',
      name: '主智能体',
      task: '根任务',
      cwd: '/tmp',
    });
    expect(main.agentId).toBe('main');
    expect(main.rootSessionId).toBe('main-1');

    const child = bus.register({
      sessionId: 'sub-1',
      kind: 'subagent',
      template: 'agent_coder',
      name: 'Coder',
      task: '写代码',
      cwd: '/tmp',
      parentSessionId: 'main-1',
      parentToolCallId: 'call-1',
      depth: 1,
    });
    expect(child.agentId).toBe('a1');
    expect(child.rootSessionId).toBe('main-1');
    expect(child.parentAgentId).toBe('main');
    expect(child.depth).toBe(1);
    expect(bus.getByParentToolCall('call-1')?.sessionId).toBe('sub-1');

    const grandchild = bus.register({
      sessionId: 'sub-2',
      kind: 'subagent',
      name: 'Reviewer',
      task: '审查',
      cwd: '/tmp',
      parentSessionId: 'sub-1',
      depth: 2,
    });
    expect(grandchild.agentId).toBe('a2');
    expect(grandchild.rootSessionId).toBe('main-1');
    expect(bus.list('main-1').map((m) => m.agentId)).toEqual(['main', 'a1', 'a2']);
  });

  test('直发消息：收件箱投递 + drain 标记已投递', () => {
    const bus = makeBus(dataDir);
    bus.register({ sessionId: 'main-1', kind: 'main', name: '主智能体', task: '根', cwd: '/tmp' });
    bus.register({
      sessionId: 'sub-1',
      kind: 'subagent',
      name: 'Coder',
      task: '写代码',
      cwd: '/tmp',
      parentSessionId: 'main-1',
    });

    const result = bus.send({ fromSessionId: 'main-1', to: 'a1', content: '先读 README' });
    expect(result.delivered).toBe(1);
    expect(result.recipients[0]?.sessionId).toBe('sub-1');

    const drained = bus.drainInbox('sub-1');
    expect(drained).toHaveLength(1);
    expect(drained[0]?.content).toBe('先读 README');
    expect(drained[0]?.delivered).toBe(true);
    expect(bus.drainInbox('sub-1')).toHaveLength(0);
  });

  test('频道广播：同 root 运行中成员收到，发送者与已完成成员排除', () => {
    const bus = makeBus(dataDir);
    bus.register({ sessionId: 'main-1', kind: 'main', name: '主智能体', task: '根', cwd: '/tmp' });
    bus.register({
      sessionId: 'sub-1',
      kind: 'subagent',
      name: 'Coder',
      task: '写代码',
      cwd: '/tmp',
      parentSessionId: 'main-1',
    });
    bus.register({
      sessionId: 'sub-2',
      kind: 'subagent',
      name: 'Reviewer',
      task: '审查',
      cwd: '/tmp',
      parentSessionId: 'main-1',
    });
    bus.update('sub-2', { status: 'completed' });

    const result = bus.send({ fromSessionId: 'sub-1', to: 'all', content: '我已完成 A' });
    expect(result.delivered).toBe(1);
    expect(result.recipients[0]?.sessionId).toBe('main-1');
    expect(bus.drainInbox('main-1')).toHaveLength(1);
    expect(bus.drainInbox('sub-2')).toHaveLength(0);
  });

  test('chat 到已完成目标报错；result 可投递已完成父代理', () => {
    const bus = makeBus(dataDir);
    bus.register({ sessionId: 'main-1', kind: 'main', name: '主智能体', task: '根', cwd: '/tmp' });
    bus.register({
      sessionId: 'sub-1',
      kind: 'subagent',
      name: 'Coder',
      task: '写代码',
      cwd: '/tmp',
      parentSessionId: 'main-1',
    });
    bus.update('sub-1', { status: 'completed' });
    bus.update('main-1', { status: 'completed' });

    const chat = bus.send({ fromSessionId: 'main-1', to: 'a1', content: '还在吗' });
    expect(chat.delivered).toBe(0);
    expect(chat.error).toContain('未在运行');

    const receipt = bus.send({
      fromSessionId: 'sub-1',
      to: 'parent',
      content: '完成报告',
      kind: 'result',
    });
    expect(receipt.delivered).toBe(1);
    expect(bus.drainInbox('main-1')[0]?.kind).toBe('result');
  });

  test('子代理完成后清空收件箱；主代理保留', () => {
    const bus = makeBus(dataDir);
    bus.register({ sessionId: 'main-1', kind: 'main', name: '主智能体', task: '根', cwd: '/tmp' });
    bus.register({
      sessionId: 'sub-1',
      kind: 'subagent',
      name: 'Coder',
      task: '写代码',
      cwd: '/tmp',
      parentSessionId: 'main-1',
    });
    bus.send({ fromSessionId: 'main-1', to: 'a1', content: '消息' });
    bus.update('sub-1', { status: 'completed' });
    expect(bus.drainInbox('sub-1')).toHaveLength(0);

    bus.send({ fromSessionId: 'sub-1', to: 'parent', content: '报告', kind: 'result' });
    bus.update('main-1', { status: 'completed' });
    expect(bus.drainInbox('main-1')).toHaveLength(1);
  });

  test('跨任务树直发被拒绝（同 agentId/sessionId 也不能串话）', () => {
    const bus = makeBus(dataDir);
    bus.register({ sessionId: 'main-1', kind: 'main', name: '主智能体', task: '根1', cwd: '/tmp' });
    bus.register({
      sessionId: 'sub-1',
      kind: 'subagent',
      name: 'Coder',
      task: '写代码',
      cwd: '/tmp',
      parentSessionId: 'main-1',
    });
    bus.register({ sessionId: 'main-2', kind: 'main', name: '主智能体', task: '根2', cwd: '/tmp' });
    bus.register({
      sessionId: 'sub-2',
      kind: 'subagent',
      name: 'Coder',
      task: '写代码',
      cwd: '/tmp',
      parentSessionId: 'main-2',
    });

    const bySession = bus.send({ fromSessionId: 'sub-1', to: 'sub-2', content: '越界' });
    expect(bySession.delivered).toBe(0);
    expect(bySession.error).toContain('未找到目标智能体');
    const byAgentId = bus.send({ fromSessionId: 'sub-1', to: 'a1', content: '越界' });
    expect(byAgentId.delivered).toBe(0);
  });

  test('审计落盘：新实例 snapshot 能读到历史消息', () => {
    const bus = makeBus(dataDir);
    bus.register({ sessionId: 'main-1', kind: 'main', name: '主智能体', task: '根', cwd: '/tmp' });
    bus.register({
      sessionId: 'sub-1',
      kind: 'subagent',
      name: 'Coder',
      task: '写代码',
      cwd: '/tmp',
      parentSessionId: 'main-1',
    });
    bus.send({ fromSessionId: 'main-1', to: 'all', content: '频道消息' });

    const reopened = makeBus(dataDir);
    const snapshot = reopened.snapshot('main-1');
    expect(snapshot.messages.some((m) => m.content === '频道消息')).toBe(true);
  });
});
