// src/modules/migration/index.ts
// 数据迁移模块：外部 AI Agent 会话导入 + MOSS 备份导出/恢复。
//
// 落盘分工：
//   - 会话/任务 → agent.engine.importSessions（内存 + 磁盘同步写入，无需重启）
//   - 目录资源（skills/mcps/commands/memory/todo/prompts/agenteam）→ 文件级合并
//   - 配置 → config 服务（app 顶层键合并 / api providers 按 id 合并）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Module, ModuleContext, AppConfig, ApiConfig } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { Session } from '../agent/session';
import { ErrorCode } from '../../core/error-codes';
import { MIN_PASSWORD_LENGTH, encryptBackup, isEncryptedBackup, unwrapBackup } from './crypto';
import { MigrationError } from './errors';
import { MERGEABLE_CONFIG_KEYS, type BackupManifest } from './manifest';
import {
  buildManifest,
  collectBackupEntries,
  countBackupEntries,
  mergeResourceEntries,
  parseBackupSessions,
  readConfigEntry,
  readManifestFromEntries,
  unzipEntries,
  zipEntries,
  CONFIG_ENTRY_PATHS,
  type BackupSessionItem,
} from './backup';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { CodexAdapter } from './adapters/codex';
import { convertTranscript } from './adapters/convert';
import type { ExternalSessionMeta, ExternalSourceId, SessionAdapter } from './adapters/types';

/** 导入结果（外部 Agent 与备份恢复共用） */
export interface ImportResult {
  imported: number;
  sessions: Array<{ title: string; groupName: string; messageCount: number }>;
  skipped: Array<{ name: string; reason: 'exists' | 'imported-before' | 'empty' | 'invalid' }>;
  warnings: string[];
}

/** 数据源探测结果 */
export interface MigrationSourceInfo {
  id: ExternalSourceId;
  label: string;
  rootDir: string;
  available: boolean;
  sessionCount: number;
}

/** 备份包检查结果 */
export interface BackupInspection {
  manifest: BackupManifest;
  counts: Record<string, number>;
  encrypted: boolean;
  sessions: number;
}

/** agent.engine 的导入扩展面（未实现时安全降级） */
interface AgentEngineImportExt {
  listTaskGroups?: () => Array<{ id: string; name: string }>;
  createTaskGroup?: (name: string, source?: 'folder' | 'manual') => { id: string; name: string };
  importSessions?: (
    items: Array<{ id: string; title: string; groupId: string; session: Session }>,
  ) => { imported: number; skipped: string[] };
}

interface ImportedMap {
  version: number;
  entries: Record<string, string>;
}

/** 默认备份目录：~/.moss/backups */
const BACKUP_DIR_NAME = 'backups';
/** 导入去重记录目录：~/.moss/migration */
const STATE_DIR_NAME = 'migration';

export class MigrationService {
  private readonly adapters: Map<ExternalSourceId, SessionAdapter>;
  /** 本进程本次导出过的文件（下载接口白名单，防止任意文件读取） */
  private readonly allowedDownloads = new Set<string>();

  constructor(
    private readonly deps: {
      dataDir: string;
      config: { getAppConfig(): AppConfig; getApiConfig(): ApiConfig; updateAppConfig(patch: Partial<AppConfig>): Promise<void>; updateApiConfig(patch: Partial<ApiConfig>): Promise<void> };
      tryResolveEngine: () => AgentEngineImportExt | null;
    },
  ) {
    this.adapters = new Map<ExternalSourceId, SessionAdapter>([
      ['claude-code', new ClaudeCodeAdapter()],
      ['codex', new CodexAdapter()],
    ]);
  }

  // ==========================================================================
  // 外部 Agent 导入
  // ==========================================================================

  listSources(): MigrationSourceInfo[] {
    return Array.from(this.adapters.values()).map((adapter) => {
      const available = adapter.available();
      let sessionCount = 0;
      if (available) {
        try {
          sessionCount = adapter.list().length;
        } catch {
          sessionCount = 0;
        }
      }
      return {
        id: adapter.id,
        label: adapter.label,
        rootDir: adapter.rootDir,
        available,
        sessionCount,
      };
    });
  }

  listExternal(source: string): ExternalSessionMeta[] {
    return this.adapterOf(source).list();
  }

