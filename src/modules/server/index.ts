// src/modules/server/index.ts
// Server 模块入口：基于 Bun.serve 启动 HTTP + WebSocket 服务。

import { t } from '../../core/i18n';
import { isDevMode } from '../../core/env';
import type { Module, ModuleContext } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { HttpRouter } from './http-router';
import { WsHandler } from './ws-handler';
import { StaticAssets } from './static-assets';
import type { ServerInstance, Route, WSMessageHandler, WSConnection, RequestGuard, GuardRequestContext, GuardResponse } from './types';
import { createHealthHandler } from './routes/health';
import {
  createGetAppConfigHandler,
  createUpdateAppConfigHandler,
  createGetApiConfigHandler,
  createUpdateApiConfigHandler,
} from './routes/config';
import {
  createListSessionsHandler,
  createDeleteSessionHandler,
  createSessionHistoryHandler,
  createSessionStateHandler,
} from './routes/session';
import {
  createListMcpServersHandler,
  createListMcpToolsHandler,
  createCallMcpToolHandler,
  createConnectMcpServerHandler,
  createDisconnectMcpServerHandler,
  createCreateMcpServerHandler,
  createUpdateMcpServerHandler,
  createDeleteMcpServerHandler,
} from './routes/mcp';
import {
  createListSkillsHandler,
  createGetSkillHandler,
  createUpdateSkillHandler,
  createCreateSkillHandler,
  createImportSkillHandler,
} from './routes/skills';
import {
  createListCommandsHandler,
  createCreateCommandHandler,
  createUpdateCommandHandler,
  createDeleteCommandHandler,
  createToggleCommandHandler,
} from './routes/commands';
import { createListToolsHandler, createUpdateToolHandler } from './routes/tools';
import { createVersionHandler } from './routes/version';
import {
  createListProvidersHandler,
  createSetCurrentModelHandler,
  createSetCurrentSearchProviderHandler,
  createCreateProviderHandler,
  createUpdateProviderHandler,
  createDeleteProviderHandler,
  createReorderProvidersHandler,
  createAddProviderModelsHandler,
  createUpdateProviderModelHandler,
  createDeleteProviderModelHandler,
  createTestProviderModelHandler,
  createFetchProviderModelsHandler,
  createProviderBalanceHandler,
  createAddProviderServiceHandler,
  createUpdateProviderServiceHandler,
  createDeleteProviderServiceHandler,
} from './routes/providers';
import { createListTodosHandler, createReplaceTodosHandler } from './routes/todos';
import {
  createLogFilesHandler,
  createQueryLogsHandler,
  createCleanupLogsHandler,
} from './routes/logs';
import { createTruncatePreviewHandler, createTruncateHandler, createTruncateRestoreHandler } from './routes/truncate';
import {
  createListFileHistoryHandler,
  createUndoFileHistoryHandler,
  createRestoreFileHistoryHandler,
} from './routes/file-history';
import { createSessionContextHandler } from './routes/session-context';
import {
  createListTasksHandler,
  createCreateTaskHandler,
  createGetTaskHandler,
  createUpdateTaskHandler,
  createDeleteTaskHandler,
  createReorderTasksHandler,
  createListTaskGroupsHandler,
  createCreateTaskGroupHandler,
  createUpdateTaskGroupHandler,
  createDeleteTaskGroupHandler,
} from './routes/tasks';
import { createSearchHandler } from './routes/search';
import {
  createListAgentsHandler,
  createCreateAgentHandler,
  createGetAgentHandler,
  createUpdateAgentHandler,
  createDeleteAgentHandler,
  createSetDefaultAgentHandler,
} from './routes/agenteam';
import {
  createListAgenteamsHandler,
  createGetAgenteamHandler,
  createGetAgenteamMessagesHandler,
  createCreateAgenteamHandler,
  createApproveAgenteamHandler,
  createDiscardAgenteamHandler,
  createHaltAgenteamHandler,
  createResumeAgenteamHandler,
  createDeleteAgenteamHandler,
  createListAgenteamProfilesHandler,
  createSaveAgenteamProfileHandler,
  createDeleteAgenteamProfileHandler,
  createRunSubagentHandler,
} from './routes/agenteams';
import { createListAutomationsHandler,
  createCreateAutomationHandler,
  createGetAutomationHandler,
  createUpdateAutomationHandler,
  createDeleteAutomationHandler,
  createTriggerAutomationHandler,
  createPauseAutomationHandler,
  createResumeAutomationHandler,
  createAutomationHistoryHandler,
} from './routes/automations';
import {
  createSuggestPathsHandler,
  createPickFileHandler,
  createSaveAttachmentHandler,
  createSearchFilesHandler,
  createListDirectoryHandler,
  createListDrivesHandler,
  createGetRootsHandler,
  createUpdateRootsHandler,
  createReadFileHandler,
  createMediaHandler,
  createTextExtractHandler,
} from './routes/filesystem';
import { createListInterpretersHandler } from './routes/terminal';
import {
  createContextStatsHandler,
  createContextCompactionsHandler,
  createCompactPreviewHandler,
  createManualCompactHandler,
  createSummaryModelsHandler,
  createFileIndexStatusHandler,
  createFileIndexRebuildHandler,
} from './routes/context';
import {
  createListRulesHandler,
  createCreateRuleHandler,
  createGetRuleHandler,
  createUpdateRuleHandler,
  createDeleteRuleHandler,
} from './routes/rules';
import {
  createListHooksHandler,
  createCreateHookHandler,
  createGetHookHandler,
  createUpdateHookHandler,
  createDeleteHookHandler,
  createTestHookHandler,
  createHookHistoryHandler,
} from './routes/hooks';
import {
  createMemoryTreeHandler,
  createListMemoryHandler,
  createCreateMemoryHandler,
  createGetMemoryHandler,
  createUpdateMemoryHandler,
  createDeleteMemoryHandler,
  createDistillMemoryHandler,
} from './routes/memory';
import {
  createVoiceStatusHandler,
  createVoiceModelsHandler,
  createVoiceEnableHandler,
  createVoiceSetDefaultModelHandler,
  createVoiceSetProviderHandler,
  createVoiceInstallHandler,
  createVoiceUninstallHandler,
} from './routes/voice';
import { McpExpose } from '../mcp/expose';
import type { AgentEvent } from '../contracts';

