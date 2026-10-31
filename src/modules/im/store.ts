// src/modules/im/store.ts
// 机器人配置持久化（~/.moss/im/bots.json，0600，原子写）。
// 凭据只落这个文件，绝不进入 config.json，也不通过 /api/im/status 返回。

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '../../core/types';
import { SYSTEM_SCOPE } from '../filesys/roots';
import { migrateLegacyBotName } from './identity';
import type { ImBotOptions, ImChannelId, ImFormField, StoredImBot } from './types';

interface ImBotsDocument {
  version: 1;
  bots: StoredImBot[];
}

const EMPTY_DOCUMENT: ImBotsDocument = { version: 1, bots: [] };

/** 默认机器人选项：操作范围本机、权限首次询问、过程播报开启 */
export function defaultBotOptions(): ImBotOptions {
  return { cwd: SYSTEM_SCOPE, permissionMode: 'unset', groupTrigger: 'mention', progress: true };
}

/** 渠道合法性判断（避免外部传入未知渠道） */
export function isImChannelId(value: string): value is ImChannelId {
  return ['wechat-ilink', 'qq-official'].includes(value);
}

/** 已下线渠道（启动时从 bots.json 清理） */
const RETIRED_CHANNELS = new Set(['feishu', 'dingtalk', 'wecom-aibot', 'qq-onebot']);

/** 安全读取原始条目的 channel 字段 */
function channelOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const channel = (value as Record<string, unknown>).channel;
  return typeof channel === 'string' ? channel : '';
}

/** 选项归一化：非法值回退默认，避免脏数据进入运行时 */
export function normalizeOptions(value: unknown): ImBotOptions {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const mode = source.permissionMode;
  const trigger = source.groupTrigger;
  const agentId = typeof source.agentId === 'string' ? source.agentId.trim() : '';
  return {
    cwd: typeof source.cwd === 'string' && source.cwd.trim() ? source.cwd.trim() : SYSTEM_SCOPE,
    permissionMode: mode === 'auto' || mode === 'skip' || mode === 'ask' ? mode : 'unset',
    groupTrigger: trigger === 'all' ? 'all' : 'mention',
    // 旧 bots.json 没有该字段：默认开启，仅显式 false 才关闭
    progress: typeof source.progress === 'boolean' ? source.progress : true,
    ...(agentId ? { agentId } : {}),
  };
}

/** 表单字段归一化（仅用于手动构造机器人时校验必填项） */
export function missingRequiredFields(fields: ImFormField[], credentials: Record<string, string>): string[] {
  return fields
    .filter(field => field.required)
    .filter(field => {
      const value = credentials[field.key];
      return typeof value !== 'string' || value.trim() === '';
    })
    .map(field => field.label);
}

function normalizeBot(value: unknown): StoredImBot | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const botId = typeof source.botId === 'string' ? source.botId.trim() : '';
  const channel = typeof source.channel === 'string' ? source.channel : '';
  const rawName = typeof source.name === 'string' ? source.name.trim() : '';
  const name = rawName ? migrateLegacyBotName(rawName) : '';
  const platformId = typeof source.platformId === 'string' ? source.platformId.trim() : '';
  const pairingCode = typeof source.pairingCode === 'string' ? source.pairingCode.trim() : '';
  if (!botId || !name || !platformId || !/^\d{6}$/.test(pairingCode) || !isImChannelId(channel)) return null;
  const credentials: Record<string, string> = {};
  if (source.credentials && typeof source.credentials === 'object') {
    for (const [key, raw] of Object.entries(source.credentials as Record<string, unknown>)) {
      if (typeof raw === 'string') credentials[key] = raw;
    }
  }
  return {
    botId,
    channel,
    name,
    platformId,
    credentials,
    enabled: source.enabled === true,
    pairingCode,
    options: normalizeOptions(source.options),
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
  };
}

export class ImBotStore {
  private readonly path: string;
  private readonly logger: Logger;
  private document: ImBotsDocument = EMPTY_DOCUMENT;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string, logger: Logger) {
    this.path = join(dataDir, 'im', 'bots.json');
    this.logger = logger;
  }

  async load(): Promise<void> {
    if (!existsSync(this.path)) {
      this.document = EMPTY_DOCUMENT;
      return;
    }
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const list = Array.isArray(source.bots) ? source.bots : [];
      // 已下线渠道（飞书/钉钉/企微/OneBot）在启动时清理并写回文件
      const retired = list.filter(item => RETIRED_CHANNELS.has(channelOf(item)));
      const remaining = retired.length > 0 ? list.filter(item => !RETIRED_CHANNELS.has(channelOf(item))) : list;
      const bots = remaining.map(normalizeBot).filter((bot): bot is StoredImBot => bot !== null);
      this.document = { version: 1, bots };
      if (retired.length > 0) {
        this.logger.info('im: 已移除下线渠道的机器人配置', { removed: retired.length, file: this.path });
        await this.write(this.document);
      }
      if (bots.length !== remaining.length) {
        this.logger.warn('im: 部分机器人配置无效，已忽略', { ignored: remaining.length - bots.length, file: this.path });
      }
    } catch (err) {
      this.logger.error('im: 读取机器人配置失败，按空配置启动', {
        file: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
      this.document = EMPTY_DOCUMENT;
    }
  }

  list(): StoredImBot[] {
    return this.document.bots.map(bot => ({ ...bot, credentials: { ...bot.credentials }, options: { ...bot.options } }));
  }

  get(botId: string): StoredImBot | null {
    const bot = this.document.bots.find(item => item.botId === botId);
    return bot ? { ...bot, credentials: { ...bot.credentials }, options: { ...bot.options } } : null;
  }

  getByPlatformId(channel: ImChannelId, platformId: string): StoredImBot | null {
    const bot = this.document.bots.find(item => item.channel === channel && item.platformId === platformId);
    return bot ? { ...bot, credentials: { ...bot.credentials }, options: { ...bot.options } } : null;
  }

  /** 保存（同 botId 覆盖；同渠道同 platformId 但 botId 不同 → 拒绝） */
  async save(bot: StoredImBot): Promise<StoredImBot> {
    const collision = this.document.bots.find(
      item => item.channel === bot.channel && item.platformId === bot.platformId && item.botId !== bot.botId,
    );
    if (collision) throw new Error('该平台账号已被另一个机器人占用');
    const next = { ...bot, updatedAt: new Date().toISOString() };
    await this.mutate(bots => {
      const index = bots.findIndex(item => item.botId === next.botId);
      if (index >= 0) bots[index] = next;
      else bots.push(next);
    });
    return { ...next, credentials: { ...next.credentials }, options: { ...next.options } };
  }

  async remove(botId: string): Promise<StoredImBot | null> {
    const existing = this.get(botId);
    if (!existing) return null;
    await this.mutate(bots => {
      const index = bots.findIndex(item => item.botId === botId);
      if (index >= 0) bots.splice(index, 1);
    });
    return existing;
  }

  private async mutate(mutator: (bots: StoredImBot[]) => void): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const bots = this.document.bots.map(bot => ({ ...bot }));
      mutator(bots);
      const document: ImBotsDocument = { version: 1, bots };
      await this.write(document);
      this.document = document;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async write(document: ImBotsDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}
