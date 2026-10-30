// src/modules/im/im.test.ts
// IM 模块核心链路单测：文本处理、状态存储、网关准入/命令/执行、OneBot 反向 WS 收发。
// 使用假的 agent engine 与 server，不依赖真实模型与网络。

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine, AgentEvent } from '../contracts';
import type { ServerInstance } from '../server/types';
import { getSessionTodoPathFromDir, writeSessionTodoStore } from '../tools/todo/shared/store';
import type { AskOutcome, AskQuestion } from '../tools/types';
import { createAdapter, descriptor } from './adapters/onebot';
import { descriptor as wechatDescriptor } from './adapters/wechat-ilink';
import { ImGateway } from './gateway';
import { parseChoice, renderTodoList, todoSignature } from './interaction';
import { prepareOutbound, splitText, toPlainText } from './render';
import { ImStateStore } from './state';
import { ImBotStore } from './store';
import type { ImInboundMessage, ImReplyTarget, ImRuntimeStatus, StoredImBot } from './types';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moss-im-test-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
    setLevel: noop,
    getLevel: () => 'error',
  };
  return logger;
}

class FakeAgent {
  readonly tasks: Array<{ id: string; title: string; groupId: string; createdAt: string; updatedAt: string }> = [];
  readonly groups = new Map<string, { id: string; name: string }>();
  readonly runs: Array<{
    sessionId: string;
    userMessage: string;
    permissionMode?: string;
    attachments?: string[];
  }> = [];
  headless: Array<{ sessionId: string; value: boolean }> = [];
  /** 为 true 时 run 挂起，用于并发忙测试 */
  hold = false;
  private release: (() => void) | null = null;
  finalText = '任务完成';
  /** run 期间注入的事件 */
  injectAsk: AskQuestion[] | null = null;
  injectConfirm: { toolName: string; question: string } | null = null;
  onRun?: (sessionId: string) => void;
  lastOnEvent: ((event: AgentEvent) => void) | null = null;
  /** 模拟 ask/confirm 阻塞等待用户回答 */
  askHold = false;
  confirmHold = false;
  private askRelease: (() => void) | null = null;
  private confirmRelease: (() => void) | null = null;
  readonly resolvedAsks: Array<{ sessionId: string; toolCallId: string; outcome: AskOutcome }> = [];
  readonly resolvedConfirms: Array<{
    sessionId: string;
    toolCallId: string;
    ok: boolean;
    remember?: 'session' | 'global';
  }> = [];

  createTask(title: string, groupId?: string, id?: string) {
    const taskId = id ?? `task-${this.tasks.length + 1}`;
    const task = {
      id: taskId,
      title,
      groupId: groupId ?? 'default',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionId: taskId,
    };
    this.tasks.push(task);
    return task;
  }

  createTaskGroup(name: string) {
    const existing = [...this.groups.values()].find(group => group.name === name);
    if (existing) return existing;
    const group = { id: `group-${this.groups.size + 1}`, name };
    this.groups.set(group.id, group);
    return group;
  }

  listTaskGroups() {
    return [...this.groups.values()];
  }

  markSessionHeadless(sessionId: string, value: boolean): void {
    this.headless.push({ sessionId, value });
  }

