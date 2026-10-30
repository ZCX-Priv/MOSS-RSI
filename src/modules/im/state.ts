// src/modules/im/state.ts
// IM 运行时状态持久化（~/.moss/im/state.json，0600，原子写）：
// 绑定关系 / 会话↔任务映射 / 最近回复目标 / 去重集合 / 微信长轮询游标。

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '../../core/types';
import type { ImBinding, ImConversation, ImReplyTarget } from './types';

interface ImStateDocument {
  version: 1;
  bindings: Record<string, ImBinding[]>;
  conversations: Record<string, ImConversation>;
  lastTargets: Record<string, ImReplyTarget>;
  seen: Record<string, string[]>;
  cursors: Record<string, string>;
}

const EMPTY_DOCUMENT: ImStateDocument = {
  version: 1,
  bindings: {},
  conversations: {},
  lastTargets: {},
  seen: {},
  cursors: {},
};

/** 每个机器人保留的去重消息上限（防内存与文件无界增长） */
const SEEN_LIMIT = 2000;

function normalizeTarget(value: unknown): ImReplyTarget | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (typeof source.channel !== 'string' || source.kind !== 'direct' && source.kind !== 'group') return null;
  return { ...source, channel: source.channel as ImReplyTarget['channel'], kind: source.kind };
}

export class ImStateStore {
  private readonly path: string;
  private readonly logger: Logger;
  private document: ImStateDocument = EMPTY_DOCUMENT;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string, logger: Logger) {
    this.path = join(dataDir, 'im', 'state.json');
    this.logger = logger;
  }

  async load(): Promise<void> {
    if (!existsSync(this.path)) {
      this.document = { ...EMPTY_DOCUMENT };
      return;
    }
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const document: ImStateDocument = {
        version: 1,
        bindings: {},
        conversations: {},
        lastTargets: {},
        seen: {},
        cursors: {},
      };
      if (source.bindings && typeof source.bindings === 'object') {
        for (const [botId, list] of Object.entries(source.bindings as Record<string, unknown>)) {
          if (!Array.isArray(list)) continue;
          document.bindings[botId] = list
            .filter((item): item is ImBinding => (
              Boolean(item) && typeof item === 'object'
              && typeof (item as ImBinding).id === 'string'
              && typeof (item as ImBinding).boundAt === 'string'
            ))
            .map(item => ({ id: item.id, name: String(item.name ?? ''), boundAt: item.boundAt }));
        }
      }
      if (source.conversations && typeof source.conversations === 'object') {
        for (const [key, value] of Object.entries(source.conversations as Record<string, unknown>)) {
          const item = value as ImConversation | undefined;
          if (!item || typeof item.taskId !== 'string' || typeof item.sessionId !== 'string') continue;
          document.conversations[key] = {
            taskId: item.taskId,
            sessionId: item.sessionId,
            title: String(item.title ?? ''),
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
          };
        }
      }
      if (source.lastTargets && typeof source.lastTargets === 'object') {
        for (const [botId, value] of Object.entries(source.lastTargets as Record<string, unknown>)) {
          const target = normalizeTarget(value);
          if (target) document.lastTargets[botId] = target;
        }
      }
      if (source.seen && typeof source.seen === 'object') {
        for (const [botId, value] of Object.entries(source.seen as Record<string, unknown>)) {
          if (Array.isArray(value)) {
            document.seen[botId] = value.filter((id): id is string => typeof id === 'string').slice(-SEEN_LIMIT);
          }
        }
      }
      if (source.cursors && typeof source.cursors === 'object') {
        for (const [botId, value] of Object.entries(source.cursors as Record<string, unknown>)) {
          if (typeof value === 'string') document.cursors[botId] = value;
        }
      }
      this.document = document;
    } catch (err) {
      this.logger.error('im: 读取运行状态失败，按空状态启动', {
        file: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
      this.document = { ...EMPTY_DOCUMENT };
    }
  }

  // ---------------------------------------------------------------- 去重

  hasSeen(botId: string, messageId: string): boolean {
    return (this.document.seen[botId] ?? []).includes(messageId);
  }

  markSeen(botId: string, messageId: string): void {
    const list = [...(this.document.seen[botId] ?? []), messageId];
    this.document.seen[botId] = list.slice(-SEEN_LIMIT);
    this.persist();
  }

  // ---------------------------------------------------------------- 绑定

  listBindings(botId: string): ImBinding[] {
    return [...(this.document.bindings[botId] ?? [])];
  }

  isBound(botId: string, userId: string): boolean {
    return (this.document.bindings[botId] ?? []).some(item => item.id === userId);
  }

  bind(botId: string, binding: ImBinding): void {
    const list = this.document.bindings[botId] ?? [];
    if (list.some(item => item.id === binding.id)) return;
    this.document.bindings[botId] = [...list, binding];
    this.persist();
  }

  unbind(botId: string, userId: string): void {
    const list = this.document.bindings[botId] ?? [];
    this.document.bindings[botId] = list.filter(item => item.id !== userId);
    this.persist();
  }

  // ---------------------------------------------------------------- 会话映射

  getConversation(key: string): ImConversation | null {
    return this.document.conversations[key] ?? null;
  }

  setConversation(key: string, value: ImConversation): void {
    this.document.conversations[key] = value;
    this.persist();
  }

  clearConversation(key: string): void {
    if (!this.document.conversations[key]) return;
    delete this.document.conversations[key];
    this.persist();
  }

  // ---------------------------------------------------------------- 最近目标 / 游标

  getLastTarget(botId: string): ImReplyTarget | null {
    return this.document.lastTargets[botId] ?? null;
  }

  setLastTarget(botId: string, target: ImReplyTarget): void {
    this.document.lastTargets[botId] = target;
    this.persist();
  }

  getCursor(botId: string): string {
    return this.document.cursors[botId] ?? '';
  }

  setCursor(botId: string, cursor: string): void {
    if (this.document.cursors[botId] === cursor) return;
    this.document.cursors[botId] = cursor;
    this.persist();
  }

  /** 删除机器人时清理其全部状态（任务本身保留） */
  clearBot(botId: string): void {
    delete this.document.bindings[botId];
    delete this.document.lastTargets[botId];
    delete this.document.seen[botId];
    delete this.document.cursors[botId];
    for (const key of Object.keys(this.document.conversations)) {
      if (key.startsWith(`${botId}:`)) delete this.document.conversations[key];
    }
    this.persist();
  }

  // ---------------------------------------------------------------- 落盘

  private persist(): void {
    const snapshot: ImStateDocument = JSON.parse(JSON.stringify(this.document)) as ImStateDocument;
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writeQueue = operation.then(() => undefined, error => {
      this.logger.warn('im: 写入运行状态失败', { error: error instanceof Error ? error.message : String(error) });
    });
  }
}
