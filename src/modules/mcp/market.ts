// src/modules/mcp/market.ts
// MCP 市场服务：统一查询 / 详情 / 安装托管。
//
// 安装编排：
//   1. 拉取市场详情，选定安装方式（stdio / remote）
//   2. 校验必填 env、名称与冲突
//   3. 写入 ~/.moss/mcps/<name>.json（由 MCPManager 托管）
//   4. HTTP 路由路径后台连接；Agent 工具路径等待连接结果

import { t } from '../../core/i18n';
import type { EventBus, Logger } from '../../core/types';
import type { MCPManager } from '../contracts';
import { DEFAULT_CONNECT_TIMEOUT_MS, type ServerConfig } from './client';
import {
  applyHeaderTemplates,
  createMarketProviders,
  McpMarketError,
  type McpMarketDetail,
  type McpMarketInstallOption,
  type McpMarketProvider,
  type McpMarketQueryResult,
  type McpMarketSource,
} from './market-providers';

export type {
  McpMarketDetail,
  McpMarketEnvField,
  McpMarketInstallOption,
  McpMarketItem,
  McpMarketQueryResult,
  McpMarketSource,
} from './market-providers';

export { McpMarketError } from './market-providers';

const DEFAULT_SOURCE: McpMarketSource = 'mcpmarket';
const PAGE_SIZE_DEFAULT = 24;
const PAGE_SIZE_MAX = 50;
const DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
/** 市场安装后的连接超时（npx/uvx 首次下载依赖可能较慢，SDK 默认 60s 不够） */
const MARKET_CONNECT_TIMEOUT_MS = DEFAULT_CONNECT_TIMEOUT_MS;

const SOURCES: McpMarketSource[] = ['mcpmarket', 'official', 'modelscope'];

/** 本地服务器名合法字符（与 MCPManager 校验保持一致） */
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export interface McpMarketService {
  query(args: {
    source?: McpMarketSource;
    keyword?: string;
    pageToken?: string;
    pageSize?: number;
  }): Promise<McpMarketQueryResult & { source: McpMarketSource }>;

  detail(source: McpMarketSource, id: string): Promise<McpMarketDetail>;

  install(
    args: {
      source?: McpMarketSource;
      id: string;
      optionIndex?: number;
      env?: Record<string, string>;
      name?: string;
    },
    opts?: { awaitConnect?: boolean },
  ): Promise<{
    name: string;
    installed: boolean;
    updated?: boolean;
    alreadyInstalled?: boolean;
    connected?: boolean;
    error?: string;
  }>;
}

function resolveSource(raw?: string): McpMarketSource {
  if (!raw) return DEFAULT_SOURCE;
  if ((SOURCES as string[]).includes(raw)) return raw as McpMarketSource;
  throw new McpMarketError('SOURCE_INVALID', `invalid market source: ${raw}`);
}

