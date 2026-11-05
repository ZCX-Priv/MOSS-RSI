// src/modules/mcp/index.ts
// MCP Client 模块入口：注册 MCPManager 服务 + 对外派发任务注册表。

import { t } from '../../core/i18n';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { MCPManagerImpl } from './manager';
import { McpTaskRegistry } from './task-registry';

class McpModule implements Module {

  private manager: MCPManagerImpl | null = null;
  /** 对外派发任务注册表（/mcp 与 `moss mcp` 的异步任务状态） */
  private taskRegistry: McpTaskRegistry | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.manager = new MCPManagerImpl({
      config: ctx.config,
      eventBus: ctx.eventBus,
      logger: ctx.logger,
      env: ctx.env,
      services: ctx.services,
    });
    ctx.services.register(ServiceNames.MCP_MANAGER, this.manager, {
      scope: 'mcp',
    });

    // 对外暴露层的任务注册表：请求时按 ServiceNames.MCP_TASK_REGISTRY 解析
    // （server 模块先于本模块初始化，故不能构造期注入）
    this.taskRegistry = new McpTaskRegistry({
      config: ctx.config,
      services: ctx.services,
      logger: ctx.logger,
      env: ctx.env,
    });
    ctx.services.register(ServiceNames.MCP_TASK_REGISTRY, this.taskRegistry, {
      scope: 'mcp',
    });

    // 初始化连接（非阻塞，避免单个 MCP 服务器慢导致模块加载超时）
    this.manager.initialize().catch(err => {
      ctx.logger.error(t('mcp.managerInitFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // 监听配置变更，重载 MCP 服务器。
    // 仅响应 app（config.json）且仅当 MCP 相关配置（mcp 段 / 已弃用的 mcpServers）变化时才重载：
    // 服务器定义主要来自 ~/.moss/mcps/*.json，tools/context/logs 等无关配置不应断开重连所有 MCP 连接。
    const mcpFingerprint = (): string => {
      const cfg = ctx.config.getAppConfig();
      return JSON.stringify({ mcp: cfg.mcp ?? null, mcpServers: cfg.mcpServers ?? null });
    };
    let lastMcpFingerprint = mcpFingerprint();
    ctx.config.onChange((which) => {
      if (which !== 'app') return;
      const next = mcpFingerprint();
      if (next === lastMcpFingerprint) return;
      lastMcpFingerprint = next;
      this.manager?.reloadAll().catch(err => {
        ctx.logger.error(t('mcp.reloadFailed'), {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    ctx.logger.info(t('mcp.moduleInitialized'));
  }

  async destroy(): Promise<void> {
    if (this.manager) {
      await this.manager.shutdown();
    }
    // 中止仍在运行的外部派发任务，避免进程退出时悬挂 run
    this.taskRegistry?.dispose();
  }
}

export default (): Module => new McpModule();