interface BunServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
  upgrade(
    req: Request,
    options?: { data?: unknown; headers?: Record<string, string> },
  ): boolean;
  /** Bun.serve 实例方法：解析请求的客户端地址（实测 Bun 1.3 Windows 可用） */
  requestIP(req: Request): { address: string; port: number; family: string };
}

interface BunWebSocket {
  send(text: string): void;
  close(): void;
  // 用户数据存储（upgrade 时传入的 data）
  __conn?: WSConnection;
  __id?: string;
}

class ServerModule implements Module {

  private ctx!: ModuleContext;
  private router!: HttpRouter;
  private wsHandler!: WsHandler;
  private assets!: StaticAssets;
  private mcpExpose!: McpExpose;
  /** 请求门卫（remote 模块注入；null 时零开销直通） */
  private guard: RequestGuard | null = null;
  private server: BunServer | null = null;
  private actualPort = 0;
  private actualHost = '127.0.0.1';
  /** 热重绑互斥（并发 rebind 串行化） */
  private rebinding: Promise<void> | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.assets = new StaticAssets(ctx.env);
    this.router = new HttpRouter(ctx.config, ctx.logger, this.assets);
    this.wsHandler = new WsHandler(ctx.services, ctx.logger);
    this.mcpExpose = new McpExpose({ config: ctx.config, services: ctx.services, logger: ctx.logger });

    this.registerRoutes();

    await this.startServer();

    // 注册 ServerInstance 服务（host/baseUrl 用 getter：热重绑后动态反映最新绑定）
    const self = this;
    const instance: ServerInstance = {
      get raw() { return self.server; },
      get host() { return self.actualHost; },
      get port() { return self.actualPort; },
      get baseUrl() { return `http://${self.actualHost}:${self.actualPort}`; },
      addRoute: (route: Route) => this.router.addRoute(route),
      broadcastWS: (msg: unknown) => this.wsHandler.broadcast(msg),
      sendToSession: (sid: string, msg: unknown) => this.wsHandler.sendToSession(sid, msg),
      sendAgentEvent: (sid: string, event: AgentEvent) => this.wsHandler.sendAgentEvent(sid, event),
      registerExternalRun: (sid: string, c: AbortController) => this.wsHandler.registerExternalRun(sid, c),
      unregisterExternalRun: (sid: string, c: AbortController) => this.wsHandler.unregisterExternalRun(sid, c),
      isSessionRunning: (sid: string) => this.wsHandler.isSessionRunning(sid),
      onWSMessage: (h: WSMessageHandler) => this.wsHandler.onWSMessage(h),
      setRequestGuard: (guard: RequestGuard) => { this.guard = guard; },
      rebind: (hostname: string) => this.rebind(hostname),
      stop: async () => {
        if (this.server) await this.server.stop();
      },
    };
    ctx.services.register(ServiceNames.SERVER_INSTANCE, instance, {
      scope: 'server',
    });

