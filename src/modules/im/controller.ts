// src/modules/im/controller.ts
// 多机器人生命周期：新增/编辑/启停/删除/重连/测试/配对码，以及运行时状态快照。
// 同一 botId 的变更串行执行，避免「正在启动」与「正在停止」互相覆盖。

import { t } from '../../core/i18n';
import type { Logger, ServiceRegistry } from '../../core/types';
import { createAdapter, getDescriptor, listDescriptors } from './adapters/registry';
import { readOneBotConfig } from './adapters/onebot/gateway';
import { ImGateway } from './gateway';
import { DEFAULT_BOT_NAME, deriveBotId, generatePairingCode, isValidPairingCode, maskPlatformId } from './identity';
import type { ImBotStore } from './store';
import { defaultBotOptions, missingRequiredFields, normalizeOptions as normalizeBotOptions } from './store';
import type { ImStateStore } from './state';
import type {
  ImChannelAdapter,
  ImChannelId,
  ImBotOptions,
  ImBotStatusSnapshot,
  ImReplyTarget,
  ImRuntimeStatus,
  ImStatusSnapshot,
  StoredImBot,
} from './types';
import type { ServerInstance } from '../server/types';

/** 新增/编辑机器人的入参（来自 HTTP） */
export interface SaveBotInput {
  botId?: string;
  channel: string;
  name?: string;
  credentials?: Record<string, string>;
  options?: Partial<ImBotOptions>;
  enabled?: boolean;
}

interface RuntimeEntry {
  bot: StoredImBot;
  adapter: ImChannelAdapter;
  abort: AbortController;
  status: ImRuntimeStatus;
  starting: boolean;
}

export interface ImControllerDeps {
  store: ImBotStore;
  state: ImStateStore;
  logger: Logger;
  services: ServiceRegistry;
  server: ServerInstance | null;
  /** ~/.moss（附件暂存根） */
  dataDir: string;
}

function emptyStatus(): ImRuntimeStatus {
  return { connected: false, lastError: null, lastMessageAt: null, received: 0, replied: 0 };
}

export class ImController {
  private readonly deps: ImControllerDeps;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly gateway: ImGateway;

  constructor(deps: ImControllerDeps) {
    this.deps = deps;
    this.gateway = new ImGateway({
      logger: deps.logger,
      services: deps.services,
      state: deps.state,
      server: deps.server,
      dataDir: deps.dataDir,
      supportsMarkdown: bot => getDescriptor(bot.channel)?.capabilities.markdown ?? false,
      channelLabel: bot => getDescriptor(bot.channel)?.label ?? bot.channel,
      sendText: (bot, target, text) => this.sendViaBot(bot.botId, target, text),
      getBot: botId => this.deps.store.get(botId),
      updateBotOptions: (botId, patch) => this.updateBotOptions(botId, patch),
    });
  }