  async run(input: {
    sessionId: string;
    userMessage: string;
    permissionMode?: string;
    attachments?: string[];
    onEvent?: (event: AgentEvent) => void;
  }) {
    this.runs.push({
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      permissionMode: input.permissionMode,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
    input.onEvent?.({ type: 'assistant-text', sessionId: input.sessionId, text: 'partial' });
    this.lastOnEvent = input.onEvent ?? null;
    this.onRun?.(input.sessionId);
    if (this.injectAsk) {
      input.onEvent?.({ type: 'ask', sessionId: input.sessionId, toolCallId: 'tc-ask', questions: this.injectAsk });
      if (this.askHold) {
        await new Promise<void>(resolve => {
          this.askRelease = resolve;
        });
      }
    }
    if (this.injectConfirm) {
      input.onEvent?.({
        type: 'confirm-required',
        sessionId: input.sessionId,
        toolCallId: 'tc-confirm',
        toolName: this.injectConfirm.toolName,
        question: this.injectConfirm.question,
      });
      if (this.confirmHold) {
        await new Promise<void>(resolve => {
          this.confirmRelease = resolve;
        });
      }
    }
    if (this.hold) {
      await new Promise<void>(resolve => {
        this.release = resolve;
      });
    }
    return {
      sessionId: input.sessionId,
      finishReason: 'stop' as const,
      finalText: this.finalText,
      history: [],
    };
  }

  resume(): void {
    this.release?.();
    this.release = null;
  }

  resolveAsk(sessionId: string, toolCallId: string, outcome: AskOutcome): boolean {
    this.resolvedAsks.push({ sessionId, toolCallId, outcome });
    this.askRelease?.();
    this.askRelease = null;
    return true;
  }

  resolveConfirm(
    sessionId: string,
    toolCallId: string,
    ok: boolean,
    remember?: 'session' | 'global',
  ): boolean {
    this.resolvedConfirms.push({ sessionId, toolCallId, ok, ...(remember ? { remember } : {}) });
    this.confirmRelease?.();
    this.confirmRelease = null;
    return true;
  }
}

function fakeRegistry(agent: FakeAgent, config: { workingDirectory: string }): ServiceRegistry {
  const services = new Map<string, unknown>([
    [ServiceNames.AGENT_ENGINE, agent],
    [ServiceNames.CONFIG_SERVICE, { getAppConfig: () => ({ agent: config }) }],
  ]);
  return {
    register: () => undefined,
    resolve: <T>(name: string): T => services.get(name) as T,
    tryResolve: <T>(name: string): T | null => (services.get(name) as T | undefined) ?? null,
    has: (name: string) => services.has(name),
    unregister: () => undefined,
    unregisterScope: () => undefined,
    list: () => [...services.keys()],
  };
}

function fakeServer(): ServerInstance & { broadcasts: unknown[]; agentEvents: unknown[] } {
  const broadcasts: unknown[] = [];
  const agentEvents: unknown[] = [];
  const server = {
    raw: null,
    host: '127.0.0.1',
    port: 0,
    baseUrl: '',
    addRoute: () => undefined,
    broadcastWS: (message: unknown) => {
      broadcasts.push(message);
    },
    sendToSession: () => undefined,
    sendAgentEvent: (_sid: string, event: AgentEvent) => {
      agentEvents.push(event);
    },
    registerExternalRun: () => undefined,
    unregisterExternalRun: () => undefined,
    isSessionRunning: () => false,
    onWSMessage: () => undefined,
    setRequestGuard: () => undefined,
    rebind: async () => undefined,
    stop: async () => undefined,
  } as unknown as ServerInstance;
  return Object.assign(server, { broadcasts, agentEvents });
}

async function makeBot(): Promise<{ store: ImBotStore; state: ImStateStore; bot: StoredImBot }> {
  const dir = tempDir();
  const logger = fakeLogger();
  const store = new ImBotStore(dir, logger);
  const state = new ImStateStore(dir, logger);
  await store.load();
  await state.load();
  const bot = await store.save({
    botId: 'ob_test',
    channel: 'qq-onebot',
    name: '测试机器人',
    platformId: 'onebot:16199',
    credentials: { port: '16199', accessToken: '' },
    enabled: true,
    pairingCode: '123456',
    options: { cwd: '', permissionMode: 'auto', groupTrigger: 'mention' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { store, state, bot };
}

function inbound(overrides: Partial<ImInboundMessage> = {}): ImInboundMessage {
  return {
    botId: 'ob_test',
    channel: 'qq-onebot',
    messageId: `m-${Math.random()}`,
    conversationKey: 'direct:10001',
    kind: 'direct',
    senderId: '10001',
    senderName: '测试用户',
    segments: [{ type: 'text', text: '你好' }],
    text: '你好',
    addressed: true,
    replyTarget: { channel: 'qq-onebot', kind: 'direct', userId: '10001' },
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('render', () => {
  test('toPlainText 去掉 markdown 标记并保留内容', () => {
    const text = toPlainText('# 标题\n\n**加粗** 和 [链接](https://a.com)\n\n```js\ncode\n```');
    expect(text).toContain('标题');
    expect(text).toContain('加粗');
    expect(text).toContain('链接 (https://a.com)');
    expect(text).toContain('code');
    expect(text).not.toContain('**');
  });

  test('splitText 按上限切分且不丢内容', () => {
    const source = `${'A'.repeat(120)}\n\n${'B'.repeat(120)}`;
    const chunks = splitText(source, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('A'.repeat(50));
    expect(chunks.join('')).toContain('B'.repeat(50));
  });

  test('prepareOutbound 按渠道上限分段', () => {
    const chunks = prepareOutbound('qq-official', 'x'.repeat(5000), false);
    expect(chunks.every(chunk => chunk.length <= 2000)).toBe(true);
  });
});

describe('state/store', () => {
  test('绑定、去重、会话映射与清理', async () => {
    const { state } = await makeBot();
    expect(state.isBound('ob_test', '10001')).toBe(false);
    state.bind('ob_test', { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    expect(state.isBound('ob_test', '10001')).toBe(true);

    expect(state.hasSeen('ob_test', 'm1')).toBe(false);
    state.markSeen('ob_test', 'm1');
    expect(state.hasSeen('ob_test', 'm1')).toBe(true);

    state.setConversation('ob_test:direct:10001', {
      taskId: 't1',
      sessionId: 't1',
      title: 'x',
      updatedAt: new Date().toISOString(),
    });
    expect(state.getConversation('ob_test:direct:10001')?.taskId).toBe('t1');

    state.clearBot('ob_test');
    expect(state.isBound('ob_test', '10001')).toBe(false);
    expect(state.getConversation('ob_test:direct:10001')).toBeNull();
  });
});

describe('gateway', () => {
  test('未绑定提示 → 配对码绑定 → 执行并回复最终答案', async () => {
    const { state, bot } = await makeBot();
    const agent = new FakeAgent();
    const server = fakeServer();
    const replies: Array<{ target: ImReplyTarget; text: string }> = [];
    const gateway = new ImGateway({
      logger: fakeLogger(),
      services: fakeRegistry(agent, { workingDirectory: '' }),
      state,
      server,
      dataDir: tempDir(),
      supportsMarkdown: () => false,
      channelLabel: () => 'QQ用户模式',
      sendText: async (_bot, target, text) => {
        replies.push({ target, text });
      },
      getBot: botId => (botId === bot.botId ? bot : null),
      updateBotOptions: async () => undefined,
    });

    gateway.handle(bot, inbound({ text: '你好' }));
    await Bun.sleep(10);
    expect(replies[0]?.text).toContain('尚未绑定');

    gateway.handle(bot, inbound({ text: '/bind 123456' }));
    await Bun.sleep(10);
    expect(state.isBound(bot.botId, '10001')).toBe(true);
    expect(replies[1]?.text).toContain('绑定成功');

    gateway.handle(bot, inbound({ text: '帮我写个文件' }));
    await Bun.sleep(50);
    const ack = replies.find(item => item.text.includes('收到，正在处理'));
    expect(ack).toBeDefined();
    expect(agent.runs.length).toBe(1);
    expect(agent.runs[0]?.userMessage).toBe('帮我写个文件');
    expect(agent.runs[0]?.permissionMode).toBe('auto');
    const final = replies.find(item => item.text.includes('任务完成'));
    expect(final).toBeDefined();
    expect(server.broadcasts.some(item => (item as { type?: string }).type === 'task.created')).toBe(true);
    expect(server.agentEvents.length).toBeGreaterThan(0);
    // IM 会话有人交互：不再标记 headless（否则 ask/confirm 会快速失败）
    expect(agent.headless.length).toBe(0);
  });

  test('图片/文件附件落盘并注入 agent', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    const gateway = new ImGateway({
      logger: fakeLogger(),
      services: fakeRegistry(agent, { workingDirectory: '' }),
      state,
      server: fakeServer(),
      dataDir: tempDir(),
      supportsMarkdown: () => false,
      channelLabel: () => 'QQ用户模式',
      sendText: async () => undefined,
      getBot: botId => (botId === bot.botId ? bot : null),
      updateBotOptions: async () => undefined,
    });

    gateway.handle(
      bot,
      inbound({
        text: '看附件',
        segments: [
          { type: 'text', text: '看附件' },
          { type: 'image', media: { kind: 'image', name: 'a.png', load: async () => Buffer.from('png') } },
          {
            type: 'file',
            name: 'b.pdf',
            media: { kind: 'file', name: 'b.pdf', load: async () => Buffer.from('pdf') },
          },
        ],
      }),
    );
    await Bun.sleep(100);

    expect(agent.runs.length).toBe(1);
    expect(agent.runs[0]?.attachments?.length).toBe(1);
    expect(existsSync(agent.runs[0]!.attachments![0]!)).toBe(true);
    expect(agent.runs[0]?.userMessage).toContain('[IM 附件 · qq-onebot]');
    expect(agent.runs[0]?.userMessage).toContain('b.pdf');
  });

  test('/new 清空会话映射；并发消息回忙提示', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    agent.hold = true;
    const replies: string[] = [];
    const gateway = new ImGateway({
      logger: fakeLogger(),
      services: fakeRegistry(agent, { workingDirectory: '' }),
      state,
      server: fakeServer(),
      dataDir: tempDir(),
      supportsMarkdown: () => false,
      channelLabel: () => 'QQ用户模式',
      sendText: async (_bot, _target, text) => {
        replies.push(text);
      },
      getBot: botId => (botId === bot.botId ? bot : null),
      updateBotOptions: async () => undefined,
    });

    gateway.handle(bot, inbound({ text: '第一条' }));
    await Bun.sleep(30);
    gateway.handle(bot, inbound({ text: '第二条' }));
    await Bun.sleep(20);
    expect(replies.some(text => text.includes('还在处理中'))).toBe(true);
    expect(state.getConversation(`${bot.botId}:direct:10001`)).not.toBeNull();

    agent.resume();
    await Bun.sleep(50);
    gateway.handle(bot, inbound({ text: '/new' }));
    await Bun.sleep(20);
    expect(state.getConversation(`${bot.botId}:direct:10001`)).toBeNull();
    expect(replies.some(text => text.includes('已开启新会话'))).toBe(true);
  });

  test('群聊未 @ 机器人时不执行', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    const gateway = new ImGateway({
      logger: fakeLogger(),
      services: fakeRegistry(agent, { workingDirectory: '' }),
      state,
      server: fakeServer(),
      dataDir: tempDir(),
      supportsMarkdown: () => false,
      channelLabel: () => 'QQ用户模式',
      sendText: async () => undefined,
      getBot: botId => (botId === bot.botId ? bot : null),
      updateBotOptions: async () => undefined,
    });
    gateway.handle(
      bot,
      inbound({ kind: 'group', conversationKey: 'group:90001', addressed: false, replyTarget: {
        channel: 'qq-onebot',
        kind: 'group',
        groupId: '90001',
      } }),
    );
    await Bun.sleep(20);
    expect(agent.runs.length).toBe(0);
  });
});

describe('wechat descriptor', () => {
  test('支持手动添加：必填校验与平台身份', async () => {
    expect(wechatDescriptor.capabilities.qrLogin).toBe(true);
    expect(wechatDescriptor.capabilities.qrOnly).toBeUndefined();
    await expect(wechatDescriptor.verify({})).rejects.toThrow('Bot Token 与 Bot ID 必填');
    const identity = await wechatDescriptor.verify({ botToken: 'token', botId: 'bot-1' });
    expect(identity.platformId).toBe('bot-1');
    expect(identity.name).toBe('MOSS');
  });
});

describe('retired channel cleanup', () => {
  test('启动时移除飞书/钉钉机器人并写回文件', async () => {
    const dir = tempDir();
    const file = join(dir, 'im', 'bots.json');
    mkdirSync(join(dir, 'im'), { recursive: true });
    const base = {
      name: 'MOSS',
      credentials: {},
      enabled: true,
      pairingCode: '123456',
      options: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        bots: [
          { ...base, botId: 'fs_retired', channel: 'feishu', platformId: 'cli_retired' },
          { ...base, botId: 'dt_retired', channel: 'dingtalk', platformId: 'ding_retired' },
          { ...base, botId: 'wx_kept', channel: 'wechat-ilink', platformId: 'bot-kept' },
        ],
      }),
      'utf8',
    );

    const store = new ImBotStore(dir, fakeLogger());
    await store.load();

    expect(store.list().map(bot => bot.botId)).toEqual(['wx_kept']);
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { bots: Array<{ channel: string }> };
    expect(persisted.bots).toHaveLength(1);
    expect(persisted.bots[0]?.channel).toBe('wechat-ilink');
  });
});

describe('interaction', () => {
  test('parseChoice 单选/多选/取消/越界', () => {
    expect(parseChoice('2', 3, 'single')).toEqual([2]);
    expect(parseChoice('1,3', 3, 'multi')).toEqual([1, 3]);
    expect(parseChoice('0', 3, 'single')).toBe('cancel');
    expect(parseChoice('取消', 3, 'single')).toBe('cancel');
    expect(parseChoice('9', 3, 'single')).toBeNull();
    expect(parseChoice('abc', 3, 'single')).toBeNull();
  });

  test('renderTodoList / todoSignature', () => {
    const items = [
      { id: '1', text: '写代码', status: 'in_progress' as const, priority: 'high' as const, createdAt: '', updatedAt: '' },
      { id: '2', text: '跑测试', status: 'completed' as const, priority: 'medium' as const, createdAt: '', updatedAt: '' },
    ];
    expect(renderTodoList(items)).toContain('任务清单');
    expect(renderTodoList(items)).toContain('[进行中] 写代码');
    expect(todoSignature(items)).toBe('1:in_progress|2:completed');
    expect(renderTodoList([])).toBe('');
  });
});

describe('gateway interaction', () => {
  function buildGateway(
    agent: FakeAgent,
    state: ImStateStore,
    dataDir: string,
    replies: string[],
    getBot: (botId: string) => StoredImBot | null,
    updateBotOptions: (botId: string, patch: Partial<StoredImBot['options']>) => Promise<unknown>,
  ): ImGateway {
    return new ImGateway({
      logger: fakeLogger(),
      services: fakeRegistry(agent, { workingDirectory: '' }),
      state,
      server: fakeServer(),
      dataDir,
      supportsMarkdown: () => false,
      channelLabel: () => 'QQ用户模式',
      sendText: async (_bot, _target, text) => {
        replies.push(text);
      },
      getBot,
      updateBotOptions,
    });
  }

  test('首次任务先询问权限，回复 1 后以 auto 执行', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    let current: StoredImBot = { ...bot, options: { ...bot.options, permissionMode: 'unset' } };
    const agent = new FakeAgent();
    const replies: string[] = [];
    const gateway = buildGateway(
      agent,
      state,
      tempDir(),
      replies,
      botId => (botId === current.botId ? current : null),
      async (_botId, patch) => {
        current = { ...current, options: { ...current.options, ...patch } };
      },
    );

    gateway.handle(current, inbound({ text: '帮我写个文件' }));
    await Bun.sleep(20);
    expect(replies.some(text => text.includes('请选择 MOSS 的执行权限'))).toBe(true);
    expect(agent.runs.length).toBe(0);

    gateway.handle(current, inbound({ text: '1' }));
    await Bun.sleep(60);
    expect(agent.runs.length).toBe(1);
    expect(agent.runs[0]?.permissionMode).toBe('auto');
  });

  test('ask 事件转数字菜单，回复数字后 resolveAsk', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    agent.askHold = true;
    agent.injectAsk = [
      {
        id: 'q0',
        question: '选择数据库',
        answerType: 'single',
        options: [
          { value: 'mysql', label: 'MySQL' },
          { value: 'pg', label: 'PostgreSQL' },
        ],
      },
    ];
    const replies: string[] = [];
    const gateway = buildGateway(agent, state, tempDir(), replies, () => bot, async () => undefined);

    gateway.handle(bot, inbound({ text: '开始' }));
    await Bun.sleep(40);
    expect(replies.some(text => text.includes('选择数据库'))).toBe(true);

    gateway.handle(bot, inbound({ text: '2' }));
    await Bun.sleep(30);
    expect(agent.resolvedAsks.length).toBe(1);
    expect(agent.resolvedAsks[0]?.outcome.action).toBe('accept');
    expect(agent.resolvedAsks[0]?.outcome.answers?.[0]?.selectedValues).toEqual(['pg']);
  });

  test('confirm 事件用 1/2/3 回复，resolveConfirm 支持会话级放行', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    agent.confirmHold = true;
    agent.injectConfirm = { toolName: 'write', question: '写入文件？' };
    const replies: string[] = [];
    const gateway = buildGateway(agent, state, tempDir(), replies, () => bot, async () => undefined);

    gateway.handle(bot, inbound({ text: '开始' }));
    await Bun.sleep(40);
    expect(replies.some(text => text.includes('需要确认'))).toBe(true);

    gateway.handle(bot, inbound({ text: '3' }));
    await Bun.sleep(30);
    expect(agent.resolvedConfirms[0]?.ok).toBe(true);
    expect(agent.resolvedConfirms[0]?.remember).toBe('session');
  });

  test('todo 工具结束后推送任务清单', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const dataDir = tempDir();
    const agent = new FakeAgent();
    const replies: string[] = [];
    agent.onRun = sessionId => {
      writeSessionTodoStore(getSessionTodoPathFromDir(dataDir, sessionId), {
        nextId: 2,
        items: [
          {
            id: '1',
            text: '写代码',
            status: 'in_progress',
            priority: 'high',
            createdAt: '',
            updatedAt: '',
          },
        ],
      });
      agent.lastOnEvent?.({
        type: 'tool-call-end',
        sessionId,
        toolName: 'todo',
        toolCallId: 'tc-todo',
        result: { content: [] },
      });
    };
    const gateway = buildGateway(agent, state, dataDir, replies, () => bot, async () => undefined);

    gateway.handle(bot, inbound({ text: '开始' }));
    await Bun.sleep(60);
    expect(replies.some(text => text.includes('任务清单') && text.includes('写代码'))).toBe(true);
  });
});

describe('qq-onebot adapter', () => {
  test('反向 WS 收事件并按 OneBot 动作回复', async () => {
    const { bot } = await makeBot();
    const messages: ImInboundMessage[] = [];
    const statuses: Array<Record<string, unknown>> = [];
    const adapter = createAdapter({
      bot,
      logger: fakeLogger(),
      signal: new AbortController().signal,
      onMessage: (message: ImInboundMessage) => messages.push(message),
      onStatus: (patch: Partial<ImRuntimeStatus>) => statuses.push(patch as Record<string, unknown>),
    });

    await adapter.start();
    const ws = new WebSocket('ws://127.0.0.1:16199/onebot/v11/ws');
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });

    const received: Array<Record<string, unknown>> = [];
    ws.addEventListener('message', event => {
      received.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      const payload = JSON.parse(String(event.data)) as { echo?: string };
      if (payload.echo) {
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: null, echo: payload.echo }));
      }
    });

    // 生命周期事件：记录 self_id
    ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: 10000 }));
    await Bun.sleep(20);
    expect(statuses.some(item => item.connected === true)).toBe(true);

    // 群消息：@机器人 → addressed
    ws.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        message_id: 1,
        self_id: 10000,
        group_id: 90001,
        user_id: 10001,
        sender: { nickname: '测试用户' },
        message: [
          { type: 'at', data: { qq: '10000' } },
          { type: 'text', data: { text: ' 你好' } },
        ],
        raw_message: '[CQ:at,qq=10000] 你好',
      }),
    );
    await Bun.sleep(30);
    expect(messages.length).toBe(1);
    expect(messages[0]?.addressed).toBe(true);
    expect(messages[0]?.text).toBe('你好');
    expect(messages[0]?.conversationKey).toBe('group:90001');

    await adapter.sendText({ channel: 'qq-onebot', kind: 'group', groupId: '90001' }, '回复');
    expect(received.some(item => item.action === 'send_group_msg')).toBe(true);

    ws.close();
    await adapter.stop();
    await Bun.sleep(20);
  });
});

describe('descriptor', () => {
  test('OneBot 校验返回模式与反向地址', async () => {
    const identity = await descriptor.verify({ port: '6200' });
    expect(identity.platformId).toBe('onebot:reverse:6200');
    expect(identity.extra?.wsUrl).toBe('ws://127.0.0.1:6200/onebot/v11/ws');
  });
});
