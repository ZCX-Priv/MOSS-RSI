// src/modules/im/im.test.ts
// IM 模块核心链路单测：文本处理、状态存储、网关准入/命令/执行。
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
import { descriptor as qqDescriptor, isQqAuthorizationError } from './adapters/qq-official';
import { descriptor as wechatDescriptor } from './adapters/wechat-ilink';
import { ImController } from './controller';
import { ImGateway } from './gateway';
import { deriveBotId } from './identity';
import { parseChoice, renderTodoList, todoSignature } from './interaction';
import { prepareOutbound, splitText, toPlainText } from './render';
import { ImStateStore } from './state';
import { ImBotStore } from './store';
import type { ImInboundMessage, ImReplyTarget, StoredImBot } from './types';

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
    botId: 'qq_test',
    channel: 'qq-official',
    name: '测试机器人',
    platformId: '10001',
    credentials: { appId: '10001', appSecret: 'secret' },
    enabled: true,
    pairingCode: '123456',
    options: { cwd: '', permissionMode: 'auto', groupTrigger: 'mention', progress: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { store, state, bot };
}

function inbound(overrides: Partial<ImInboundMessage> = {}): ImInboundMessage {
  return {
    botId: 'qq_test',
    channel: 'qq-official',
    messageId: `m-${Math.random()}`,
    conversationKey: 'direct:10001',
    kind: 'direct',
    senderId: '10001',
    senderName: '测试用户',
    segments: [{ type: 'text', text: '你好' }],
    text: '你好',
    addressed: true,
    replyTarget: { channel: 'qq-official', kind: 'direct', targetId: '10001' },
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
    const typing: boolean[] = [];
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
      setTyping: async (_bot, _target, active) => {
        typing.push(active);
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

    const typingBeforeTask = typing.length;
    gateway.handle(bot, inbound({ text: '帮我写个文件' }));
    await Bun.sleep(50);
    expect(replies.some(item => item.text.includes('收到，正在处理'))).toBe(false);
    expect(typing.slice(typingBeforeTask).includes(true)).toBe(true);
    expect(typing.at(-1)).toBe(false);
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
      setTyping: async () => undefined,
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
    await Bun.sleep(200);

    expect(agent.runs.length).toBe(1);
    expect(agent.runs[0]?.attachments?.length).toBe(1);
    expect(existsSync(agent.runs[0]!.attachments![0]!)).toBe(true);
    expect(agent.runs[0]?.userMessage).toContain('[IM 附件 · qq-official]');
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
      setTyping: async () => undefined,
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
      setTyping: async () => undefined,
      getBot: botId => (botId === bot.botId ? bot : null),
      updateBotOptions: async () => undefined,
    });
    gateway.handle(
      bot,
      inbound({ kind: 'group', conversationKey: 'group:90001', addressed: false, replyTarget: {
        channel: 'qq-official',
        kind: 'group',
        targetId: '90001',
      } }),
    );
    await Bun.sleep(20);
    expect(agent.runs.length).toBe(0);
  });
});

describe('wechat descriptor', () => {
  test('支持扫码与手动添加：必填校验与平台身份', async () => {
    expect(wechatDescriptor.capabilities.qrLogin).toBe(true);
    await expect(wechatDescriptor.verify({})).rejects.toThrow('Bot Token 与 Bot ID 必填');
    const identity = await wechatDescriptor.verify({ botToken: 'token', botId: 'bot-1' });
    expect(identity.platformId).toBe('bot-1');
    expect(identity.name).toBe('MOSS');
  });
});

describe('qq descriptor', () => {
  test('支持扫码接入与手动凭据校验', () => {
    expect(qqDescriptor.capabilities.qrLogin).toBe(true);
  });
});

