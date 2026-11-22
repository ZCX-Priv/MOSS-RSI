// src/modules/browser/session-groups.ts
// 会话固定浏览器分组：稳定 group id + 固定名称的持久化。
// Chrome tabGroups 的数字 id 在浏览器重启/组关闭后会变化或消失，
// 因此对外 group_id 使用这里生成的稳定短 id；Chrome groupId 仅运行时绑定。

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { t } from '../../core/i18n';

/** 浏览器分组标题固定前缀 */
export const GROUP_TITLE_PREFIX = 'MOSS - ';

/** 分组名长度范围（Unicode 码点，不含前缀） */
const GROUP_NAME_MIN = 8;
const GROUP_NAME_MAX = 10;

export interface SessionGroupRecord {
  /** MOSS 稳定分组 id（如 g3f9c1a2） */
  id: string;
  /** agent 提供的 8~10 字描述 */
  name: string;
  updatedAt: number;
}

export interface SessionGroupBinding extends SessionGroupRecord {
  sessionId: string;
}

interface PersistedFile {
  version: number;
  groups: Record<string, { id?: unknown; name?: unknown; updatedAt?: unknown }>;
}

/** 生成稳定分组 id：g + 8 位十六进制 */
export function createGroupId(): string {
  return `g${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/**
 * 规范化并校验 agent 提供的分组名：
 * - 去掉首尾空白；
 * - 兼容误传完整标题（自动剥离「MOSS - 」前缀）；
 * - 8~10 个 Unicode 字符，禁止换行/制表。
 * 失败时抛出带具体长度的错误，交由工具层直接回传。
 */
export function normalizeGroupName(raw: string): string {
  const trimmed = raw.trim();
  const name = trimmed.startsWith(GROUP_TITLE_PREFIX)
    ? trimmed.slice(GROUP_TITLE_PREFIX.length).trim()
    : trimmed;
  if (!name || /[\r\n\t]/.test(name)) {
    throw new Error(
      t('browserTool.groupNameInvalid', { count: Array.from(name).length }),
    );
  }
  const length = Array.from(name).length;
  if (length < GROUP_NAME_MIN || length > GROUP_NAME_MAX) {
    throw new Error(t('browserTool.groupNameInvalid', { count: length }));
  }
  return name;
}

/** 会话固定分组持久化（文件位于 <dataDir>/browser/session-groups.json） */
export class SessionGroupStore {
  private readonly filePath: string;
  private records = new Map<string, SessionGroupRecord>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 读取持久化记录；文件损坏时视为空，v1（缺 id）自动补 id 并回写 */
  load(): void {
    let parsed: PersistedFile | null = null;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedFile;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.groups || typeof parsed.groups !== 'object') {
      this.records = new Map();
      return;
    }
    const next = new Map<string, SessionGroupRecord>();
    let migrated = false;
    for (const [sessionId, value] of Object.entries(parsed.groups)) {
      if (!sessionId || !value || typeof value !== 'object') continue;
      const rawName = typeof value.name === 'string' ? value.name.trim() : '';
      if (!rawName) continue;
      let name: string;
      try {
        name = normalizeGroupName(rawName);
      } catch {
        // 历史数据长度不合规：保留原文，避免直接丢失会话绑定
        name = rawName;
      }
      const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : createGroupId();
      if (typeof value.id !== 'string' || !value.id.trim()) migrated = true;
      const updatedAt =
        typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
          ? value.updatedAt
          : Date.now();
      next.set(sessionId, { id, name, updatedAt });
    }
    this.records = next;
    if (migrated) this.persist();
  }

  get(sessionId: string): SessionGroupRecord | null {
    const record = this.records.get(sessionId);
    return record ? { ...record } : null;
  }

  findByGroupId(groupId: string): SessionGroupBinding | null {
    for (const [sessionId, record] of this.records) {
      if (record.id === groupId) return { sessionId, ...record };
    }
    return null;
  }

  list(): SessionGroupBinding[] {
    return Array.from(this.records.entries()).map(([sessionId, record]) => ({
      sessionId,
      ...record,
    }));
  }

  /** 名称是否被其它会话占用 */
  isNameTaken(name: string, exceptSessionId?: string): boolean {
    for (const [sessionId, record] of this.records) {
      if (exceptSessionId && sessionId === exceptSessionId) continue;
      if (record.name === name) return true;
    }
    return false;
  }

  set(sessionId: string, record: SessionGroupRecord): void {
    this.records.set(sessionId, { ...record });
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const groups: PersistedFile['groups'] = {};
      for (const [sessionId, record] of this.records) {
        groups[sessionId] = {
          id: record.id,
          name: record.name,
          updatedAt: record.updatedAt,
        };
      }
      writeFileSync(this.filePath, JSON.stringify({ version: 2, groups }, null, 2), 'utf8');
    } catch {
      // 磁盘不可写不影响内存态；下次分配/重启用旧记录兜底
    }
  }
}
