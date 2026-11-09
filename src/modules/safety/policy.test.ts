// src/modules/safety/policy.test.ts
// 权限决策矩阵：完全访问仍受规则约束、自动审查动作、项目级规则优先级。

import { describe, it, expect } from 'bun:test';
import { evaluate, type PolicyEnv } from './policy';
import type { SafetyRequest } from './types';

const BASE_ENV: PolicyEnv = {
  blockDangerousCommands: true,
  cautionPolicy: 'ask',
  protectedPaths: ['~/.ssh'],
  home: '/home/tester',
  systemRoot: '/',
  configDir: '/home/tester/.moss/config',
  dataDir: '/home/tester/.moss',
};

function req(overrides: Partial<SafetyRequest>): SafetyRequest {
  return {
    toolName: 'read',
    params: {},
    mode: 'ask',
    sessionId: 'session-1',
    cwd: '/work/project',
    enabled: true,
    ...overrides,
  };
}

describe('evaluate: 完全访问（skip）仍受规则约束', () => {
  it('deny 规则在 skip 下仍然拒绝', () => {
    const decision = evaluate(
      req({ toolName: 'terminal', params: { command: 'npm publish' }, mode: 'skip' }),
      { ...BASE_ENV, globalRules: { allow: [], deny: ['terminal(npm publish)'], ask: [] } },
    );
    expect(decision.action).toBe('deny');
    expect(decision.reason.type).toBe('rule');
  });

  it('ask 规则在 skip 下仍然询问', () => {
    const decision = evaluate(
      req({ toolName: 'write', params: { path: '/work/project/a.txt' }, mode: 'skip' }),
      { ...BASE_ENV, globalRules: { allow: [], deny: [], ask: ['write'] } },
    );
    expect(decision.action).toBe('ask');
  });

  it('BLOCK 级危险命令在 skip 下仍然拒绝', () => {
    const decision = evaluate(
      req({ toolName: 'terminal', params: { command: 'format c:' }, mode: 'skip' }),
      BASE_ENV,
    );
    expect(decision.action).toBe('deny');
    expect(decision.reason.type).toBe('dangerousCommand');
  });

  it('CAUTION 级命令在 skip 下放行', () => {
    const decision = evaluate(
      req({ toolName: 'terminal', params: { command: 'git reset --hard' }, mode: 'skip' }),
      BASE_ENV,
    );
    expect(decision.action).toBe('allow');
  });

  it('用户配置的保护路径在 skip 下放行', () => {
    const decision = evaluate(
      req({ toolName: 'write', params: { path: '/home/tester/.ssh/id_rsa' }, mode: 'skip' }),
      BASE_ENV,
    );
    expect(decision.action).toBe('allow');
  });

  it('~/.moss/config 硬保护在 skip 下仍然拒绝', () => {
    const decision = evaluate(
      req({ toolName: 'write', params: { path: '/home/tester/.moss/config/config.json' }, mode: 'skip' }),
      BASE_ENV,
    );
    expect(decision.action).toBe('deny');
    expect(decision.reason.type).toBe('protectedPath');
  });
});

describe('evaluate: 自动审查（auto）', () => {
  it('只读工具直接放行', () => {
    expect(evaluate(req({ toolName: 'read', mode: 'auto' }), BASE_ENV).action).toBe('allow');
  });

  it('写工具交给审查模型', () => {
    const decision = evaluate(
      req({ toolName: 'write', params: { path: '/work/project/a.txt' }, mode: 'auto' }),
      BASE_ENV,
    );
    expect(decision.action).toBe('review');
    expect(decision.reason.type).toBe('review');
  });

  it('终端命令交给审查模型', () => {
    const decision = evaluate(
      req({ toolName: 'terminal', params: { command: 'npm install' }, mode: 'auto' }),
      BASE_ENV,
    );
    expect(decision.action).toBe('review');
  });

  it('deny 规则优先于审查', () => {
    const decision = evaluate(
      req({ toolName: 'terminal', params: { command: 'npm install' }, mode: 'auto' }),
      { ...BASE_ENV, globalRules: { allow: [], deny: ['terminal(npm install)'], ask: [] } },
    );
    expect(decision.action).toBe('deny');
  });
});

describe('evaluate: 手动审批（ask）', () => {
  it('只读工具直接放行', () => {
    expect(evaluate(req({ toolName: 'read', mode: 'ask' }), BASE_ENV).action).toBe('allow');
  });

  it('写工具需要人工确认', () => {
    const decision = evaluate(
      req({ toolName: 'write', params: { path: '/work/project/a.txt' }, mode: 'ask' }),
      BASE_ENV,
    );
    expect(decision.action).toBe('ask');
  });
});

describe('evaluate: 项目级规则', () => {
  it('项目 allow 规则生效', () => {
    const decision = evaluate(
      req({ toolName: 'write', params: { path: '/work/project/a.txt' }, mode: 'ask' }),
      { ...BASE_ENV, projectRules: { allow: ['write'], deny: [], ask: [] } },
    );
    expect(decision.action).toBe('allow');
    expect(decision.reason.type).toBe('rule');
  });

  it('项目 deny 优先于全局 allow', () => {
    const decision = evaluate(
      req({ toolName: 'terminal', params: { command: 'git status' }, mode: 'ask' }),
      {
        ...BASE_ENV,
        projectRules: { allow: [], deny: ['terminal(git status)'], ask: [] },
        globalRules: { allow: ['terminal(git status)'], deny: [], ask: [] },
      },
    );
    expect(decision.action).toBe('deny');
  });

  it('会话 deny 优先于项目 allow', () => {
    const decision = evaluate(
      req({ toolName: 'terminal', params: { command: 'git status' }, mode: 'ask' }),
      {
        ...BASE_ENV,
        sessionRules: { allow: [], deny: ['terminal(git status)'], ask: [] },
        projectRules: { allow: ['terminal(git status)'], deny: [], ask: [] },
      },
    );
    expect(decision.action).toBe('deny');
  });
});