describe('retired channel cleanup', () => {
  test('启动时移除飞书/钉钉/企微/OneBot 机器人并写回文件', async () => {
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
          { ...base, botId: 'wc_retired', channel: 'wecom-aibot', platformId: 'wecom_retired' },
          { ...base, botId: 'ob_retired', channel: 'qq-onebot', platformId: 'onebot:6199' },
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
    typing: boolean[] = [],
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
      setTyping: async (_bot, _target, active) => {
        typing.push(active);
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
    const typing: boolean[] = [];
    const gateway = buildGateway(
      agent,
      state,
      tempDir(),
      replies,
      botId => (botId === current.botId ? current : null),
      async (_botId, patch) => {
        current = { ...current, options: { ...current.options, ...patch } };
      },
      typing,
    );

    gateway.handle(current, inbound({ text: '帮我写个文件' }));
    await Bun.sleep(20);
    expect(replies.some(text => text.includes('请选择 MOSS 的执行权限'))).toBe(true);
    expect(agent.runs.length).toBe(0);
    // 消息一到先显示正在输入，权限菜单发出后停止
    expect(typing.slice(0, 2)).toEqual([true, false]);

    gateway.handle(current, inbound({ text: '1' }));
    await Bun.sleep(60);
    expect(agent.runs.length).toBe(1);
    expect(agent.runs[0]?.permissionMode).toBe('auto');
    expect(replies.some(text => text.includes('已设置权限：自动审批。'))).toBe(true);
    expect(replies.some(text => text.includes('开始执行任务'))).toBe(false);
    expect(typing.filter(value => value === true).length).toBeGreaterThanOrEqual(2);
    expect(typing.at(-1)).toBe(false);
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
    const typing: boolean[] = [];
    const gateway = buildGateway(agent, state, tempDir(), replies, () => bot, async () => undefined, typing);

    gateway.handle(bot, inbound({ text: '开始' }));
    await Bun.sleep(40);
    expect(replies.some(text => text.includes('选择数据库'))).toBe(true);
    expect(typing.slice(0, 2)).toEqual([true, false]);

    gateway.handle(bot, inbound({ text: '2' }));
    await Bun.sleep(30);
    expect(agent.resolvedAsks.length).toBe(1);
    expect(agent.resolvedAsks[0]?.outcome.action).toBe('accept');
    expect(agent.resolvedAsks[0]?.outcome.answers?.[0]?.selectedValues).toEqual(['pg']);
    expect(typing.slice(2).includes(true)).toBe(true);
    expect(typing.at(-1)).toBe(false);
  });

  test('confirm 事件用 1/2/3 回复，resolveConfirm 支持会话级放行', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    agent.confirmHold = true;
    agent.injectConfirm = { toolName: 'write', question: '写入文件？' };
    const replies: string[] = [];
    const typing: boolean[] = [];
    const gateway = buildGateway(agent, state, tempDir(), replies, () => bot, async () => undefined, typing);

    gateway.handle(bot, inbound({ text: '开始' }));
    await Bun.sleep(40);
    expect(replies.some(text => text.includes('需要确认'))).toBe(true);
    expect(typing.slice(0, 2)).toEqual([true, false]);

    gateway.handle(bot, inbound({ text: '3' }));
    await Bun.sleep(30);
    expect(agent.resolvedConfirms[0]?.ok).toBe(true);
    expect(agent.resolvedConfirms[0]?.remember).toBe('session');
    expect(typing.slice(2).includes(true)).toBe(true);
    expect(typing.at(-1)).toBe(false);
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

  test('run 结束后延迟到达的 todo 事件不再推送或点亮正在输入', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const dataDir = tempDir();
    const agent = new FakeAgent();
    const replies: string[] = [];
    const typing: boolean[] = [];
    const gateway = buildGateway(agent, state, dataDir, replies, () => bot, async () => undefined, typing);

    gateway.handle(bot, inbound({ text: '开始' }));
    await Bun.sleep(60);
    const sessionId = agent.runs[0]?.sessionId;
    expect(sessionId).toBeTruthy();
    writeSessionTodoStore(getSessionTodoPathFromDir(dataDir, sessionId!), {
      nextId: 2,
      items: [
        {
          id: '1',
          text: '延迟任务',
          status: 'in_progress',
          priority: 'high',
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    const typingBefore = typing.length;
    agent.lastOnEvent?.({
      type: 'tool-call-end',
      sessionId: sessionId!,
      toolName: 'todo',
      toolCallId: 'tc-late',
      result: { content: [] },
    });
    await Bun.sleep(30);
    expect(replies.some(text => text.includes('延迟任务'))).toBe(false);
    expect(typing.slice(typingBefore).filter(Boolean)).toHaveLength(0);
  });

  test('过程播报：read 完成后逐条回复「已读取」', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    const replies: string[] = [];
    const gateway = buildGateway(agent, state, tempDir(), replies, () => bot, async () => undefined);

    agent.onRun = sessionId => {
      agent.lastOnEvent?.({ type: 'tool-call-start', sessionId, toolName: 'read', toolCallId: 'tc-read', args: '' });
      agent.lastOnEvent?.({
        type: 'tool-call-delta',
        sessionId,
        toolCallId: 'tc-read',
        argumentsDelta: JSON.stringify({ path: 'src/a.ts' }),
      });
      agent.lastOnEvent?.({ type: 'tool-call-executing', sessionId, toolName: 'read', toolCallId: 'tc-read' });
      agent.lastOnEvent?.({
        type: 'tool-call-end',
        sessionId,
        toolName: 'read',
        toolCallId: 'tc-read',
        result: { content: [] },
      });
    };

    gateway.handle(bot, inbound({ text: '读一下文件' }));
    await Bun.sleep(60);
    expect(replies).toContain('已读取 src/a.ts');
    // 过程播报先于最终答案
    expect(replies.indexOf('已读取 src/a.ts')).toBeLessThan(replies.indexOf('任务完成'));
  });

  test('过程播报：多文件按行列出', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    const replies: string[] = [];
    const gateway = buildGateway(agent, state, tempDir(), replies, () => bot, async () => undefined);

    agent.onRun = sessionId => {
      agent.lastOnEvent?.({ type: 'tool-call-start', sessionId, toolName: 'read', toolCallId: 'tc-multi', args: '' });
      agent.lastOnEvent?.({
        type: 'tool-call-delta',
        sessionId,
        toolCallId: 'tc-multi',
        argumentsDelta: JSON.stringify({ paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
      });
      agent.lastOnEvent?.({ type: 'tool-call-executing', sessionId, toolName: 'read', toolCallId: 'tc-multi' });
      agent.lastOnEvent?.({
        type: 'tool-call-end',
        sessionId,
        toolName: 'read',
        toolCallId: 'tc-multi',
        result: { content: [] },
      });
    };

    gateway.handle(bot, inbound({ text: '批量读取' }));
    await Bun.sleep(60);
    expect(replies).toContain('已读取3个文件：\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts');
  });

  test('过程播报：同批多个子智能体合并为一条', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    const replies: string[] = [];
    const gateway = buildGateway(agent, state, tempDir(), replies, () => bot, async () => undefined);

    agent.onRun = sessionId => {
      for (const [index, template] of ['agent_explorer', 'agent_coder'].entries()) {
        const toolCallId = `tc-agent-${index}`;
        const task = index === 0 ? '探索认证模块' : '实现登录接口';
        agent.lastOnEvent?.({ type: 'tool-call-start', sessionId, toolName: 'agent', toolCallId, args: '' });
        agent.lastOnEvent?.({
          type: 'tool-call-delta',
          sessionId,
          toolCallId,
          argumentsDelta: JSON.stringify({ template, task }),
        });
        agent.lastOnEvent?.({ type: 'tool-call-executing', sessionId, toolName: 'agent', toolCallId });
      }
    };

    gateway.handle(bot, inbound({ text: '并行两个子任务' }));
    await Bun.sleep(60);
    const batch = replies.filter(text => text.startsWith('已调起'));
    expect(batch).toHaveLength(1);
    expect(batch[0]).toBe(
      '已调起2个子智能体：\n'
      + '智能体1（agent_explorer）：探索认证模块\n'
      + '智能体2（agent_coder）：实现登录接口',
    );
  });

  test('过程播报：progress=false 时不产生操作消息', async () => {
    const { state, bot } = await makeBot();
    state.bind(bot.botId, { id: '10001', name: 'u', boundAt: new Date().toISOString() });
    const agent = new FakeAgent();
    const replies: string[] = [];
    const gateway = buildGateway(agent, state, tempDir(), replies, () => bot, async () => undefined);
    const quietBot: StoredImBot = { ...bot, options: { ...bot.options, progress: false } };

    agent.onRun = sessionId => {
      agent.lastOnEvent?.({ type: 'tool-call-start', sessionId, toolName: 'read', toolCallId: 'tc-quiet', args: '' });
      agent.lastOnEvent?.({
        type: 'tool-call-delta',
        sessionId,
        toolCallId: 'tc-quiet',
        argumentsDelta: JSON.stringify({ path: 'src/a.ts' }),
      });
      agent.lastOnEvent?.({
        type: 'tool-call-end',
        sessionId,
        toolName: 'read',
        toolCallId: 'tc-quiet',
        result: { content: [] },
      });
    };

    gateway.handle(quietBot, inbound({ text: '读一下文件' }));
    await Bun.sleep(60);
    expect(replies.some(text => text.includes('已读取'))).toBe(false);
    expect(replies.some(text => text.includes('任务完成'))).toBe(true);
  });
});

describe('controller save', () => {
  test('编辑机器人时必填字段留空回填旧值', async () => {
    const dir = tempDir();
    const logger = fakeLogger();
    const store = new ImBotStore(dir, logger);
    const state = new ImStateStore(dir, logger);
    await store.load();
    await state.load();
    const botId = deriveBotId('wechat-ilink', 'bot-1');
    await store.save({
      botId,
      channel: 'wechat-ilink',
      name: '旧名称',
      platformId: 'bot-1',
      credentials: { botToken: 'old-token', botId: 'bot-1' },
      enabled: false,
      pairingCode: '123456',
      options: { cwd: '', permissionMode: 'ask', groupTrigger: 'mention', progress: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const controller = new ImController({
      store,
      state,
      logger,
      services: fakeRegistry(new FakeAgent(), { workingDirectory: '' }),
      server: fakeServer(),
      dataDir: dir,
    });

    const saved = await controller.saveBot({
      botId,
      channel: 'wechat-ilink',
      name: '新名称',
      credentials: { botToken: 'new-token', botId: '' },
      enabled: false,
    });
    expect(saved.name).toBe('新名称');
    const updated = store.get(botId);
    expect(updated?.credentials.botId).toBe('bot-1');
    expect(updated?.credentials.botToken).toBe('new-token');
    await controller.dispose();
  });
});

describe('qq auth error', () => {
  test('仅把授权失效识别为需要重新扫码', () => {
    expect(isQqAuthorizationError(new Error('Failed to get access_token: {"code":100016,"message":"invalid appid or secret"}')))
      .toBe(true);
    expect(isQqAuthorizationError(new Error('invalid appid or secret'))).toBe(true);
    expect(isQqAuthorizationError(new Error('token expired'))).toBe(true);
    expect(isQqAuthorizationError(new Error('Network error [getGatewayUrl]: fetch failed'))).toBe(false);
  });
});