  importExternal(source: string, sourceIds: string[]): ImportResult {
    const adapter = this.adapterOf(source);
    const engine = this.engine();
    const dedupe = this.readDedupe();
    const result: ImportResult = { imported: 0, sessions: [], skipped: [], warnings: [] };

    // 未指定 id 时导入该来源全部会话（前端「全选」快速路径）
    const targets = sourceIds.length > 0 ? sourceIds : adapter.list().map((s) => s.sourceId);
    const items: Array<{ id: string; title: string; groupId: string; session: Session }> = [];
    const pendingKeys: Array<{ key: string; sessionId: string }> = [];

    for (const sourceId of targets) {
      const dedupeKey = `${adapter.id}:${sourceId}`;
      if (dedupe.entries[dedupeKey]) {
        result.skipped.push({ name: sourceId, reason: 'imported-before' });
        continue;
      }
      const transcript = adapter.read(sourceId);
      if (!transcript) {
        result.skipped.push({ name: sourceId, reason: 'invalid' });
        continue;
      }
      // 无真实用户输入的会话没有导入价值（只有系统注入/空轮次）
      if (!transcript.messages.some((m) => m.role === 'user' && m.content.trim().length > 0)) {
        result.skipped.push({ name: transcript.meta.title || sourceId, reason: 'empty' });
        continue;
      }
      if (transcript.warnings.length > 0) {
        result.warnings.push(...transcript.warnings.map((w) => `${transcript.meta.title}: ${w}`));
      }
      const converted = convertTranscript(transcript, adapter.label);
      const groupId = this.resolveGroupId(engine, converted.groupName);
      if (!groupId) {
        result.skipped.push({ name: transcript.meta.title, reason: 'invalid' });
        continue;
      }
      items.push({
        id: converted.session.id,
        title: converted.title,
        groupId,
        session: converted.session,
      });
      pendingKeys.push({ key: dedupeKey, sessionId: converted.session.id });
      result.sessions.push({
        title: converted.title,
        groupName: converted.groupName,
        messageCount: converted.session.messages.length,
      });
    }

    if (items.length > 0) {
      const written = engine.importSessions(items);
      result.imported = written.imported;
      for (const skippedId of written.skipped) {
        result.skipped.push({ name: skippedId, reason: 'exists' });
      }
      // 仅记录真正落盘的会话，避免失败项被标记为「已导入」
      const writtenIds = new Set(items.map((i) => i.id).filter((id) => !written.skipped.includes(id)));
      for (const pending of pendingKeys) {
        if (writtenIds.has(pending.sessionId)) dedupe.entries[pending.key] = pending.sessionId;
      }
      this.writeDedupe(dedupe);
    }

    return result;
  }

  // ==========================================================================
  // MOSS 备份：导出
  // ==========================================================================