    // 阶段5.3：订阅 config:changed 事件，转发为 WS config.changed
    // 通过 EventBus 解耦，避免 config-service / kernel 直接依赖 server.instance（循环依赖）
    ctx.eventBus.onAction('config:changed', (data) => {
      this.wsHandler.broadcast({ type: 'config.changed', payload: data });
      // 文件索引配置热重载：开关变化 → 引擎启停（context 引擎缺失时静默跳过）
      const contextEngine = ctx.services.tryResolve<{
        onFileIndexConfigChanged(): Promise<void>;
      }>(ServiceNames.CONTEXT_ENGINE);
      if (contextEngine) {
        void contextEngine.onFileIndexConfigChanged().catch(() => {
          // 配置热重载失败不影响主流程
        });
      }
    });
    // 资源文件（skill/spec/tool）热重载事件，转发为 WS resources.changed
    ctx.eventBus.onAction('resources:changed', (data) => {
      this.wsHandler.broadcast({ type: 'resources.changed', payload: data });
    });
    // MCP 连接状态变化（后台连接完成/断开/失败），转发为 WS mcp.status
    // 前端 useMcp 监听后自动刷新列表（启动后台连接完成时无需手动刷新）
    ctx.eventBus.onAction('mcp:server:connected', (data) => {
      this.wsHandler.broadcast({ type: 'mcp.status', payload: data });
    });
    ctx.eventBus.onAction('mcp:server:disconnected', (data) => {
      this.wsHandler.broadcast({ type: 'mcp.status', payload: data });
    });
    ctx.eventBus.onAction('mcp:server:error', (data) => {
      this.wsHandler.broadcast({ type: 'mcp.status', payload: data });
    });
    // agenteam 编排事件：团队状态变化（前端专家团标签页监听后拉取刷新）
    ctx.eventBus.onAction('agenteam:team-changed', (data) => {
      this.wsHandler.broadcast({ type: 'agenteam.team.changed', payload: data });
    });
    // agenteam 成员事件（成员 run 的 agent 事件流；专家团面板展示活动摘要）
    ctx.eventBus.onAction('agenteam:member-event', (data) => {
      this.wsHandler.broadcast({ type: 'agenteam.member.event', payload: data });
    });

