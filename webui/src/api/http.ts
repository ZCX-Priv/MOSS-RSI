// UI/src/api/http.ts
// HTTP 请求封装：迁移自 webui/src/api/http.ts，扩展新接口函数。
// 所有函数返回类型引用 types/api.ts。

import type {
  AppConfig,
  ApiConfig,
  McpServer,
  McpTool,
  Session,
  TaskItem,
  TaskGroup,
  ProviderItem,
  ProviderModelItem,
  ProviderServiceItem,
  ThinkingLevelItem,
  RemoteModelItem,
  ProviderBalanceResult,
  AgentItem,
  AgentDetail,
  Agenteam,
  AgenteamSummary,
  AgenteamProfile,
  CreateAgenteamInput,
  TeamMessage,
  SubagentRunOutput,
  SkillItem,
  SkillDetail,
  CommandItem,
  CommandUpsertBody,
  ToolItem,
  AutomationItem,
  AutomationDetail,
  AutomationRun,
  TodoItem,
  ContextFile,
  SuggestPath,
  InterpreterOption,
  SearchedFile,
  PickedFile,
  DirectoryListing,
  DriveListing,
  FileHistoryEntry,
  RunStats,
  LogFileInfo,
  LogQueryResult,
  LogLevel,
  ContextStats,
  CompactionRecord,
  CompactPreview,
  ManualCompactResult,
  FileIndexStatus,
  RulesListResult,
  RuleItem,
  RuleUpsertBody,
  HooksListResult,
  HookItem,
  HookUpsertBody,
  HookTestResult,
  HookHistoryEntry,
  MemoryItem,
  MemoryPalaceTree,
  MemoryUpsertBody,
  MemoryDistillResult,
  RemoteStatus,
  RemotePasswords,
  RemoteToggleResult,
  HistoryPageMeta,
  SessionState,
  VoiceStatus,
  VoiceModelStatus,
  ResourceSnapshot,
  ComputerStatus,
  ComputerWindowInfo,
  BrowserStatus,
} from '../types/api';
import i18n from '../i18n';

const BASE_URL = '';

function getAuthToken(): string {
  return localStorage.getItem('moss-token') ?? '';
}

/** 远程登录页逃生路径（与后端 guard.ts 的 LOGIN_GATE_PATH 一致）：
 *  `/api/` 前缀在 PWA Service Worker 的导航放行名单内，故即使当前页面来自
 *  SW 缓存的 SPA 外壳，跳到这里也能稳定拿到服务端登录页。 */
const REMOTE_GATE_PATH = '/api/remote-gate';

/** 远程会话失效（401）时交回服务端登录页。仅顶层窗口 + 非回环主机，避免影响本机桌面。 */
function redirectToRemoteGate(): void {
  try {
    if (typeof window === 'undefined') return;
    if (window.top !== window.self) return;
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return;
    if (window.location.pathname === REMOTE_GATE_PATH) return;
    window.location.replace(REMOTE_GATE_PATH);
  } catch {
    // 跳转不可用（跨源 iframe 等）时忽略，不影响原错误抛出
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    if (resp.status === 401) redirectToRemoteGate();
    const text = await resp.text();
    let msg = text;
    try {
      const json = JSON.parse(text);
      const errorCode = json.error ?? text;
      // 尝试通过 i18n 翻译错误码
      msg = i18n.exists(`errors.${errorCode}`) ? i18n.t(`errors.${errorCode}`) : errorCode;
    } catch {
      // 非 JSON
    }
    throw new Error(`${resp.status}: ${msg}`);
  }

  return (await resp.json()) as T;
}

/**
 * 瞬时失败判定（供退避重试使用，见 lib/retry.ts）：
 * - 网络层失败：fetch 抛 TypeError（后端未监听 / 连接被重置 / dev 代理 ECONNREFUSED）
 * - 503 服务暂不可用：后端内核启动窗口内 agent 引擎尚未注册（AGENT_ENGINE_UNAVAILABLE）
 * 其余（4xx 业务错误、参数错误、解析错误）不应重试。
 */
export function isTransientFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // fetch 网络失败统一抛 TypeError（request 内唯一的 TypeError 来源）
  if (err.name === 'TypeError') return true;
  const msg = err.message;
  return msg.startsWith('503') || msg.includes('AGENT_ENGINE_UNAVAILABLE');
}

// 消息适配（AgentMessage[] → TaskMessage[]）已抽离至 ./adapt-messages.ts：
// http.ts 顶部 import i18n 有模块级副作用（读 navigator），纯函数抽离后可在测试环境直接单测。
import { adaptAgentMessages } from './adapt-messages';