  /** 启动全部已启用的机器人（模块初始化时调用；单个失败不影响其他） */
  async startAll(): Promise<void> {
    for (const bot of this.deps.store.list()) {
      if (!bot.enabled) continue;
      try {
        await this.startBot(bot);
      } catch (error) {
        this.deps.logger.warn(t('im.botStartFailed'), {
          botId: bot.botId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 渠道描述符（设置页渲染表单/指引） */
  descriptors() {
    return listDescriptors();
  }

  status(): ImStatusSnapshot {
    const bots = this.deps.store.list().map(bot => this.snapshot(bot));
    return {
      bots,
      totals: {
        configured: bots.length,
        connected: bots.filter(item => item.state === 'connected').length,
      },
    };
  }

  getBot(botId: string): StoredImBot | null {
    return this.deps.store.get(botId);
  }

  /** 新增或更新机器人；凭据校验失败直接抛错（前端展示原文） */
  async saveBot(input: SaveBotInput): Promise<ImBotStatusSnapshot> {
    const channel = input.channel as ImChannelId;
    const descriptor = getDescriptor(channel);
    if (!descriptor) throw new Error(`不支持的渠道：${input.channel}`);
    if (descriptor.capabilities.qrOnly) throw new Error('该渠道请通过扫码登录接入');

    const provided = input.credentials ?? {};
    const credentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(provided)) {
      if (typeof value === 'string') credentials[key] = value.trim();
    }
    const existing = input.botId ? this.deps.store.get(input.botId) : null;

    // 编辑时密码字段留空 = 保留旧值
    if (existing) {
      for (const field of descriptor.fields) {
        if (field.type !== 'password') continue;
        if (!credentials[field.key] && existing.credentials[field.key]) {
          credentials[field.key] = existing.credentials[field.key];
        }
      }
      // 旧微信机器人未单独保存 botId（以 platformId 为准），编辑时回填避免必填校验失败
      if (channel === 'wechat-ilink' && !credentials.botId) credentials.botId = existing.platformId;
    }

    const missing = missingRequiredFields(descriptor.fields, credentials);
    if (missing.length > 0) throw new Error(`缺少必填项：${missing.join('、')}`);

    const identity = await descriptor.verify(credentials);
    if (identity.extra) {
      for (const [key, value] of Object.entries(identity.extra)) {
        if (key === 'botOpenId' || key === 'appId' || key === 'port' || key === 'robotCode') {
          credentials[key] = value;
        }
      }
    }

    const botId = deriveBotId(channel, identity.platformId);
    // OneBot 监听端口在本机必须唯一（正向模式不监听）
    if (channel === 'qq-onebot') {
      const config = readOneBotConfig(credentials);
      if (config.mode !== 'forward-ws') {
        const conflict = this.deps.store.list().find(item => {
          if (item.channel !== 'qq-onebot' || item.botId === botId) return false;
          const other = readOneBotConfig(item.credentials);
          return other.mode !== 'forward-ws' && other.listenPort === config.listenPort;
        });
        if (conflict) throw new Error(`端口 ${config.listenPort} 已被机器人「${conflict.name}」占用`);
      }
    }
    // platformId 变化（例如换了 App）→ 视为新机器人：停掉并移除旧条目
    if (existing && existing.botId !== botId) {
      await this.removeBot(existing.botId);
    }

    const previous = this.deps.store.get(botId);
    const now = new Date().toISOString();
    const bot: StoredImBot = {
      botId,
      channel,
      name: input.name?.trim() || DEFAULT_BOT_NAME,
      platformId: identity.platformId,
      credentials,
      enabled: input.enabled ?? previous?.enabled ?? true,
      pairingCode: previous?.pairingCode ?? generatePairingCode(),
      options: normalizeBotOptions({
        ...(previous?.options ?? defaultBotOptions()),
        ...(input.options ?? {}),
      }),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.store.save(bot);
    if (bot.enabled) {
      // 启动失败不回滚配置：状态里会显示错误原因，用户可直接重试
      await this.startBot(bot).catch(error => {
        this.deps.logger.warn(t('im.botStartFailed'), {
          botId: bot.botId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      await this.stopBot(bot.botId);
    }
    return this.snapshot(bot);
  }

  /** 微信扫码登录成功后创建/更新机器人，并把扫码者设为已绑定用户 */
  async createWechatBot(credentials: { botToken: string; botId: string; ownerUserId: string }): Promise<ImBotStatusSnapshot> {
    const botId = deriveBotId('wechat-ilink', credentials.botId);
    const previous = this.deps.store.get(botId);
    const now = new Date().toISOString();
    const bot: StoredImBot = {
      botId,
      channel: 'wechat-ilink',
      name: DEFAULT_BOT_NAME,
      platformId: credentials.botId,
      credentials: {
        botToken: credentials.botToken,
        botId: credentials.botId,
        baseUrl: 'https://ilinkai.weixin.qq.com/',
        ownerUserId: credentials.ownerUserId,
      },
      enabled: true,
      pairingCode: previous?.pairingCode ?? generatePairingCode(),
      options: previous?.options ?? defaultBotOptions(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.store.save(bot);
    this.deps.state.bind(bot.botId, {
      id: credentials.ownerUserId,
      name: '扫码者',
      boundAt: now,
    });
    await this.startBot(bot).catch(error => {
      this.deps.logger.warn(t('im.botStartFailed'), {
        botId: bot.botId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return this.snapshot(bot);
  }

  async setEnabled(botId: string, enabled: boolean): Promise<ImBotStatusSnapshot> {
    const bot = this.requireBot(botId);
    const next = { ...bot, enabled, updatedAt: new Date().toISOString() };
    await this.deps.store.save(next);
    if (enabled) await this.startBot(next);
    else await this.stopBot(botId);
    return this.snapshot(next);
  }

  async removeBot(botId: string): Promise<void> {
    const bot = this.deps.store.get(botId);
    if (!bot) return;
    await this.stopBot(botId);
    await this.deps.store.remove(botId);
    this.deps.state.clearBot(botId);
  }

  async reconnect(botId: string): Promise<ImBotStatusSnapshot> {
    const bot = this.requireBot(botId);
    if (!bot.enabled) {
      const next = { ...bot, enabled: true, updatedAt: new Date().toISOString() };
      await this.deps.store.save(next);
      await this.startBot(next);
      return this.snapshot(next);
    }
    await this.startBot(bot);
    return this.snapshot(bot);
  }

  /** 测试消息：有会话直接发送；无会话先校验凭据，把鉴权错误暴露给用户 */
  async test(botId: string): Promise<void> {
    const bot = this.requireBot(botId);
    const target = this.deps.state.getLastTarget(botId);
    if (!target) {
      const descriptor = getDescriptor(bot.channel);
      if (descriptor) await descriptor.verify(bot.credentials);
      throw new Error('还没有可用的会话：请先在 IM 里给机器人发一条消息，再点测试。');
    }
    await this.sendViaBot(botId, target, 'MOSS 连接正常，这是一条测试消息。');
  }

  async rotatePairing(botId: string): Promise<ImBotStatusSnapshot> {
    const bot = this.requireBot(botId);
    const next = { ...bot, pairingCode: generatePairingCode(), updatedAt: new Date().toISOString() };
    await this.deps.store.save(next);
    return this.snapshot(next);
  }

  async unbind(botId: string, userId: string): Promise<ImBotStatusSnapshot> {
    const bot = this.requireBot(botId);
    this.deps.state.unbind(botId, userId);
    return this.snapshot(bot);
  }

  /** 合并机器人运行参数并持久化（权限选择等即时生效，不重启适配器） */
  async updateBotOptions(botId: string, patch: Partial<ImBotOptions>): Promise<ImBotStatusSnapshot> {
    const bot = this.requireBot(botId);
    const next: StoredImBot = {
      ...bot,
      options: normalizeBotOptions({ ...bot.options, ...patch }),
      updatedAt: new Date().toISOString(),
    };
    await this.deps.store.save(next);
    return this.snapshot(next);
  }

  async dispose(): Promise<void> {
    this.gateway.abortAll();
    for (const botId of [...this.runtimes.keys()]) {
      await this.stopBot(botId);
    }
  }

  // ---------------------------------------------------------------- 运行时

  private async startBot(bot: StoredImBot): Promise<void> {
    await this.stopBot(bot.botId);
    const descriptor = getDescriptor(bot.channel);
    if (!descriptor) throw new Error(`不支持的渠道：${bot.channel}`);
    const abort = new AbortController();
    const status = emptyStatus();
    const adapter = createAdapter(bot.channel, {
      bot,
      logger: this.deps.logger,
      signal: abort.signal,
      onMessage: message => {
        const entry = this.runtimes.get(bot.botId);
        if (entry) {
          entry.status.lastMessageAt = new Date().toISOString();
          entry.status.received += 1;
          this.deps.state.setLastTarget(bot.botId, message.replyTarget);
        }
        this.gateway.handle(this.deps.store.get(bot.botId) ?? bot, message);
      },
      onStatus: patch => this.applyStatus(bot.botId, patch),
      cursor: {
        get: () => this.deps.state.getCursor(bot.botId),
        set: value => this.deps.state.setCursor(bot.botId, value),
      },
    });
    this.runtimes.set(bot.botId, { bot, adapter, abort, status, starting: true });
    try {
      await adapter.start();
      const entry = this.runtimes.get(bot.botId);
      if (entry) {
        entry.starting = false;
        entry.status.lastError = null;
      }
    } catch (error) {
      const entry = this.runtimes.get(bot.botId);
      if (entry) {
        entry.starting = false;
        entry.status.connected = false;
        entry.status.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
  }

  private async stopBot(botId: string): Promise<void> {
    const entry = this.runtimes.get(botId);
    if (!entry) return;
    this.runtimes.delete(botId);
    entry.abort.abort();
    try {
      await entry.adapter.stop();
    } catch (error) {
      this.deps.logger.warn(t('im.botStopFailed'), {
        botId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applyStatus(botId: string, patch: Partial<ImRuntimeStatus>): void {
    const entry = this.runtimes.get(botId);
    if (!entry) return;
    entry.status = {
      ...entry.status,
      ...patch,
      extra: patch.extra ? { ...entry.status.extra, ...patch.extra } : entry.status.extra,
    };
  }

  private async sendViaBot(botId: string, target: ImReplyTarget, text: string): Promise<void> {
    const entry = this.runtimes.get(botId);
    if (!entry) throw new Error('机器人未启用或尚未启动');
    await entry.adapter.sendText(target, text);
    entry.status.replied += 1;
  }

  // ---------------------------------------------------------------- 快照

  private snapshot(bot: StoredImBot): ImBotStatusSnapshot {
    const runtime = this.runtimes.get(bot.botId);
    const status = runtime?.status ?? emptyStatus();
    const state: ImBotStatusSnapshot['state'] = status.connected
      ? 'connected'
      : runtime?.starting
        ? 'connecting'
        : status.lastError
          ? 'error'
          : 'offline';
    const descriptor = getDescriptor(bot.channel);
    const credentialPreview: Record<string, string> = {};
    for (const field of descriptor?.fields ?? []) {
      if (field.type === 'password') continue;
      const value = bot.credentials[field.key];
      if (value) credentialPreview[field.key] = value;
    }
    return {
      botId: bot.botId,
      channel: bot.channel,
      name: bot.name,
      enabled: bot.enabled,
      state,
      platformIdMasked: maskPlatformId(bot.platformId),
      hasCredentials: Object.keys(bot.credentials).length > 0,
      lastError: status.lastError,
      lastMessageAt: status.lastMessageAt,
      stats: { received: status.received, replied: status.replied },
      options: bot.options,
      pairingCode: isValidPairingCode(bot.pairingCode) ? bot.pairingCode : '',
      boundUsers: this.deps.state.listBindings(bot.botId),
      credentialPreview,
      ...(status.extra ? { extra: status.extra } : {}),
    };
  }

  private requireBot(botId: string): StoredImBot {
    const bot = this.deps.store.get(botId);
    if (!bot) throw new Error('机器人不存在');
    return bot;
  }
}