    ctx.logger.info(t('server.started', { host: this.actualHost, port: this.actualPort }), {
      staticAssets: this.assets.isAvailable(),
    });
  }

  async destroy(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.ctx.logger.info(t('server.stopped'));
    }
  }

  // ========================================================================

  private registerRoutes(): void {
    const { config, services, env } = this.ctx;

    this.router.addRoute({ method: 'GET', pattern: '/api/health', handler: createHealthHandler(services), auth: false });
    this.router.addRoute({ method: 'GET', pattern: '/api/version', handler: createVersionHandler(env), auth: false });

    this.router.addRoute({ method: 'GET', pattern: '/api/config', handler: createGetAppConfigHandler(config), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/config', handler: createUpdateAppConfigHandler(config), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/api-config', handler: createGetApiConfigHandler(config), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/api-config', handler: createUpdateApiConfigHandler(config), auth: true });

    this.router.addRoute({ method: 'GET', pattern: '/api/session', handler: createListSessionsHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/session/:id', handler: createDeleteSessionHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/session/:id', handler: createSessionHistoryHandler(services), auth: true });
    // 会话状态快照（运行态 + 流式草稿 + 待答/待确认）：刷新/重连后「不丢状态」的唯一入口
    this.router.addRoute({ method: 'GET', pattern: '/api/session/:id/state', handler: createSessionStateHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/sessions/:id/context', handler: createSessionContextHandler(services, config), auth: true });

    // 消息撤回（截断）：预览 + 执行 + 恢复（redo）
    this.router.addRoute({ method: 'GET', pattern: '/api/sessions/:id/truncate-preview', handler: createTruncatePreviewHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/sessions/:id/truncate', handler: createTruncateHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/sessions/:id/truncate-restore', handler: createTruncateRestoreHandler(services), auth: true });

    this.router.addRoute({ method: 'GET', pattern: '/api/mcp/servers', handler: createListMcpServersHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/mcp/tools', handler: createListMcpToolsHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/mcp/call', handler: createCallMcpToolHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/mcp/connect', handler: createConnectMcpServerHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/mcp/disconnect', handler: createDisconnectMcpServerHandler(services), auth: true });
    // MCP 服务器定义 CRUD（含 enabled 启停切换）
    this.router.addRoute({ method: 'POST', pattern: '/api/mcp/servers', handler: createCreateMcpServerHandler(services), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/mcp/servers/:name', handler: createUpdateMcpServerHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/mcp/servers/:name', handler: createDeleteMcpServerHandler(services), auth: true });

    // skills
    this.router.addRoute({ method: 'GET', pattern: '/api/skills', handler: createListSkillsHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/skills/:name', handler: createGetSkillHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/skills/:name', handler: createUpdateSkillHandler(services, config), auth: true });
    // skills 新建 / zip 导入（前端解包后批量写文件；目录 watch 热重载自动生效）
    this.router.addRoute({ method: 'POST', pattern: '/api/skills', handler: createCreateSkillHandler(services, env), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/skills/import', handler: createImportSkillHandler(services, env), auth: true });
    // commands（自定义斜杠命令：~/.moss/commands/<name>.md）
    this.router.addRoute({ method: 'GET', pattern: '/api/commands', handler: createListCommandsHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/commands', handler: createCreateCommandHandler(services, env), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/commands/:name', handler: createUpdateCommandHandler(services, env), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/commands/:name', handler: createDeleteCommandHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/commands/:name', handler: createToggleCommandHandler(services, config), auth: true });

    // tools（工具元信息 + 可编辑参数定义；PATCH 更新 config.tools[name] 热生效）
    this.router.addRoute({ method: 'GET', pattern: '/api/tools', handler: createListToolsHandler(services, config), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/tools/:name', handler: createUpdateToolHandler(services, config), auth: true });

    // providers（服务商 + 旗下模型；静态路由先于 :id 参数路由注册）
    this.router.addRoute({ method: 'GET', pattern: '/api/providers', handler: createListProvidersHandler(config), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/providers/current', handler: createSetCurrentModelHandler(config), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/providers/search-current', handler: createSetCurrentSearchProviderHandler(config), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/providers/reorder', handler: createReorderProvidersHandler(config), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/providers', handler: createCreateProviderHandler(config), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/providers/:id', handler: createUpdateProviderHandler(config), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/providers/:id', handler: createDeleteProviderHandler(config), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/providers/:id/models', handler: createAddProviderModelsHandler(config), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/providers/:id/models/fetch', handler: createFetchProviderModelsHandler(config, this.ctx.logger), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/providers/:id/balance', handler: createProviderBalanceHandler(config, this.ctx.logger), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/providers/:id/models/:modelId/test', handler: createTestProviderModelHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/providers/:id/models/:modelId', handler: createUpdateProviderModelHandler(config), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/providers/:id/models/:modelId', handler: createDeleteProviderModelHandler(config), auth: true });
    // services（服务商附加服务，当前仅文件存储）
    this.router.addRoute({ method: 'POST', pattern: '/api/providers/:id/services', handler: createAddProviderServiceHandler(config), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/providers/:id/services/:serviceId', handler: createUpdateProviderServiceHandler(config), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/providers/:id/services/:serviceId', handler: createDeleteProviderServiceHandler(config), auth: true });

    // todos
    this.router.addRoute({ method: 'GET', pattern: '/api/todos/:sessionId', handler: createListTodosHandler(env), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/todos/:sessionId', handler: createReplaceTodosHandler(env), auth: true });

    // file-history（文件历史：列出 + 撤销 + 恢复）
    this.router.addRoute({ method: 'GET', pattern: '/api/file-history/:sessionId', handler: createListFileHistoryHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/file-history/:sessionId/undo', handler: createUndoFileHistoryHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/file-history/:sessionId/restore', handler: createRestoreFileHistoryHandler(services), auth: true });

    // tasks + 分组
    this.router.addRoute({ method: 'GET', pattern: '/api/tasks', handler: createListTasksHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/tasks', handler: createCreateTaskHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/tasks/:id', handler: createGetTaskHandler(services, env), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/tasks/:id', handler: createUpdateTaskHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/tasks/:id', handler: createDeleteTaskHandler(services), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/tasks/reorder', handler: createReorderTasksHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/task-groups', handler: createListTaskGroupsHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/task-groups', handler: createCreateTaskGroupHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/task-groups/:id', handler: createUpdateTaskGroupHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/task-groups/:id', handler: createDeleteTaskGroupHandler(services), auth: true });

    // 搜索
    this.router.addRoute({ method: 'GET', pattern: '/api/search', handler: createSearchHandler(services), auth: true });

    // agenteam
    this.router.addRoute({ method: 'GET', pattern: '/api/agenteam', handler: createListAgentsHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/agenteam', handler: createCreateAgentHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/agenteam/:id', handler: createGetAgentHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/agenteam/:id', handler: createUpdateAgentHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/agenteam/:id', handler: createDeleteAgentHandler(services), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/agenteam/default', handler: createSetDefaultAgentHandler(services), auth: true });

    // agenteams（agenteam 编排：团队/消息/生命周期/模板/临时subagent）
    this.router.addRoute({ method: 'GET', pattern: '/api/agenteams', handler: createListAgenteamsHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/agenteams/:id', handler: createGetAgenteamHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/agenteams/:id/messages', handler: createGetAgenteamMessagesHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/agenteams', handler: createCreateAgenteamHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/agenteams/:id/approve', handler: createApproveAgenteamHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/agenteams/:id/discard', handler: createDiscardAgenteamHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/agenteams/:id/halt', handler: createHaltAgenteamHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/agenteams/:id/resume', handler: createResumeAgenteamHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/agenteams/:id', handler: createDeleteAgenteamHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/agenteam-profiles', handler: createListAgenteamProfilesHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/agenteam-profiles', handler: createSaveAgenteamProfileHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/agenteam-profiles/:name', handler: createDeleteAgenteamProfileHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/subagents/run', handler: createRunSubagentHandler(services), auth: true });

    // automations
    this.router.addRoute({ method: 'GET', pattern: '/api/automations', handler: createListAutomationsHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/automations', handler: createCreateAutomationHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/automations/:id', handler: createGetAutomationHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/automations/:id', handler: createUpdateAutomationHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/automations/:id', handler: createDeleteAutomationHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/automations/:id/trigger', handler: createTriggerAutomationHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/automations/:id/pause', handler: createPauseAutomationHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/automations/:id/resume', handler: createResumeAutomationHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/automations/:id/history', handler: createAutomationHistoryHandler(services), auth: true });

    // filesystem（目录选择=前端选择器：drives/list/suggest-paths；附件=原生文件对话框）
    this.router.addRoute({ method: 'POST', pattern: '/api/filesystem/pick-file', handler: createPickFileHandler(env, config), auth: true });
    // 粘贴图片落盘：base64 → ~/.moss/agent/attachments/<file>，返回绝对路径（附件路径引用）
    this.router.addRoute({ method: 'POST', pattern: '/api/filesystem/save-attachment', handler: createSaveAttachmentHandler(env, config), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/filesystem/suggest-paths', handler: createSuggestPathsHandler(env), auth: true });
    // 终端：本机实测可用的解释器类型（前端「新建终端」菜单数据源）
    this.router.addRoute({ method: 'GET', pattern: '/api/terminal/interpreters', handler: createListInterpretersHandler(env), auth: true });
    // # 文件提及菜单：工作目录递归文件名搜索
    this.router.addRoute({ method: 'GET', pattern: '/api/filesystem/search-files', handler: createSearchFilesHandler(env), auth: true });
    // 文件浏览器：列出目标目录直接子项（目录 + 文件；走 filesys roots 权限）
    this.router.addRoute({ method: 'GET', pattern: '/api/filesystem/list', handler: createListDirectoryHandler(this.ctx.services), auth: true });
    // 文件浏览器「此电脑」视图：驱动器枚举 + 容量
    this.router.addRoute({ method: 'GET', pattern: '/api/filesystem/drives', handler: createListDrivesHandler(env), auth: true });
    // 文件只读预览（渲染模块取 docx/pdf/图片/3D 模型二进制；走 filesys roots 权限 + 白名单）
    this.router.addRoute({ method: 'GET', pattern: '/api/filesystem/raw', handler: createReadFileHandler(this.ctx.services), auth: true });
    // 视频/音频直链：<video>/<audio> 无法携带 Authorization 头 → query token 鉴权（handler 内校验）
    this.router.addRoute({ method: 'GET', pattern: '/api/filesystem/media', handler: createMediaHandler(this.ctx.services, config), auth: false });
    // 通用文本提取（Office/电子书等无前端渲染格式的回退）
    this.router.addRoute({ method: 'GET', pattern: '/api/filesystem/text', handler: createTextExtractHandler(this.ctx.services), auth: true });

    // filesys roots（虚拟文件系统授权目录管理）
    this.router.addRoute({ method: 'GET', pattern: '/api/filesys/roots', handler: createGetRootsHandler(this.ctx.services), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/filesys/roots', handler: createUpdateRootsHandler(this.ctx.services, this.ctx.config), auth: true });

    // logs（日志文件列表 / 行查询过滤 / 过期清理）
    this.router.addRoute({ method: 'GET', pattern: '/api/logs/files', handler: createLogFilesHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/logs', handler: createQueryLogsHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/logs/cleanup', handler: createCleanupLogsHandler(services), auth: true });

    // context（上下文引擎：统计 / 压缩历史 / 手动压缩 / 摘要模型列表 / 文件索引）
    this.router.addRoute({ method: 'GET', pattern: '/api/context/summary-models', handler: createSummaryModelsHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/context/:sessionId/stats', handler: createContextStatsHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/context/:sessionId/compactions', handler: createContextCompactionsHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/context/:sessionId/compact-preview', handler: createCompactPreviewHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/context/:sessionId/compact', handler: createManualCompactHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/context/file-index/status', handler: createFileIndexStatusHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/context/file-index/rebuild', handler: createFileIndexRebuildHandler(services), auth: true });

    // rules（规则引擎：双作用域 CRUD）
    this.router.addRoute({ method: 'GET', pattern: '/api/rules', handler: createListRulesHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/rules', handler: createCreateRuleHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/rules/:id', handler: createGetRuleHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/rules/:id', handler: createUpdateRuleHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/rules/:id', handler: createDeleteRuleHandler(services), auth: true });

    // hooks（钩子引擎：双作用域 CRUD + 测试触发 + 执行历史）
    this.router.addRoute({ method: 'GET', pattern: '/api/hooks', handler: createListHooksHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/hooks', handler: createCreateHookHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/hooks/history', handler: createHookHistoryHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/hooks/:id', handler: createGetHookHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/hooks/:id', handler: createUpdateHookHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/hooks/:id', handler: createDeleteHookHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/hooks/:id/test', handler: createTestHookHandler(services), auth: true });

    // memory（记忆引擎：宫殿树 / 列表搜索 / CRUD + 手动蒸馏）
    this.router.addRoute({ method: 'GET', pattern: '/api/memory/tree', handler: createMemoryTreeHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/memory/distill', handler: createDistillMemoryHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/memory', handler: createListMemoryHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/memory', handler: createCreateMemoryHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/memory/:id', handler: createGetMemoryHandler(services), auth: true });
    this.router.addRoute({ method: 'PATCH', pattern: '/api/memory/:id', handler: createUpdateMemoryHandler(services), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/memory/:id', handler: createDeleteMemoryHandler(services), auth: true });

    // voice（语音识别：总览 / 模型目录 / 开关 / 默认模型 / 安装 / 卸载）
    this.router.addRoute({ method: 'GET', pattern: '/api/voice/status', handler: createVoiceStatusHandler(services), auth: true });
    this.router.addRoute({ method: 'GET', pattern: '/api/voice/models', handler: createVoiceModelsHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/voice/enable', handler: createVoiceEnableHandler(services), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/voice/default-model', handler: createVoiceSetDefaultModelHandler(services), auth: true });
    this.router.addRoute({ method: 'PUT', pattern: '/api/voice/provider', handler: createVoiceSetProviderHandler(services, config), auth: true });
    this.router.addRoute({ method: 'POST', pattern: '/api/voice/models/:id/install', handler: createVoiceInstallHandler(services, this.ctx.logger), auth: true });
    this.router.addRoute({ method: 'DELETE', pattern: '/api/voice/models/:id', handler: createVoiceUninstallHandler(services), auth: true });
  }

  private async startServer(): Promise<void> {
    const cfg = this.ctx.config.getAppConfig();
    let port = cfg.server.port;
    const host = computeBindHost(cfg);

    if (isDevMode() && cfg.remote?.enabled) {
      this.ctx.logger.info('dev mode: forcing loopback bind (remote access is local-only in dev)', { host });
    }

    if (cfg.server.autoPort) {
      port = await this.findFreePort(host, port);
      if (port !== cfg.server.port) {
        this.ctx.logger.warn(
          t('server.autoPortUnavailable', { configured: cfg.server.port, actual: port }),
        );
      }
    }

    try {
      this.server = this.createServerInstance(port, host);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/EADDRINUSE|address already in use/i.test(msg)) {
        this.ctx.logger.error(
          t('server.bindInUse', { host, port }),
          { error: msg, host, port },
        );
      } else {
        this.ctx.logger.error(
          t('server.startFailed', { host, port, msg }),
          { error: msg, host, port },
        );
      }
      throw err;
    }

    this.actualPort = port;
    this.actualHost = host;
  }

  /**
   * 热重绑：停止当前 HTTP/WS 服务并以相同端口按新 hostname 重新监听。
   * router/wsHandler/assets/mcpExpose 实例全部复用（连接状态、订阅集合、activeRuns
   * 天然保留）；运行中 agent 任务与连接解耦，不受影响。前端断连后自动重连。
   * 端口锁定（禁止 autoPort 漂移——手机端正拿着 URL 访问）；失败时按原 hostname 回滚。
   */
  async rebind(hostname: string): Promise<void> {
    // dev 模式：任何热重绑都停在回环，禁止切到 0.0.0.0
    if (isDevMode()) hostname = '127.0.0.1';
    // 并发 rebind 串行化（开关快速连点）
    if (this.rebinding) await this.rebinding;
    this.rebinding = (async (): Promise<void> => {
      if (!this.server) throw new Error('server not started');
      const port = this.actualPort;
      const oldHost = this.actualHost;
      if (oldHost === hostname) return;

      this.ctx.logger.info(t('server.rebinding', { from: oldHost, to: hostname }));
      // stop(true)：立即断开活跃连接（含 WS）；旧连接的资源由 Bun 回收
      await this.server.stop(true);
      this.server = null;

      let lastErr: unknown = null;
      for (let i = 0; i < 10; i++) {
        try {
          this.server = this.createServerInstance(port, hostname);
          this.actualHost = hostname;
          return;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!/EADDRINUSE|address already in use/i.test(msg)) break;
          // 端口竞态：短暂等待后重试原端口
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      // 全部失败：按原 hostname 回滚（服务必须保持可用）
      this.server = this.createServerInstance(port, oldHost);
      this.actualHost = oldHost;
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    })();
    try {
      await this.rebinding;
    } finally {
      this.rebinding = null;
    }
  }

  /**
   * 创建 Bun.serve 实例（startServer 与 rebind 共用）。
   * fetch 最前为请求门卫（remote 模块注入；null 时零开销直通）——覆盖 HTTP/WS/
   * 静态资源//mcp 端点的一切非本机请求。
   */
  private createServerInstance(port: number, hostname: string): BunServer {
    const router = this.router;
    const wsHandler = this.wsHandler;
    const logger = this.ctx.logger;
    const mcpExpose = this.mcpExpose;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BunAny = Bun as any;
    return BunAny.serve({
      port,
      hostname,
      // 顶层（HTTP 请求）：Bun 默认 10s 空闲即断连接，慢接口（文件索引 rebuild、
      // provider 拉模型等）会被中途杀掉；60s 对本地 API 安全
      idleTimeout: 60,
      fetch: async (req: Request, srv: BunServer): Promise<Response> => {
        const url = new URL(req.url);
        // WebSocket 升级
        if (req.headers.get('upgrade') === 'websocket' && (url.pathname === '/ws' || url.pathname === '/ws/')) {
          // 请求门卫：远程访问开启时校验 cookie（未认证拒绝握手）
          const guard = this.guard;
          if (guard) {
            const gctx = buildGuardContext(req, srv);
            if (!guard.checkWS(gctx)) {
              return new Response('{"error":"unauthorized"}', {
                status: 401,
                headers: { 'content-type': 'application/json' },
              });
            }
          }
          const connId = crypto.randomUUID();
          const success = srv.upgrade(req, {
            data: { connId },
          });
          if (success) return new Response(null, { status: 101 });
          return new Response('Upgrade failed', { status: 400 });
        }
        // 请求门卫：远程访问开启时拦截非本机请求（HTTP + 静态资源 + /mcp 全覆盖）
        const guard = this.guard;
        if (guard) {
          const gctx = buildGuardContext(req, srv);
          const verdict = guard.precheck(gctx);
          if (verdict.action === 'respond') {
            return new Response(verdict.response.body, {
              status: verdict.response.status,
              headers: verdict.response.headers,
            });
          }
          if (verdict.action === 'login') {
            // 登录表单提交：读 body 后交由门卫处理（校验密码、种 cookie）
            const body = await req.text();
            const resp = guard.handleLogin(gctx, body);
            return new Response(resp.body, { status: resp.status, headers: resp.headers });
          }
          if (verdict.action === 'pass-authenticated') {
            // 远程会话已认证：注入 Authorization（API 鉴权层认可远程 cookie，"两者结合"）
            const extra: Record<string, string> = { authorization: verdict.authorization };
            const mcpResp = await mcpExpose.handleRequest(req);
            if (mcpResp) return mcpResp;
            return handleHttp(req, router, logger, extra);
          }
        }
        // MCP 对外暴露端点（/mcp）：在 router 之前拦截，绕过 body 限制与 SPA fallback
        const mcpResp = await mcpExpose.handleRequest(req);
        if (mcpResp) return mcpResp;
        // 普通 HTTP 请求
        return handleHttp(req, router, logger);
      },
      websocket: {
        // 空闲超时（秒）。三层防御的第二层（前端心跳 Worker 15s 为第一层，页面可见性回补
        // 为第三层）：Chrome 后台标签页会把主线程 timer 节流到 1 分钟一次，即使某次心跳
        // 间隔被拉到 60s 也必须远小于本值，空闲挂后台才不会断连。
        // 注意：必须放在 websocket 块内，顶层放置会被 Bun 静默忽略
        idleTimeout: 300,
        // 禁用 Bun 自动协议层 ping：与 idleTimeout 协同存在 bug
        // （oven-sh/bun#26554：ping 超时导致非优雅关闭 → 代理层 ECONNRESET）。
        // 探活由前端应用层心跳（15s ping / 30s timeout）全权负责
        sendPings: false,
        open(ws: BunWebSocket & { data: { connId: string } }) {
          const id = ws.data?.connId ?? crypto.randomUUID();
          const conn: WSConnection = {
            id,
            send: (msg: unknown) => {
              try {
                ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
              } catch {
                // 连接已关闭，忽略
              }
            },
            close: () => {
              try {
                ws.close();
              } catch {
                // 静默
              }
            },
          };
          ws.__conn = conn;
          ws.__id = id;
          wsHandler.registerConnection(conn);
        },
        message(ws: BunWebSocket & { data: { connId: string } }, message: string | Buffer) {
          const id = ws.__id ?? ws.data?.connId;
          if (!id) return;
          // 原样传递：string = JSON 指令；Buffer = 语音二进制音频帧（PCM int16）
          wsHandler.handleMessage(id, message).catch(err => {
            logger.error(t('server.wsMessageFailed'), {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        close(ws: BunWebSocket & { data: { connId: string } }) {
          const id = ws.__id ?? ws.data?.connId;
          if (id) wsHandler.unregisterConnection(id);
        },
      },
    });
  }

  private async findFreePort(host: string, startPort: number): Promise<number> {
    let port = startPort;
    for (let i = 0; i < 100; i++) {
      if (await isPortFree(host, port)) return port;
      port++;
    }
    return startPort;
  }
}

/** 计算绑定地址：dev 模式强制回环（仅本机）→ remote.enabled（0.0.0.0）→ bindLocalhostOnly → server.host。 */
export function computeBindHost(cfg: { remote?: { enabled?: boolean }; security: { bindLocalhostOnly: boolean }; server: { host: string } }): string {
  // 开发模式：强制仅本机，杜绝把 dev 暴露到网络（优先于 remote.enabled）
  if (isDevMode()) return '127.0.0.1';
  if (cfg.remote?.enabled) return '0.0.0.0';
  return cfg.security.bindLocalhostOnly ? '127.0.0.1' : cfg.server.host;
}

/** 构造门卫请求上下文（headers 小写键 + 客户端 IP）。 */
function buildGuardContext(req: Request, srv: BunServer): GuardRequestContext {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  let clientIp = '';
  try {
    const info = srv.requestIP(req);
    clientIp = info?.address ?? '';
  } catch {
    clientIp = '';
  }
  return { method: req.method, url: req.url, headers, clientIp };
}

async function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require('node:net');
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function handleHttp(
  req: Request,
  router: HttpRouter,
  logger: { debug: (m: string, ctx?: Record<string, unknown>) => void },
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const url = req.url;
  const method = req.method;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  // 门卫注入的额外头（远程会话已认证时的 Authorization；同键覆盖原值）
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers[k.toLowerCase()] = v;
    }
  }
  const body = req.body ? await req.text() : '';

  logger.debug(t('server.httpRequest', { method, url }));

  const result = await router.handle(method, url, headers, body);
  const respHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...(result.headers ?? {}),
  };

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: respHeaders });
  }

  let responseBody: BodyInit | null = null;
  if (result.body !== undefined && result.body !== null) {
    if (typeof result.body === 'string') {
      responseBody = result.body;
    } else if (result.body instanceof Uint8Array) {
      responseBody = result.body as BodyInit;
    } else if (typeof Buffer !== 'undefined' && result.body instanceof Buffer) {
      responseBody = new Uint8Array(result.body as Buffer) as BodyInit;
    } else {
      responseBody = JSON.stringify(result.body);
    }
  }
  return new Response(responseBody, { status: result.status, headers: respHeaders });
}

export default (): Module => new ServerModule();
