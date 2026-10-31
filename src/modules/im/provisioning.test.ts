// src/modules/im/provisioning.test.ts
// 扫码接入状态机单测：注入假 fetch 与假 QQ 连接器，不依赖真实网络与手机。

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../core/types';
import type { ImController } from './controller';
import { ImProvisioningManager } from './provisioning';
import { ImBotStore } from './store';
import type { ImBotStatusSnapshot, ImChannelId, ImStatusSnapshot } from './types';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moss-im-provisioning-'));
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

function botSnapshot(channel: ImChannelId, botId: string): ImBotStatusSnapshot {
  return {
    botId,
    channel,
    name: 'MOSS',
    enabled: true,
    state: 'connected',
    platformIdMasked: 'masked',
    hasCredentials: true,
    lastError: null,
    lastMessageAt: null,
    stats: { received: 0, replied: 0 },
    options: { cwd: '', permissionMode: 'auto', groupTrigger: 'mention', progress: true },
    pairingCode: '123456',
    boundUsers: [],
    credentialPreview: {},
  };
}

interface WechatCreateArgs {
  botToken: string;
  botId: string;
  ownerUserId: string;
  baseUrl?: string;
}

interface QqCreateArgs {
  appId: string;
  appSecret: string;
  ownerUserOpenid?: string;
}

interface FakeController {
  controller: Pick<ImController, 'createWechatBot' | 'createQqBot' | 'status'>;
  wechatArgs: WechatCreateArgs[];
  qqArgs: QqCreateArgs[];
}

function fakeController(): FakeController {
  const wechatArgs: WechatCreateArgs[] = [];
  const qqArgs: QqCreateArgs[] = [];
  const emptyStatus: ImStatusSnapshot = { bots: [], totals: { configured: 0, connected: 0 } };
  const controller: Pick<ImController, 'createWechatBot' | 'createQqBot' | 'status'> = {
    createWechatBot: async input => {
      wechatArgs.push(input);
      return botSnapshot('wechat-ilink', 'wx_test');
    },
    createQqBot: async input => {
      qqArgs.push(input);
      return botSnapshot('qq-official', 'qq_test');
    },
    status: () => emptyStatus,
  };
  return { controller, wechatArgs, qqArgs };
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 2_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    await Bun.sleep(10);
  }
  throw new Error('等待扫码状态超时');
}

function makeManager(fetchJson?: typeof import('./adapters/util').fetchJson): {
  manager: ImProvisioningManager;
  fake: FakeController;
} {
  const dir = tempDir();
  const logger = fakeLogger();
  const store = new ImBotStore(dir, logger);
  void store.load();
  const fake = fakeController();
  const manager = new ImProvisioningManager({
    controller: fake.controller,
    store,
    logger,
    ...(fetchJson ? { fetchJson } : {}),
  });
  return { manager, fake };
}

describe('微信扫码状态机', () => {
  test('wait → need_verifycode → verify → confirmed 自动落库', async () => {
    const responses: unknown[] = [
      { qrcode: 'qr-token', qrcode_img_content: 'https://liteapp.weixin.qq.com/qr?x=1' },
      { status: 'wait' },
      { status: 'need_verifycode' },
      { status: 'confirmed', bot_token: 'token-1', ilink_bot_id: 'bot-1', ilink_user_id: 'user-1', baseurl: 'https://ilinkai.weixin.qq.com/' },
    ];
    const fetchJson = async (): Promise<unknown> => {
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected fetch');
      return next;
    };
    const { manager, fake } = makeManager(fetchJson);
    const started = await manager.start('wechat-ilink');
    expect(started.qrUrl).toContain('liteapp.weixin.qq.com');

    await waitFor(() => manager.get(started.loginId)?.status === 'needs_verification');
    const verified = await manager.verify(started.loginId, '1234');
    expect(verified.status).toBe('scanned');

    const connected = await waitFor(() => {
      const snapshot = manager.get(started.loginId);
      return snapshot?.status === 'connected' ? snapshot : undefined;
    });
    expect(connected.bot?.botId).toBe('wx_test');
    expect(fake.wechatArgs).toEqual([{
      botToken: 'token-1',
      botId: 'bot-1',
      ownerUserId: 'user-1',
      baseUrl: 'https://ilinkai.weixin.qq.com/',
    }]);
    await manager.close();
  });

  test('二维码过期与验证码封禁进入终止状态', async () => {
    const expiredResponses: unknown[] = [
      { qrcode: 'qr-token', qrcode_img_content: 'https://liteapp.weixin.qq.com/qr?x=1' },
      { status: 'expired' },
    ];
    const fetchExpired = async (): Promise<unknown> => expiredResponses.shift() ?? null;
    const first = makeManager(fetchExpired);
    const started = await first.manager.start('wechat-ilink');
    const expired = await waitFor(() => {
      const snapshot = first.manager.get(started.loginId);
      return snapshot?.status === 'expired' ? snapshot : undefined;
    });
    expect(expired.message).toContain('二维码已过期');
    await first.manager.close();

    const blockedResponses: unknown[] = [
      { qrcode: 'qr-token', qrcode_img_content: 'https://liteapp.weixin.qq.com/qr?x=1' },
      { status: 'need_verifycode' },
      { status: 'verify_code_blocked' },
    ];
    const fetchBlocked = async (): Promise<unknown> => blockedResponses.shift() ?? null;
    const second = makeManager(fetchBlocked);
    const blockedStart = await second.manager.start('wechat-ilink');
    await waitFor(() => second.manager.get(blockedStart.loginId)?.status === 'needs_verification');
    await second.manager.verify(blockedStart.loginId, '1234');
    const failed = await waitFor(() => {
      const snapshot = second.manager.get(blockedStart.loginId);
      return snapshot?.status === 'failed' ? snapshot : undefined;
    });
    expect(failed.error).toContain('验证码多次错误');
    await second.manager.close();
  });
});