/** 冲突时的建议名称：<name>-2、<name>-3 … */
function suggestServerName(base: string, taken: Set<string>): string {
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class McpMarketServiceImpl implements McpMarketService {
  private readonly providers = new Map<McpMarketSource, McpMarketProvider>();
  private readonly detailCache = new Map<string, { at: number; value: McpMarketDetail }>();

  constructor(
    private readonly deps: {
      manager: MCPManager;
      eventBus: EventBus;
      logger: Logger;
    },
  ) {
    for (const provider of createMarketProviders()) {
      this.providers.set(provider.id, provider);
    }
  }

  private provider(source: McpMarketSource): McpMarketProvider {
    const provider = this.providers.get(source);
    if (!provider) throw new McpMarketError('SOURCE_INVALID', `market source not registered: ${source}`);
    return provider;
  }

  async query(args: {
    source?: McpMarketSource;
    keyword?: string;
    pageToken?: string;
    pageSize?: number;
  }): Promise<McpMarketQueryResult & { source: McpMarketSource }> {
    const source = resolveSource(args.source);
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, args.pageSize ?? PAGE_SIZE_DEFAULT));
    try {
      const result = await this.provider(source).query(
        typeof args.keyword === 'string' ? args.keyword : '',
        typeof args.pageToken === 'string' && args.pageToken ? args.pageToken : undefined,
        pageSize,
      );
      return { ...result, source };
    } catch (err) {
      if (err instanceof McpMarketError) throw err;
      throw new McpMarketError('UPSTREAM_UNAVAILABLE', errorMessage(err));
    }
  }

  async detail(source: McpMarketSource, id: string): Promise<McpMarketDetail> {
    const resolved = resolveSource(source);
    const serverId = typeof id === 'string' ? id.trim() : '';
    if (!serverId) throw new McpMarketError('NOT_FOUND', 'market id is required');
    const key = `${resolved}:${serverId}`;
    const cached = this.detailCache.get(key);
    if (cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) {
      return cached.value;
    }
    try {
      const detail = await this.provider(resolved).detail(serverId);
      this.detailCache.set(key, { at: Date.now(), value: detail });
      return detail;
    } catch (err) {
      if (err instanceof McpMarketError) throw err;
      throw new McpMarketError('UPSTREAM_UNAVAILABLE', errorMessage(err));
    }
  }

  /** 广播安装阶段（前端进度条用）：download → install → start */
  private emitProgress(
    detail: { source: McpMarketSource; id: string; name: string },
    phase: 'download' | 'install' | 'start',
  ): void {
    void this.deps.eventBus
      .broadcast('mcp:install:progress', {
        source: detail.source,
        id: detail.id,
        name: detail.name,
        phase,
      })
      .catch(() => {});
  }

  async install(
    args: {
      source?: McpMarketSource;
      id: string;
      optionIndex?: number;
      env?: Record<string, string>;
      name?: string;
    },
    opts?: { awaitConnect?: boolean },
  ): Promise<{
    name: string;
    installed: boolean;
    updated?: boolean;
    alreadyInstalled?: boolean;
    connected?: boolean;
    error?: string;
  }> {
    const source = resolveSource(args.source);
    this.emitProgress({ source, id: args.id, name: args.id }, 'download');
    const detail = await this.detail(source, args.id);
    this.emitProgress(detail, 'install');
    const option = this.selectOption(detail, args.optionIndex);
    const inputs = this.validateEnv(option, args.env ?? {});

    // 名称与冲突处理
    const servers = this.deps.manager.listServers();
    const installed = servers.find(
      (server) => server.market?.source === detail.source && server.market.id === detail.id,
    );
    const explicitName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : '';
    const name = explicitName || installed?.name || detail.installName;
    if (!SERVER_NAME_RE.test(name)) {
      throw new McpMarketError('NAME_INVALID', t('mcp.invalidServerName', { name }), { name });
    }
    const existing = servers.find((server) => server.name === name);
    let updated = false;
    if (existing) {
      const sameMarket =
        existing.market?.source === detail.source && existing.market.id === detail.id;
      if (!sameMarket) {
        const taken = new Set(servers.map((server) => server.name));
        throw new McpMarketError(
          'NAME_CONFLICT',
          t('mcp.marketNameConflict', { name }),
          { name, suggestedName: suggestServerName(name, taken) },
        );
      }
      updated = true;
    }

    // 组装最终 ServerConfig
    const def = this.buildServerConfig(detail, option, inputs);
    try {
      if (updated) {
        await this.deps.manager.updateServer(name, def, { connect: false });
      } else {
        await this.deps.manager.createServer(name, def, { connect: false });
      }
    } catch (err) {
      throw new McpMarketError('INSTALL_FAILED', errorMessage(err));
    }

    this.deps.logger.info(t('mcp.marketInstalled', { name }), {
      source: detail.source,
      id: detail.id,
      option: option.label,
      updated,
    });

    // 配置已写入：进入启动/连接阶段
    this.emitProgress(detail, 'start');

    // 连接策略：路由路径后台连接（立即返回）；工具路径等待连接结果
    if (opts?.awaitConnect) {
      let connected = false;
      let error: string | undefined;
      try {
        await this.deps.manager.connect(name, { timeoutMs: MARKET_CONNECT_TIMEOUT_MS });
        connected = true;
      } catch (err) {
        error = errorMessage(err);
      }
      return {
        name,
        installed: true,
        ...(updated ? { updated: true } : {}),
        connected,
        ...(error ? { error } : {}),
      };
    }

    void this.deps.manager.connect(name, { timeoutMs: MARKET_CONNECT_TIMEOUT_MS }).catch((err: unknown) => {
      // manager 已广播错误并安排自动重试，这里只记录日志，避免重复广播
      const message = errorMessage(err);
      this.deps.logger.warn(t('mcp.marketConnectFailed', { name }), { error: message });
    });

    return { name, installed: true, ...(updated ? { updated: true } : {}) };
  }

  /** 选定安装方式：显式 index 必须合法；缺省取第一个 supported */
  private selectOption(detail: McpMarketDetail, optionIndex?: number): McpMarketInstallOption {
    const options = detail.installOptions;
    if (options.length === 0) {
      throw new McpMarketError('NO_INSTALL_OPTION', t('mcp.marketNoInstallOption'), { id: detail.id });
    }
    if (optionIndex !== undefined) {
      const option = options.find((item) => item.index === optionIndex);
      if (!option) {
        throw new McpMarketError('OPTION_INVALID', t('mcp.marketOptionInvalid', { index: optionIndex }), {
          optionIndex,
        });
      }
      if (!option.supported) {
        throw new McpMarketError(
          'NO_INSTALL_OPTION',
          option.unsupportedReason || t('mcp.marketNoInstallOption'),
          { optionIndex, reason: option.unsupportedReason },
        );
      }
      return option;
    }
    const supported = options.find((item) => item.supported);
    if (!supported) {
      const reason = options.find((item) => item.unsupportedReason)?.unsupportedReason;
      throw new McpMarketError(
        'NO_INSTALL_OPTION',
        reason || t('mcp.marketNoInstallOption'),
        { id: detail.id },
      );
    }
    return supported;
  }

  /** 校验/收敛 env 输入，返回最终写入配置的环境变量 */
  private validateEnv(
    option: McpMarketInstallOption,
    provided: Record<string, string>,
  ): Record<string, string> {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const field of option.env) {
      if (field.fixedValue !== undefined) {
        values[field.name] = field.fixedValue;
        continue;
      }
      const raw: unknown = (provided as Record<string, unknown>)[field.name];
      const rawText =
        typeof raw === 'string' ? raw : raw === undefined ? field.default ?? '' : String(raw);
      const value = rawText.trim();
      if (!value) {
        if (field.required) missing.push(field.name);
        continue;
      }
      if (field.choices && field.choices.length > 0 && !field.choices.includes(value)) {
        throw new McpMarketError(
          'OPTION_INVALID',
          t('mcp.marketEnvInvalid', { name: field.name }),
          { field: field.name, choices: field.choices },
        );
      }
      values[field.name] = value;
    }
    if (missing.length > 0) {
      throw new McpMarketError('ENV_REQUIRED', t('mcp.marketEnvRequired', { names: missing.join(', ') }), {
        missing,
      });
    }
    return values;
  }

  /** 把市场详情 + 选项 + env 输入转换为 MCPManager 的 ServerConfig */
  private buildServerConfig(
    detail: McpMarketDetail,
    option: McpMarketInstallOption,
    inputs: Record<string, string>,
  ): ServerConfig {
    const market = {
      source: detail.source,
      id: detail.id,
      ...(detail.version ? { version: detail.version } : {}),
    };

    if (option.kind === 'stdio') {
      if (!option.command) {
        throw new McpMarketError('OPTION_INVALID', 'stdio option is missing command');
      }
      const env: Record<string, string> = {};
      for (const field of option.env) {
        const value = inputs[field.name];
        if (value !== undefined && value !== '') env[field.name] = value;
      }
      // 官方 Registry 的 packageArguments 可能含 {VAR} 占位符：安装时用用户输入补全
      const args = (option.args ?? []).map((arg) =>
        arg.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
          const value = inputs[key];
          return value !== undefined && value !== '' ? value : match;
        }),
      );
      // npx 在非交互子进程中可能等待“是否安装”确认：统一补 -y，避免首次安装卡死
      const baseCommand = option.command.toLowerCase().replace(/\.cmd$/i, '');
      if (baseCommand === 'npx' && !args.includes('-y') && !args.includes('--yes')) {
        args.unshift('-y');
      }
      return {
        transport: 'stdio',
        command: option.command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        market,
      };
    }

    if (!option.url) {
      throw new McpMarketError('OPTION_INVALID', 'remote option is missing url');
    }
    let url: URL;
    try {
      url = new URL(option.url);
    } catch {
      throw new McpMarketError('OPTION_INVALID', `invalid remote url: ${option.url}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new McpMarketError('OPTION_INVALID', `unsupported remote protocol: ${url.protocol}`);
    }

    let headers: Record<string, string> = {};
    if (option.headerTemplates && Object.keys(option.headerTemplates).length > 0) {
      const applied = applyHeaderTemplates(option.headerTemplates, inputs);
      if (applied.missing.length > 0) {
        throw new McpMarketError(
          'ENV_REQUIRED',
          t('mcp.marketEnvRequired', { names: applied.missing.join(', ') }),
          { missing: applied.missing },
        );
      }
      headers = applied.headers;
    }

    return {
      transport: option.transport,
      url: option.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      market,
    };
  }
}