export const api = {
  // ==========================================================================
  // 健康
  // ==========================================================================
  health: () =>
    request<{
      status: string;
      timestamp: string;
      services: string[];
      uptime: number;
      modules: number;
      plugins: number;
      moduleStates: Record<string, string>;
      pluginStates: Record<string, string>;
    }>('GET', '/api/health'),

  // ==========================================================================
  // 配置
  // ==========================================================================
  getAppConfig: () => request<AppConfig>('GET', '/api/config'),
  updateAppConfig: (patch: Partial<AppConfig>) => request<AppConfig>('PUT', '/api/config', patch),
  getApiConfig: () => request<ApiConfig>('GET', '/api/api-config'),
  updateApiConfig: (patch: Partial<ApiConfig>) => request<ApiConfig>('PUT', '/api/api-config', patch),

  // ==========================================================================
  // 会话
  // ==========================================================================
  listSessions: () => request<{ sessions: Session[] }>('GET', '/api/session'),
  /**
   * 会话历史（支持分页）。
   * - 不传参：全量（保持旧调用方兼容）
   * - limit：最新 limit 条（首屏）
   * - limit + before：更早的一页（上滑加载）
   * - limit + after：尾部增量（断线/完成后的补齐）
   * 分页路径返回 page 元数据，每条消息带服务端绝对 index（前端据此生成稳定 id）。
   */
  getSessionHistory: async (
    id: string,
    opts?: { limit?: number; before?: number; after?: number },
  ) => {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts?.before !== undefined) qs.set('before', String(opts.before));
    if (opts?.after !== undefined) qs.set('after', String(opts.after));
    const q = qs.toString();
    const resp = await request<{
      sessionId: string;
      messages: unknown[];
      page?: HistoryPageMeta;
      activeSkill?: { name: string; mode: 'system' | 'message' } | null;
      permissionMode?: 'ask' | 'auto' | 'skip';
      lastRunStats?: RunStats;
    }>('GET', `/api/session/${id}${q ? `?${q}` : ''}`);
    return {
      sessionId: resp.sessionId,
      messages: adaptAgentMessages(resp.messages),
      ...(resp.page ? { page: resp.page } : {}),
      ...(resp.permissionMode ? { permissionMode: resp.permissionMode } : {}),
      ...(resp.lastRunStats ? { lastRunStats: resp.lastRunStats } : {}),
    };
  },
  /** 会话状态快照：运行态 + 半截流式草稿 + 待答/待确认（刷新/重连恢复的唯一入口） */
  getSessionState: (id: string) =>
    request<SessionState>('GET', `/api/session/${encodeURIComponent(id)}/state`),
  deleteSession: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/session/${id}`),
  getSessionContext: (id: string) =>
    request<{ files: ContextFile[]; totalTokens: number; maxTokens: number }>(
      'GET',
      `/api/sessions/${id}/context`,
    ),
  /** preview truncate: messages to remove + file changes to roll back */
  previewTruncate: (id: string, messageTimestamp: string, content: string) =>
    request<{
      sessionId: string;
      messagesToRemove: Array<{ index: number; role: string; content: string; timestamp?: string }>;
      fileChanges: Array<{ absPath: string; operation: string; toolName: string; timestamp: string }>;
      rollbackSkippedReason?: 'no-file-history' | 'no-timestamp';
    }>(
      'GET',
      `/api/sessions/${encodeURIComponent(id)}/truncate-preview?messageTimestamp=${encodeURIComponent(messageTimestamp)}&content=${encodeURIComponent(content)}`,
    ),
  /** execute truncate (soft delete messages + rollback file changes) */
  truncateSession: (id: string, messageTimestamp: string, content: string, opts?: { rollbackFiles?: boolean }) =>
    request<{
      sessionId: string;
      removedCount: number;
      rolledBackFiles: number;
      rollbackFailed: Array<{ absPath: string; error: string }>;
      truncatedBeforeTimestamp: string;
      fileRollbackPerformed: boolean;
      rollbackSkippedReason?: 'no-file-history' | 'no-timestamp' | 'skipped-by-caller';
    }>(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/truncate`,
      { messageTimestamp, content, ...(opts?.rollbackFiles !== undefined ? { rollbackFiles: opts.rollbackFiles } : {}) },
    ),
  /** restore last truncate (redo) */
  restoreTruncate: (id: string) =>
    request<{ sessionId: string; restoredCount: number; restoredFiles: number; restoreFailed: Array<{ absPath: string; error: string }> }>(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/truncate-restore`,
    ),
  /**
   * 「重新生成」重跑起点：服务端在完整历史上返回最后一条真实用户消息。
   * 前端只加载最后一页时，本地可能找不到触发本轮回复的 user 消息 → 由服务端定位。
   */
  getRegenerateTarget: (id: string) =>
    request<{
      sessionId: string;
      userMessage: { timestamp: string; content: string; attachments?: string[] };
    }>('POST', `/api/sessions/${encodeURIComponent(id)}/regenerate-target`, {}),

  // ==========================================================================
  // 上下文引擎（token 构成 / 缓存命中 / 压缩历史 / 手动压缩 / 摘要模型）
  // ==========================================================================
  getContextStats: (id: string) =>
    request<ContextStats>('GET', `/api/context/${encodeURIComponent(id)}/stats`),
  getCompactions: (id: string) =>
    request<{ compactions: CompactionRecord[] }>(
      'GET',
      `/api/context/${encodeURIComponent(id)}/compactions`,
    ),
  compactPreview: (id: string) =>
    request<CompactPreview>('GET', `/api/context/${encodeURIComponent(id)}/compact-preview`),
  manualCompact: (id: string, focus?: string) =>
    request<ManualCompactResult>(
      'POST',
      `/api/context/${encodeURIComponent(id)}/compact`,
      focus ? { focus } : {},
    ),
  getSummaryModels: () =>
    request<{ models: Array<{ id: string; name: string; model: string }> }>(
      'GET',
      '/api/context/summary-models',
    ),

  // ==========================================================================
  // 文件索引（三引擎状态 / 手动重建）
  // ==========================================================================
  getFileIndexStatus: (cwd?: string) =>
    request<FileIndexStatus>(
      'GET',
      `/api/context/file-index/status${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`,
    ),
  rebuildFileIndex: (cwd?: string, engines?: Array<'indexing' | 'graph' | 'sag'>) =>
    request<{ ok: boolean }>(
      'POST',
      '/api/context/file-index/rebuild',
      { ...(cwd ? { cwd } : {}), ...(engines ? { engines } : {}) },
    ),

  // ==========================================================================
  // MCP
  // ==========================================================================
  listMcpServers: () => request<{ servers: McpServer[] }>('GET', '/api/mcp/servers'),
  listMcpTools: (server?: string) =>
    request<{ tools: McpTool[] }>('GET', `/api/mcp/tools${server ? `?server=${server}` : ''}`),
  callMcpTool: (server: string, tool: string, args: unknown) =>
    request<unknown>('POST', '/api/mcp/call', { server, tool, arguments: args }),
  connectMcpServer: (server: string) => request<unknown>('POST', '/api/mcp/connect', { server }),
  disconnectMcpServer: (server: string) => request<unknown>('POST', '/api/mcp/disconnect', { server }),
  /** Xinjian server definition (body: { name, ...ServerConfig }) */
  createMcpServer: (def: Omit<McpServer, 'status' | 'toolCount'> & { name: string }) =>
    request<{ created: boolean; server: string }>('POST', '/api/mcp/servers', def),
  /** Gengxin server definition (incl. enabled toggle; body: ServerConfig) */
  updateMcpServer: (name: string, def: Partial<Omit<McpServer, 'name' | 'status' | 'toolCount'>>) =>
    request<{ updated: boolean; server: string }>('PUT', `/api/mcp/servers/${encodeURIComponent(name)}`, def),
  /** Shanchu server definition */
  deleteMcpServer: (name: string) =>
    request<{ deleted: boolean; server: string }>('DELETE', `/api/mcp/servers/${encodeURIComponent(name)}`),

  // ==========================================================================
  // 工具（完整信息 + 启停）
  // ==========================================================================
  listTools: () => request<{ tools: ToolItem[] }>('GET', '/api/tools'),
  updateTool: (name: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) =>
    request<{ name: string; config?: Record<string, unknown> }>('PATCH', `/api/tools/${encodeURIComponent(name)}`, patch),

  // ==========================================================================
  // Computer（cua-driver）
  // ==========================================================================
  getComputerStatus: (sessionId?: string) => {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    return request<ComputerStatus>('GET', `/api/computer/status${qs}`);
  },
  listComputerWindows: (onScreenOnly = true) =>
    request<{ windows: ComputerWindowInfo[] }>(
      'GET',
      `/api/computer/windows?onScreenOnly=${onScreenOnly ? '1' : '0'}`,
    ),
  installComputerDriver: () =>
    request<{ ok: boolean; output: string }>('POST', '/api/computer/install'),
  controlComputer: (action: 'pause' | 'resume' | 'reconnect') =>
    request<ComputerStatus>('POST', '/api/computer/control', { action }),

  // ==========================================================================
  // Browser（扩展桥接 / 内置 Chrome / Chrome for Testing）
  // ==========================================================================
  getBrowserStatus: () => request<BrowserStatus>('GET', '/api/browser/status'),
  openBrowserExtensionDir: () =>
    request<{ ok: boolean; path: string }>('POST', '/api/browser/extension/open'),
  controlBrowserBuiltin: (action: 'launch' | 'close') =>
    request<BrowserStatus>('POST', '/api/browser/builtin', { action }),
  downloadChromeForTesting: () =>
    request<BrowserStatus>('POST', '/api/browser/chrome-for-testing', { action: 'download' }),
  runBrowserInstaller: () =>
    request<BrowserStatus>('POST', '/api/browser/install', { action: 'run' }),
  /** 面板实时画面：带 Authorization 直接拉二进制（不能走 <img src>，否则 token 丢失） */
  fetchComputerScreenshot: async (opts: {
    target: 'desktop' | 'window';
    pid?: number;
    windowId?: number;
    maxDimension?: number;
  }): Promise<Blob> => {
    const qs = new URLSearchParams({ target: opts.target });
    if (opts.pid !== undefined) qs.set('pid', String(opts.pid));
    if (opts.windowId !== undefined) qs.set('windowId', String(opts.windowId));
    if (opts.maxDimension !== undefined) qs.set('maxDimension', String(opts.maxDimension));
    const token = getAuthToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(`${BASE_URL}/api/computer/screenshot?${qs.toString()}`, {
      headers,
      cache: 'no-store',
    });
    if (!resp.ok) {
      let message = `HTTP ${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // 非 JSON 错误体
      }
      throw new Error(message);
    }
    return resp.blob();
  },

  // ==========================================================================
  // 任务 + 分组（见文档 3.2.1）
  // ==========================================================================
  /** 任务列表页元数据（?limit 分页时附带） */
  listTasks: async (opts?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) qs.set('offset', String(opts.offset));
    const q = qs.toString();
    return request<{
      groups: TaskGroup[];
      tasks: TaskItem[];
      page?: { total: number; limit: number; offset: number; hasMore: boolean };
    }>('GET', `/api/tasks${q ? `?${q}` : ''}`);
  },
  /** 按分组拉取任务（组内排序，可分页）；侧边栏按分组按需加载用 */
  listTasksInGroup: (groupId: string, opts?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams({ groupId });
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) qs.set('offset', String(opts.offset));
    return request<{
      tasks: TaskItem[];
      page?: { total: number; limit?: number; offset?: number; hasMore: boolean };
    }>('GET', `/api/tasks?${qs.toString()}`);
  },
  /**
   * 创建任务。deriveGroupName：工作目录名 → 服务端按目录归类建组（前端免一次
   * 「查组/建组」串行往返，发送新任务从 2-3 次请求降到 1 次）。
   */
  createTask: (title: string, groupId?: string, deriveGroupName?: string, id?: string) =>
    request<{ task: TaskItem; group?: TaskGroup }>(
      'POST',
      '/api/tasks',
      {
        title,
        ...(groupId ? { groupId } : {}),
        ...(deriveGroupName ? { deriveGroupName } : {}),
        // 前端预分配会话 id（乐观导航）：后端以此 id 创建任务，保证前后端 id 一致
        ...(id ? { id } : {}),
      },
    ),
  getTask: async (id: string) => {
    const resp = await request<{ task: TaskItem; messages: unknown[]; todos: TodoItem[]; contextFiles: ContextFile[] }>(
      'GET',
      `/api/tasks/${id}`,
    );
    return { ...resp, messages: adaptAgentMessages(resp.messages) };
  },
  updateTask: (id: string, patch: Partial<Pick<TaskItem, 'title' | 'groupId'>>) =>
    request<TaskItem>('PATCH', `/api/tasks/${id}`, patch),
  deleteTask: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/tasks/${id}`),
  reorderTasks: (taskIds: string[]) =>
    request<{ reordered: boolean; tasks: TaskItem[] }>('PUT', '/api/tasks/reorder', { taskIds }),

  listTaskGroups: () => request<{ groups: TaskGroup[] }>('GET', '/api/task-groups'),
  createTaskGroup: (name: string, source?: 'folder' | 'manual') =>
    request<TaskGroup>('POST', '/api/task-groups', { name, source }),
  updateTaskGroup: (id: string, patch: { name?: string }) =>
    request<TaskGroup>('PATCH', `/api/task-groups/${id}`, patch),
  deleteTaskGroup: (id: string, moveTasksTo?: string, deleteTasks?: boolean) =>
    request<{ deleted: boolean }>('DELETE', `/api/task-groups/${id}`, { moveTasksTo, deleteTasks }),

  // 搜索
  search: (q: string) =>
    request<{ tasks: TaskItem[]; messages?: Array<{ sessionId: string; messageId: string; text: string }> }>(
      'GET',
      `/api/search?q=${encodeURIComponent(q)}`,
    ),

  // ==========================================================================
  // 服务商管理（服务商持有 API 格式/地址/Key，模型挂其下）
  // ==========================================================================
  listProviders: () =>
    request<{
      providers: ProviderItem[];
      current: string;
      /** 默认搜索引擎（web 工具消费）：空串 = 本地免费引擎链 */
      currentSearchProvider?: string;
    }>('GET', '/api/providers'),
  setCurrentModel: (modelId: string) =>
    request<{ current: string }>('PUT', '/api/providers/current', { modelId }),
  /** 设置默认搜索引擎（providerId 空串 = 本地免费引擎） */
  setSearchCurrentProvider: (providerId: string) =>
    request<{ currentSearchProvider: string }>('PUT', '/api/providers/search-current', {
      providerId,
    }),
  createProvider: (data: {
    name: string;
    /** 服务商类型：model（缺省）= 模型服务商；search = 搜索服务商；voice = 语音服务商 */
    kind?: 'model' | 'search' | 'voice';
    format?: ProviderItem['format'];
    /** 搜索引擎（kind='search' 必填）：zhipu / bocha / tavily */
    searchEngine?: 'zhipu' | 'bocha' | 'tavily';
    /** 语音引擎（kind='voice' 必填）：openai-transcriptions */
    voiceEngine?: 'openai-transcriptions';
    /** 语音模型名（kind='voice' 可选） */
    voiceModel?: string;
    endpoint: string;
    apiKey: string;
    balanceUrl?: string;
    modelsUrl?: string;
    icon?: string;
  }) => request<ProviderItem>('POST', '/api/providers', data),
  updateProvider: (id: string, patch: Partial<Omit<ProviderItem, 'id' | 'models'>>) =>
    request<ProviderItem>('PATCH', `/api/providers/${id}`, patch),
  deleteProvider: (id: string) =>
    request<{ deleted: boolean }>('DELETE', `/api/providers/${id}`),
  reorderProviders: (providerIds: string[]) =>
    request<{ providers: ProviderItem[] }>('PUT', '/api/providers/reorder', { providerIds }),
  /** 批量/单个添加模型（body 兼容 {models:[...]} 与单对象） */
  addProviderModels: (
    providerId: string,
    models: Array<{
      name: string;
      model: string;
      thinking?: ProviderModelItem['thinking'];
      contextWindow?: string;
      inputTokens?: number;
      outputTokens?: number;
      temperature?: number;
      topP?: number;
      topK?: number;
      thinkingLevels?: ThinkingLevelItem[];
    }>,
  ) =>
    request<{ provider: ProviderItem; added: number }>(
      'POST',
      `/api/providers/${providerId}/models`,
      { models },
    ),
  updateProviderModel: (providerId: string, modelId: string, patch: Partial<ProviderModelItem>) =>
    request<ProviderModelItem>('PATCH', `/api/providers/${providerId}/models/${modelId}`, patch),
  deleteProviderModel: (providerId: string, modelId: string) =>
    request<{ deleted: boolean }>('DELETE', `/api/providers/${providerId}/models/${modelId}`),
  /** 服务端代理拉取远程模型列表（归一化 {id, name?}[]） */
  fetchProviderModels: (providerId: string) =>
    request<{ success: boolean; models: RemoteModelItem[]; url?: string; error?: string }>(
      'POST',
      `/api/providers/${providerId}/models/fetch`,
    ),
  /** 服务端代理查询余额（OpenAI 兼容计费格式） */
  fetchProviderBalance: (providerId: string) =>
    request<ProviderBalanceResult>('POST', `/api/providers/${providerId}/balance`),
  testProviderModel: (providerId: string, modelId: string) =>
    request<{ success: boolean; latencyMs?: number; error?: string; model?: string }>(
      'POST',
      `/api/providers/${providerId}/models/${modelId}/test`,
    ),
  /** 服务商附加服务 CRUD（当前仅文件存储） */
  addProviderService: (providerId: string, data: Omit<ProviderServiceItem, 'id'>) =>
    request<ProviderServiceItem>('POST', `/api/providers/${providerId}/services`, data),
  updateProviderService: (providerId: string, serviceId: string, patch: Partial<ProviderServiceItem>) =>
    request<ProviderServiceItem>(
      'PATCH',
      `/api/providers/${providerId}/services/${serviceId}`,
      patch,
    ),
  deleteProviderService: (providerId: string, serviceId: string) =>
    request<{ deleted: boolean }>(
      'DELETE',
      `/api/providers/${providerId}/services/${serviceId}`,
    ),

  // ==========================================================================
  // Agent 管理（见文档 3.2.3）
  // ==========================================================================
  listAgents: () => request<{ agents: AgentItem[]; default: string }>('GET', '/api/agenteam'),
  getAgent: (id: string) => request<AgentDetail>('GET', `/api/agenteam/${id}`),
  createAgent: (data: { name: string; systemPrompt?: string; model?: string; tools?: string[] }) =>
    request<AgentItem>('POST', '/api/agenteam', data),
  updateAgent: (id: string, patch: Partial<AgentDetail>) =>
    request<AgentItem>('PATCH', `/api/agenteam/${id}`, patch),
  deleteAgent: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/agenteam/${id}`),
  setDefaultAgent: (id: string) =>
    request<{ default: string }>('PUT', '/api/agenteam/default', { id }),

  // ==========================================================================
  // agenteam 编排（见 routes/agenteams.ts）
  // ==========================================================================
  listAgenteams: () => request<{ teams: AgenteamSummary[] }>('GET', '/api/agenteams'),
  getAgenteam: (id: string) => request<Agenteam>('GET', `/api/agenteams/${id}`),
  getAgenteamMessages: (id: string, since?: number) =>
    request<{ messages: TeamMessage[] }>(
      'GET',
      `/api/agenteams/${id}/messages${since !== undefined ? `?since=${since}` : ''}`,
    ),
  createAgenteam: (data: CreateAgenteamInput) => request<Agenteam>('POST', '/api/agenteams', data),
  approveAgenteam: (id: string) => request<Agenteam>('POST', `/api/agenteams/${id}/approve`),
  discardAgenteam: (id: string) => request<Agenteam>('POST', `/api/agenteams/${id}/discard`),
  haltAgenteam: (id: string) => request<Agenteam>('POST', `/api/agenteams/${id}/halt`),
  resumeAgenteam: (id: string) => request<Agenteam>('POST', `/api/agenteams/${id}/resume`),
  deleteAgenteam: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/agenteams/${id}`),
  listAgenteamProfiles: () => request<{ profiles: AgenteamProfile[] }>('GET', '/api/agenteam-profiles'),
  saveAgenteamProfile: (data: AgenteamProfile) =>
    request<{ saved: boolean }>('POST', '/api/agenteam-profiles', data),
  deleteAgenteamProfile: (name: string) =>
    request<{ deleted: boolean }>('DELETE', `/api/agenteam-profiles/${encodeURIComponent(name)}`),
  runSubagent: (data: { template: string; task: string; cwd: string; permissionMode?: 'ask' | 'auto' | 'skip' }) =>
    request<SubagentRunOutput>('POST', '/api/subagents/run', data),

  // ==========================================================================
  // Skills（见文档 3.2.5）
  // ==========================================================================
  listSkills: () => request<{ skills: SkillItem[] }>('GET', '/api/skills'),
  getSkill: (name: string) => request<{ skill: SkillDetail }>('GET', `/api/skills/${name}`),
  updateSkill: (name: string, patch: { enabled: boolean }) =>
    request<{ name: string; enabled: boolean }>('PATCH', `/api/skills/${encodeURIComponent(name)}`, patch),
  /** 新建目录式技能（写 ~/.moss/skills/<name>/SKILL.md，watch 热重载生效） */
  createSkill: (data: { name: string; description: string; prompt?: string; icon?: string }) =>
    request<{ name: string }>('POST', '/api/skills', data),
  /** 导入技能（前端 zip 解包：文本 content / 二进制 base64；批量写入技能目录） */
  importSkill: (data: {
    name: string;
    files: Array<{ path: string; content?: string; base64?: string }>;
  }) =>
    request<{ name: string; files: number }>('POST', '/api/skills/import', data),
  /** 自定义斜杠命令列表（~/.moss/commands/<name>.md；含 prompt 供前端渲染注入） */
  listCommands: () => request<{ commands: CommandItem[] }>('GET', '/api/commands'),
  /** 创建自定义斜杠命令（写 <name>.md，热重载自动生效） */
  createCommand: (data: CommandUpsertBody) =>
    request<{ name: string }>('POST', '/api/commands', data),
  /** 更新自定义斜杠命令内容（重写 <name>.md；禁止改名） */
  updateCommand: (name: string, data: CommandUpsertBody) =>
    request<{ name: string }>('PUT', `/api/commands/${encodeURIComponent(name)}`, data),
  /** 删除自定义斜杠命令（删 <name>.md 文件） */
  deleteCommand: (name: string) =>
    request<{ name: string }>('DELETE', `/api/commands/${encodeURIComponent(name)}`),
  /** 切换命令启停（写 config.commands[name].enabled，热生效） */
  toggleCommand: (name: string, enabled: boolean) =>
    request<{ name: string; enabled: boolean }>('PATCH', `/api/commands/${encodeURIComponent(name)}`, { enabled }),

  // ==========================================================================
  // 规则引擎（/api/rules；cwd 走 query）
  // ==========================================================================
  listRules: (cwd?: string) =>
    request<RulesListResult>('GET', `/api/rules${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  getRule: (id: string, cwd?: string) =>
    request<RuleItem>('GET', `/api/rules/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  createRule: (data: RuleUpsertBody, cwd?: string) =>
    request<RuleItem>('POST', `/api/rules${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`, data),
  updateRule: (id: string, data: RuleUpsertBody, cwd?: string) =>
    request<RuleItem>('PATCH', `/api/rules/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`, data),
  deleteRule: (id: string, cwd?: string) =>
    request<{ ok: boolean }>('DELETE', `/api/rules/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),

  // ==========================================================================
  // 钩子引擎（/api/hooks）
  // ==========================================================================
  listHooks: (cwd?: string) =>
    request<HooksListResult>('GET', `/api/hooks${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  getHook: (id: string, cwd?: string) =>
    request<HookItem>('GET', `/api/hooks/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  createHook: (data: HookUpsertBody, cwd?: string) =>
    request<HookItem>('POST', `/api/hooks${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`, data),
  updateHook: (id: string, data: HookUpsertBody, cwd?: string) =>
    request<HookItem>('PATCH', `/api/hooks/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`, data),
  deleteHook: (id: string, cwd?: string) =>
    request<{ ok: boolean }>('DELETE', `/api/hooks/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  testHook: (id: string, sampleInput: { cwd?: string; sessionId?: string; toolName?: string; toolInput?: Record<string, unknown>; prompt?: string }) =>
    request<HookTestResult>('POST', `/api/hooks/${encodeURIComponent(id)}/test`, sampleInput),
  getHookHistory: () =>
    request<{ history: HookHistoryEntry[] }>('GET', '/api/hooks/history'),

  // ==========================================================================
  // 记忆引擎（/api/memory）
  // ==========================================================================
  getMemoryTree: (cwd?: string) =>
    request<MemoryPalaceTree>('GET', `/api/memory/tree${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  listMemory: (opts: { cwd?: string; wing?: string; room?: string; hall?: string; q?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts.cwd) params.set('cwd', opts.cwd);
    if (opts.wing) params.set('wing', opts.wing);
    if (opts.room) params.set('room', opts.room);
    if (opts.hall) params.set('hall', opts.hall);
    if (opts.q) params.set('q', opts.q);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request<{ items: MemoryItem[]; count: number }>('GET', `/api/memory${qs ? `?${qs}` : ''}`);
  },
  createMemory: (data: MemoryUpsertBody, cwd?: string) =>
    request<MemoryItem>('POST', `/api/memory${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`, data),
  getMemory: (id: string, cwd?: string) =>
    request<MemoryItem>('GET', `/api/memory/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  updateMemory: (id: string, patch: Partial<MemoryUpsertBody>, cwd?: string) =>
    request<MemoryItem>('PATCH', `/api/memory/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`, patch),
  deleteMemory: (id: string, cwd?: string) =>
    request<{ ok: boolean }>('DELETE', `/api/memory/${encodeURIComponent(id)}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  clearMemory: (scope: 'all' | 'global' | 'project', cwd?: string) =>
    request<{ ok: boolean; removed: number }>(
      'DELETE',
      `/api/memory?scope=${scope}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`,
    ),
  distillMemory: (data: { sessionId: string; cwd?: string }) =>
    request<MemoryDistillResult>('POST', '/api/memory/distill', data),

  // ==========================================================================
  // 远程控制（/api/remote/*）
  // ==========================================================================
  getRemoteStatus: () => request<RemoteStatus>('GET', '/api/remote/status'),
  getRemotePasswords: () => request<RemotePasswords>('GET', '/api/remote/passwords'),
  enableRemote: () => request<RemoteToggleResult>('POST', '/api/remote/enable'),
  disableRemote: () => request<RemoteToggleResult>('POST', '/api/remote/disable'),
  setRemoteLan: (enabled: boolean) => request<{ lanEnabled: boolean }>('POST', '/api/remote/lan', { enabled }),
  setRemoteLanPassword: (action: 'refresh' | 'custom' | 'disable' | 'enable', value?: string) =>
    request<{ pin?: string; lanPasswordEnabled?: boolean }>('POST', '/api/remote/lan/password', { action, value }),
  setRemoteLanIp: (ip: string) => request<{ lanIpOverride: string }>('POST', '/api/remote/lan-ip', { ip }),
  startRemoteTunnel: (disclaimerAccepted: boolean) =>
    request<{ url: string; phase: string }>('POST', '/api/remote/tunnel/start', { disclaimerAccepted }),
  stopRemoteTunnel: () => request<{ stopped: boolean }>('POST', '/api/remote/tunnel/stop'),
  setRemoteTunnelPassword: (action: 'refresh' | 'custom', value?: string) =>
    request<{ pin?: string }>('POST', '/api/remote/tunnel/password', { action, value }),

  // ==========================================================================
  // 自动化任务（见文档 3.2.7）
  // ==========================================================================
  listAutomations: () => request<{ automations: AutomationItem[] }>('GET', '/api/automations'),
  getAutomation: (id: string) => request<AutomationDetail>('GET', `/api/automations/${id}`),
  createAutomation: (data: {
    title: string;
    prompt: string;
    cwd: string;
    description?: string;
    icon?: string;
    agentId?: string;
    scheduleType?: 'cron' | 'once';
    cron?: string;
    runAt?: string;
  }) => request<AutomationItem>('POST', '/api/automations', data),
  updateAutomation: (id: string, patch: Partial<AutomationDetail>) =>
    request<AutomationItem>('PATCH', `/api/automations/${id}`, patch),
  deleteAutomation: (id: string) =>
    request<{ deleted: boolean }>('DELETE', `/api/automations/${id}`),
  triggerAutomation: (id: string) =>
    request<{ runId: string }>('POST', `/api/automations/${id}/trigger`),
  pauseAutomation: (id: string) =>
    request<{ paused: boolean }>('POST', `/api/automations/${id}/pause`),
  resumeAutomation: (id: string) =>
    request<{ paused: boolean }>('POST', `/api/automations/${id}/resume`),
  getAutomationHistory: (id: string) =>
    request<{ history: AutomationRun[] }>('GET', `/api/automations/${id}/history`),

  // ==========================================================================
  // Todo（见文档 3.2.9）
  // ==========================================================================
  listTodos: (sessionId: string) =>
    request<{ todos: TodoItem[] }>('GET', `/api/todos/${sessionId}`),
  setTodos: (sessionId: string, todos: TodoItem[]) =>
    request<{ todos: TodoItem[] }>('PUT', `/api/todos/${sessionId}`, { todos }),

  // ==========================================================================
  // 日志（文件列表 / 行查询过滤 / 过期清理）
  // ==========================================================================
  listLogFiles: () => request<{ files: LogFileInfo[] }>('GET', '/api/logs/files'),
  queryLogs: (opts: { file?: string; minLevel?: LogLevel; search?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (opts.file) qs.set('file', opts.file);
    if (opts.minLevel) qs.set('minLevel', opts.minLevel);
    if (opts.search) qs.set('search', opts.search);
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.offset !== undefined) qs.set('offset', String(opts.offset));
    const q = qs.toString();
    return request<LogQueryResult>('GET', `/api/logs${q ? `?${q}` : ''}`);
  },
  cleanupLogs: () => request<{ removed: number }>('POST', '/api/logs/cleanup'),

  // ==========================================================================
  // 版本（见文档 3.2.11）
  // ==========================================================================
  getVersion: () =>
    request<{ version: string; commit?: string; buildDate?: string; channel: string }>(
      'GET',
      '/api/version',
    ),

  // ==========================================================================
  // 文件系统（前端文件夹/文件选择器：drives/list/suggest-paths；附件：解析已选路径 + 粘贴落盘）
  // ==========================================================================
  /** 解析前端内建选择器已选路径为附件条目（后端 stat + 自动授权父目录进 filesys roots） */
  resolvePaths: (paths: string[]) =>
    request<{ files: PickedFile[]; grantedRoots?: string[] }>('POST', '/api/filesystem/resolve-paths', { paths }),
  /** 粘贴附件落盘（图片/文件）：base64 → 本地附件文件，返回绝对路径（后端自动授权 ~/.moss/agent/attachments） */
  saveAttachment: (payload: { name: string; dataBase64: string }) =>
    request<{ file: PickedFile; grantedRoots?: string[] }>(
      'POST',
      '/api/filesystem/save-attachment',
      payload,
    ),
  /**
   * 文件浏览器「上传」：base64 → 指定授权目录（走 filesys roots 权限；重名 409；上限 12MB）。
   * sessionId 用于让后端把 file-created 事件投递到该会话，前端文件列表自动刷新。
   */
  uploadFile: (dir: string, name: string, dataBase64: string, cwd?: string, sessionId?: string) =>
    request<{ file: PickedFile }>('POST', '/api/filesystem/upload', {
      dir,
      name,
      dataBase64,
      ...(cwd ? { cwd } : {}),
      ...(sessionId ? { sessionId } : {}),
    }),
  suggestPaths: () => request<{ paths: SuggestPath[] }>('GET', '/api/filesystem/suggest-paths'),
  /** 本机实测可用的终端解释器类型（「新建终端」菜单数据源；只返回真实存在的类型） */
  listInterpreters: () => request<{ interpreters: InterpreterOption[] }>('GET', '/api/terminal/interpreters'),
  /** # 文件提及菜单：指定目录递归模糊搜索文件名（上限 50 条） */
  searchFiles: (dir: string, q: string) =>
    request<{ files: SearchedFile[] }>(
      'GET',
      `/api/filesystem/search-files?dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(q)}`,
    ),
  /**
   * 列目录（文件浏览器数据源）：返回目标目录的直接子项（目录 + 文件）。
   * path 缺省时后端回落到 root（若有）或 cwd 解析结果（__system__ → 系统盘根）；cwd 缺省为 __system__。
   * root 为导航根（不可上溯越过；传后端强制边界，越界返回 403）；首次不传时后端以解析结果自身为根。
   */
  listDirectory: (path?: string, cwd?: string, root?: string) => {
    const qs = new URLSearchParams();
    if (path) qs.set('path', path);
    if (cwd) qs.set('cwd', cwd);
    if (root) qs.set('root', root);
    const q = qs.toString();
    return request<DirectoryListing>('GET', `/api/filesystem/list${q ? `?${q}` : ''}`);
  },
  /** 驱动器枚举（文件浏览器「此电脑」视图数据源） */
  listDrives: () => request<DriveListing>('GET', '/api/filesystem/drives'),
  /** 某会话的文件变更历史（文件变更标签页数据源） */
  listFileHistory: (sessionId: string) =>
    request<{ sessionId: string; entries: FileHistoryEntry[]; count: number }>(
      'GET',
      `/api/file-history/${encodeURIComponent(sessionId)}`,
    ),

  // ==========================================================================
  // 语音识别（voice：本地引擎 sherpa-onnx + 在线语音服务商）
  // ==========================================================================
  getVoiceStatus: () => request<VoiceStatus>('GET', '/api/voice/status'),
  listVoiceModels: () => request<{ models: VoiceModelStatus[] }>('GET', '/api/voice/models'),
  setVoiceEnabled: (enabled: boolean) =>
    request<VoiceStatus>('POST', '/api/voice/enable', { enabled }),
  setVoiceDefaultModel: (id: string) =>
    request<VoiceStatus>('POST', '/api/voice/default-model', { id }),
  /** providerId 空串 = 内置本地引擎 */
  setVoiceProvider: (providerId: string) =>
    request<VoiceStatus>('PUT', '/api/voice/provider', { providerId }),
  /** 启动后台下载安装（长耗时，轮询 listVoiceModels 看 progress） */
  installVoiceModel: (id: string) =>
    request<{ started: boolean }>('POST', `/api/voice/models/${encodeURIComponent(id)}/install`),
  uninstallVoiceModel: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/voice/models/${encodeURIComponent(id)}`),

  // ==========================================================================
  // 资源管理器（system-monitor）
  // ==========================================================================
  /** 系统资源快照（资源管理器轮询数据源） */
  getResourceSnapshot: () => request<ResourceSnapshot>('GET', '/api/system-monitor/snapshot'),
};
// 说明：AI 诊断（错误原因 / Harness / 资源解读）已改为 WebSocket 流式通道
// （insight.diagnose / insight.diagnose.event），不再提供 HTTP API。
