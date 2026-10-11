// src/modules/terminal/index.ts
// Terminal 模块入口：注册 TerminalService 到 ServiceNames.TERMINAL。
// 提供持久终端（原生 PTY）能力：WS 提供人类交互，terminal 工具提供 agent 操作，二者共用同一批终端。
//
// 依赖：utils/core 与 filesys（cwd 边界由调用方经 filesys.resolve 校验）；不依赖 server/agent
// （输出投递经运行时 tryResolve(SERVER_INSTANCE) 惰性解析，避免初始化顺序耦合）。

import { t } from '../../core/i18n';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { ServerInstance } from '../server/types';
import { TerminalManager } from './service';

class TerminalModule implements Module {
  async initialize(ctx: ModuleContext): Promise<void> {
    const manager = new TerminalManager({
      logger: ctx.logger,
      isWindows: ctx.env.isWindows,
      // 终端元数据 + 输出缓冲落盘目录（~/.moss/terminals）：进程重启后仍可还原标签与历史
      dataDir: ctx.env.dataDir,
      // 惰性解析 SERVER_INSTANCE：模块初始化顺序无关；未注册时静默丢弃（无 WS 场景）
      emitter: (sessionId, message) => {
        try {
          const server = ctx.services.tryResolve<ServerInstance>(ServiceNames.SERVER_INSTANCE);
          server?.sendToSession(sessionId, message);
        } catch {
          // 投递失败不影响终端运行
        }
      },
    });

    ctx.services.register(ServiceNames.TERMINAL, manager, {
      scope: 'terminal',
    });

    ctx.logger.info(t('terminal.moduleInitialized'));
  }
}

export default (): Module => new TerminalModule();