  defaultBackupPath(): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    return join(this.deps.dataDir, BACKUP_DIR_NAME, `moss-backup-${stamp}.mossbak`);
  }

  async exportBackup(opts: { targetPath: string; password: string; includeSecrets: boolean }): Promise<{
    path: string;
    bytes: number;
    counts: Record<string, number>;
  }> {
    const targetPath = this.assertAbsolutePath(opts.targetPath, ErrorCode.MIGRATION_PATH_REQUIRED);
    if (opts.password.length < MIN_PASSWORD_LENGTH) {
      throw new MigrationError(ErrorCode.MIGRATION_PASSWORD_REQUIRED);
    }

    const entries = collectBackupEntries({
      dataDir: this.deps.dataDir,
      appConfig: this.deps.config.getAppConfig(),
      apiConfig: this.deps.config.getApiConfig(),
      includeSecrets: opts.includeSecrets,
    });
    const counts = countBackupEntries(entries);
    const zip = await zipEntries(entries, buildManifest(counts));
    const encrypted = encryptBackup(zip, opts.password);

    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, encrypted);
    this.allowedDownloads.add(targetPath);

    return { path: targetPath, bytes: encrypted.length, counts };
  }

  /** 下载白名单校验（仅允许本进程本次导出过的文件） */
  isDownloadAllowed(path: string): boolean {
    return this.allowedDownloads.has(path);
  }

  // ==========================================================================
  // MOSS 备份：检查与导入
  // ==========================================================================

  async inspectBackup(opts: { path: string; password?: string }): Promise<BackupInspection> {
    const filePath = this.assertAbsolutePath(opts.path, ErrorCode.MIGRATION_PATH_REQUIRED);
    const raw = this.readArchive(filePath);
    const payload = unwrapBackup(raw, opts.password);
    const entries = await unzipEntries(payload);
    const manifest = readManifestFromEntries(entries);
    return {
      manifest: manifest ?? buildManifest({}),
      counts: manifest?.counts ?? {},
      encrypted: isEncryptedBackup(raw),
      sessions: parseBackupSessions(entries).length,
    };
  }

  async importBackup(opts: { path: string; password?: string; dryRun?: boolean }): Promise<ImportResult> {
    const filePath = this.assertAbsolutePath(opts.path, ErrorCode.MIGRATION_PATH_REQUIRED);
    const raw = this.readArchive(filePath);
    const entries = await unzipEntries(unwrapBackup(raw, opts.password));
    const sessions = parseBackupSessions(entries);
    const result: ImportResult = { imported: 0, sessions: [], skipped: [], warnings: [] };

    const engine = this.engine();
    for (const item of sessions) {
      result.sessions.push({
        title: item.title,
        groupName: item.groupName,
        messageCount: item.session.messages.length,
      });
    }

    if (opts.dryRun) {
      result.imported = sessions.length;
      return result;
    }

    // 1) 会话热写入
    if (sessions.length > 0) {
      const items = sessions
        .map((item: BackupSessionItem) => {
          const groupId = this.resolveGroupId(engine, item.groupName);
          return groupId
            ? { id: item.sessionId, title: item.title, groupId, session: item.session }
            : null;
        })
        .filter((v): v is { id: string; title: string; groupId: string; session: Session } => v !== null);
      const written = engine.importSessions(items);
      result.imported = written.imported;
      for (const skippedId of written.skipped) {
        result.skipped.push({ name: skippedId, reason: 'exists' });
      }
    }

    // 2) 目录资源合并（目标已存在即跳过）
    const merged = mergeResourceEntries(entries, this.deps.dataDir);
    for (const file of merged.skipped) {
      result.skipped.push({ name: file, reason: 'exists' });
    }

    // 3) 配置合并
    const appConfig = readConfigEntry<Record<string, unknown>>(entries, CONFIG_ENTRY_PATHS.app);
    if (appConfig) await this.mergeAppConfig(appConfig);
    const apiConfig = readConfigEntry<{ providers?: unknown[] }>(entries, CONFIG_ENTRY_PATHS.api);
    if (apiConfig) await this.mergeApiConfig(apiConfig);

    return result;
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  private adapterOf(source: string): SessionAdapter {
    const adapter = this.adapters.get(source as ExternalSourceId);
    if (!adapter) throw new MigrationError(ErrorCode.MIGRATION_SOURCE_INVALID);
    return adapter;
  }

  private engine(): AgentEngineImportExt & Required<Pick<AgentEngineImportExt, 'importSessions'>> {
    const engine = this.deps.tryResolveEngine();
    if (!engine?.importSessions) {
      throw new MigrationError(ErrorCode.MIGRATION_SERVICE_UNAVAILABLE);
    }
    return engine as AgentEngineImportExt & Required<Pick<AgentEngineImportExt, 'importSessions'>>;
  }

  /** 同名分组复用，否则新建 manual 分组 */
  private resolveGroupId(engine: AgentEngineImportExt, name: string): string | null {
    const target = name.trim();
    const existing = (engine.listTaskGroups?.() ?? []).find((g) => g.name.trim() === target);
    if (existing) return existing.id;
    return engine.createTaskGroup?.(target, 'manual')?.id ?? null;
  }

  private assertAbsolutePath(raw: string, emptyCode: string): string {
    const path = raw?.trim();
    if (!path) throw new MigrationError(emptyCode);
    if (!isAbsolute(path)) throw new MigrationError(ErrorCode.MIGRATION_PATH_INVALID);
    return path;
  }

  private readArchive(filePath: string): Uint8Array {
    if (!existsSync(filePath)) throw new MigrationError(ErrorCode.MIGRATION_FILE_NOT_FOUND);
    try {
      return readFileSync(filePath);
    } catch {
      throw new MigrationError(ErrorCode.MIGRATION_FILE_NOT_FOUND);
    }
  }

  private dedupePath(): string {
    return join(this.deps.dataDir, STATE_DIR_NAME, 'imported.json');
  }

  private readDedupe(): ImportedMap {
    const path = this.dedupePath();
    if (!existsSync(path)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ImportedMap>;
      return {
        version: 1,
        entries: parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {},
      };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private writeDedupe(map: ImportedMap): void {
    const path = this.dedupePath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(map, null, 2));
    } catch {
      // 记录失败不影响已导入数据（下次导入会当作新会话，用户可自行删除）
    }
  }

  /** 配置顶层键合并：本地已存在（非 undefined）的键一律跳过，保留目标机现状 */
  private async mergeAppConfig(incoming: Record<string, unknown>): Promise<void> {
    const current = this.deps.config.getAppConfig() as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!MERGEABLE_CONFIG_KEYS.has(key)) continue;
      if (current[key] !== undefined) continue;
      if (value === undefined) continue;
      patch[key] = value;
    }
    if (Object.keys(patch).length > 0) {
      await this.deps.config.updateAppConfig(patch as Partial<AppConfig>);
    }
  }

  /** 服务商合并：按 provider id 去重（已存在跳过），currentModel 等选择项不动 */
  private async mergeApiConfig(incoming: { providers?: unknown[] }): Promise<void> {
    const incomingProviders = Array.isArray(incoming.providers) ? incoming.providers : [];
    if (incomingProviders.length === 0) return;
    const current = this.deps.config.getApiConfig();
    const existingIds = new Set(current.providers.map((p) => p.id));
    const additions = incomingProviders.filter((p): p is { id: string } => {
      if (!p || typeof p !== 'object') return false;
      const id = (p as { id?: unknown }).id;
      return typeof id === 'string' && id.length > 0 && !existingIds.has(id);
    });
    if (additions.length === 0) return;
    await this.deps.config.updateApiConfig({
      version: current.version,
      providers: [...current.providers, ...(additions as unknown as ApiConfig['providers'])],
    });
  }
}

class MigrationModule implements Module {
  private service: MigrationService | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.service = new MigrationService({
      dataDir: ctx.env.dataDir,
      config: ctx.config,
      tryResolveEngine: () => ctx.services.tryResolve<AgentEngineImportExt>(ServiceNames.AGENT_ENGINE),
    });
    ctx.services.register(ServiceNames.MIGRATION, this.service, { scope: 'migration' });
  }

  async destroy(): Promise<void> {
    this.service = null;
  }
}

export default (): Module => new MigrationModule();
