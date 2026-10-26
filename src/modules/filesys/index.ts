// src/modules/filesys/index.ts
// Filesys 模块入口：注册 FilesysService 到 ServiceNames.FILESYS。
// 统一所有模块对文件系统的操作（builtin 工具 + 内部存储 + 终端命令快照检测）。
//
// 依赖：utils 层（fs-atomic/fs）与 core（types），不依赖 file-history/agent/tools 模块
// （terminal-watch 对 file-history 的调用走运行时 tryResolve + 结构类型）。

import { t } from '../../core/i18n';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { FilesysServiceImpl } from './service';
import { DEFAULT_FILESYS_CONFIG, type FilesysConfig } from './types';

export type {
  FilesysService,
  FilesysConfig,
  FileChangeEvent,
  FileChangeKind,
  ReadFileResult,
  WriteFileOptions,
  WriteFileResult,
  TerminalSnapshot,
  TerminalChangeReport,
  TerminalWatchConfig,
} from './types';
export { safeSessionId, readJsonStore, writeJsonStore } from './store-io';
export { hashBuffer, hashText } from './hash';
export { resolveInRoots, normalizeRoots, SYSTEM_SCOPE, systemRoot, isMossAccessAllowed } from './roots';

class FilesysModule implements Module {
  private service: FilesysServiceImpl | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    // 每次调用读最新配置（getAppConfig 为内存深拷贝，低频路径成本可忽略；
    // roots/缓存上限配置修改即生效，无需重启）
    const getConfig = (): FilesysConfig => {
      const cfg = ctx.config.getAppConfig().filesys;
      return cfg ?? DEFAULT_FILESYS_CONFIG;
    };

    const service = new FilesysServiceImpl({
      logger: ctx.logger,
      services: ctx.services,
      getConfig,
    });

    ctx.services.register(ServiceNames.FILESYS, service, {
      scope: 'filesys',
    });
    this.service = service;

    ctx.logger.info(t('filesys.moduleInitialized'), {
      roots: service.listRoots().length,
    });
  }

  /** 模块销毁：关闭实时文件监控 watcher */
  async destroy(): Promise<void> {
    this.service?.dispose();
    this.service = null;
  }
}

export default (): Module => new FilesysModule();