interface QqCallbacks {
  onSuccess(credentials: Array<{ appId: string; appSecret: string; userOpenid?: string }>): void;
  onFailure(error: Error): void;
  onQrDisplayed?(url: string): void;
  onQrExpired?(): void;
}

describe('QQ 扫码回调', () => {
  test('展示、刷新、成功后自动落库', async () => {
    const captured: { callbacks: QqCallbacks | null } = { callbacks: null };
    let disposed = false;
    const fake = fakeController();
    const qqManager = new ImProvisioningManager({
      controller: fake.controller,
      store: new ImBotStore(tempDir(), fakeLogger()),
      logger: fakeLogger(),
      startQrConnect: (nextCallbacks) => {
        captured.callbacks = nextCallbacks;
        setTimeout(() => nextCallbacks.onQrDisplayed?.('https://q.qq.com/qqbot/openclaw/connect.html?task_id=1'), 0);
        return () => {
          disposed = true;
        };
      },
    });
    const started = await qqManager.start('qq-official');
    expect(started.status).toBe('pending');
    expect(started.qrUrl).toContain('q.qq.com');

    captured.callbacks?.onQrExpired?.();
    expect(qqManager.get(started.loginId)?.status).toBe('refreshing');
    captured.callbacks?.onQrDisplayed?.('https://q.qq.com/qqbot/openclaw/connect.html?task_id=2');
    const refreshed = qqManager.get(started.loginId);
    expect(refreshed?.status).toBe('pending');
    expect(refreshed?.qrRevision).toBe(2);

    captured.callbacks?.onSuccess([{ appId: '1024', appSecret: 'secret-1', userOpenid: 'openid-1' }]);
    const connected = await waitFor(() => {
      const snapshot = qqManager.get(started.loginId);
      return snapshot?.status === 'connected' ? snapshot : undefined;
    });
    expect(connected.bot?.botId).toBe('qq_test');
    expect(fake.qqArgs).toEqual([{ appId: '1024', appSecret: 'secret-1', ownerUserOpenid: 'openid-1' }]);
    expect(disposed).toBe(true);
    await qqManager.close();
  });

  test('扫码失败会终止并抛出原因', async () => {
    const fake = fakeController();
    const failing = new ImProvisioningManager({
      controller: fake.controller,
      store: new ImBotStore(tempDir(), fakeLogger()),
      logger: fakeLogger(),
      startQrConnect: nextCallbacks => {
        setTimeout(() => nextCallbacks.onFailure(new Error('用户拒绝授权')), 0);
        return () => undefined;
      },
    });
    await expect(failing.start('qq-official')).rejects.toThrow('用户拒绝授权');
    await failing.close();
  });

  test('同一渠道重复开始会取消旧会话', async () => {
    const fake = fakeController();
    const qqManager = new ImProvisioningManager({
      controller: fake.controller,
      store: new ImBotStore(tempDir(), fakeLogger()),
      logger: fakeLogger(),
      startQrConnect: nextCallbacks => {
        setTimeout(() => nextCallbacks.onQrDisplayed?.('https://q.qq.com/qqbot/openclaw/connect.html?task_id=x'), 0);
        return () => undefined;
      },
    });
    const first = await qqManager.start('qq-official');
    const second = await qqManager.start('qq-official');
    expect(qqManager.get(first.loginId)?.status).toBe('cancelled');
    expect(qqManager.get(second.loginId)?.status).toBe('pending');
    await qqManager.close();
  });
});
