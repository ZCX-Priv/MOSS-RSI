// src/modules/file-history/index.ts
// FileHistory 模块入口：实现三层文件历史架构（Track Edit + Snapshot + JSONL）。
// 注册 FileHistoryService 到 ServiceNames.FILE_HISTORY，供 write/edit/delete/read/undo 工具消费。
//
// 启动性能：initialize 只注册服务；目录迁移与过期备份清理放到 warmup（后台、幂等）。

import { t } from '../../core/i18n';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { FileHistoryServiceImpl } from './service';
import { migrateLegacyLayout } from './migrate';
import { DEFAULT_FILE_HISTORY_CONFIG, type FileHistoryConfig } from './types';

// 导出 trash 与 archive 模块，供 delete 工具直接调用
export { moveToTrash, cleanupExpiredTrash, TRASH_RETENTION_DAYS } from './trash';
export type { TrashEntry } from './trash';
export { archiveDirectory, extractArchive } from './archive';
export type { ArchiveResult } from './archive';

class FileHistoryModule implements Module {
  private ctx!: ModuleContext;
  private service!: FileHistoryServiceImpl | null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const config = this.readConfig(ctx);
    // 先注册服务：写工具首次调用即可用（幂等迁移在 warmup 中后台完成）
    this.service = new FileHistoryServiceImpl(ctx.env, ctx.logger, config);
    ctx.services.register(ServiceNames.FILE_HISTORY, this.service, {
      scope: 'file-history',
    });

    // 监听 config 变更（简化：不重建 service 实例，当前实现变更后需重启生效）
    ctx.eventBus.onAction('config:changed', () => {
      ctx.logger.debug(t('fileHistory.configChangedReloadSkipped'));
    });

    ctx.logger.info(t('fileHistory.moduleInitialized'), {
      enabled: config.enabled,
      transcriptEnabled: config.transcriptEnabled,
    });
  }

  /** 后台预热：目录布局迁移 + 过期备份清理（启动路径零成本） */
  async warmup(ctx: ModuleContext): Promise<void> {
    try {
      const migration = migrateLegacyLayout(ctx.env, ctx.logger);
      if (migration.movedDirs.length > 0 || migration.movedTranscripts > 0) {
        ctx.logger.info(t('fileHistory.layoutMigrated', {
          dirs: migration.movedDirs.join(', '),
          transcripts: migration.movedTranscripts,
          rewrites: migration.rewroteEntries,
        }));
      }
    } catch (err) {
      ctx.logger.warn(t('fileHistory.layoutMigrationFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.service?.cleanupExpiredBackups();
    } catch (err) {
      ctx.logger.warn(t('fileHistory.cleanupFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    ctx.logger.info('fileHistory: warmup completed');
  }

  /** 从 config 读取 fileHistory 配置（容错：缺失字段用默认值兜底） */
  private readConfig(ctx: ModuleContext): FileHistoryConfig {
    const app = ctx.config.getAppConfig();
    const fh = app.fileHistory;
    if (!fh) {
      return { ...DEFAULT_FILE_HISTORY_CONFIG };
    }
    return {
      enabled: fh.enabled ?? DEFAULT_FILE_HISTORY_CONFIG.enabled,
      maxBackupsPerFile: fh.maxBackupsPerFile ?? DEFAULT_FILE_HISTORY_CONFIG.maxBackupsPerFile,
      transcriptEnabled: fh.transcriptEnabled ?? DEFAULT_FILE_HISTORY_CONFIG.transcriptEnabled,
      backupRetentionDays: fh.backupRetentionDays ?? DEFAULT_FILE_HISTORY_CONFIG.backupRetentionDays,
    };
  }

  async destroy(): Promise<void> {
    // 内存 ledger 自然随进程退出释放，无需特殊处理
  }
}

export default (): Module => new FileHistoryModule();
