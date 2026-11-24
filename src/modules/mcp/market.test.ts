// src/modules/mcp/market.test.ts
// MCP 市场归一化单测：名称、占位符、header 模板，以及三个数据源的详情映射。

import { afterEach, describe, expect, it } from 'bun:test';
import type { EventBus, Logger } from '../../core/types';
import type { MCPManager } from '../contracts';
import type { ServerConfig } from './client';
import {
  applyHeaderTemplates,
  createMarketProviders,
  inferOptionsFromText,
  isPlaceholderValue,
  mergePlaceholderFields,
  sanitizeServerName,
  templateizeText,
  templateizeUrl,
} from './market-providers';
import { McpMarketError, McpMarketServiceImpl } from './market';

const realFetch = globalThis.fetch;

function mockFetchJson(payload: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function provider(id: 'mcpmarket' | 'official' | 'modelscope') {
  const found = createMarketProviders().find((item) => item.id === id);
  if (!found) throw new Error(`provider not found: ${id}`);
  return found;
}

const ESIGN_FIXTURE = {
  _id: 'esign',
  name: 'esign-mcp',
  alias: 'e签宝',
  description: { zh: '电子签约', en: 'e-signature' },
  mcp_config: {
    mcpServers: {
      app: {
        command: 'npx',
        args: ['-y', 'mcp-server-esign@1.1.2'],
        env: { APP_ID: '', APP_SECRET: 'your-secret', PYTHONUNBUFFERED: '1' },
      },
    },
  },
  env: { APP_ID: '应用 ID', APP_SECRET: '应用密钥' },
  auth_type: 'env',
  auth_help: { obtain_url: 'https://open.esign.cn' },
  mcp_url: null,
};

const NPM_NO_YES_FIXTURE = {
  _id: 'npx-no-yes',
  name: 'npx-no-yes',
  alias: '无 -y 的 npx',
  description: 'npx without -y',
  mcp_config: {
    mcpServers: {
      app: {
        command: 'npx',
        args: ['mcp-server-demo@1.0.0'],
      },
    },
  },
  env: {},
  auth_type: 'none',
  mcp_url: null,
};

describe('sanitizeServerName', () => {
  it('normalizes invalid characters and empty values', () => {
    expect(sanitizeServerName('PageIndex MCP')).toBe('pageindex-mcp');
    expect(sanitizeServerName('  ')).toBe('mcp-server');
    expect(sanitizeServerName('123')).toBe('mcp-123');
    expect(sanitizeServerName('@scope//fetch')).toBe('scope-fetch');
    expect(sanitizeServerName('a---b___c')).toBe('a-b___c');
  });
});

describe('isPlaceholderValue', () => {
  it('detects empty and placeholder values', () => {
    expect(isPlaceholderValue('')).toBe(true);
    expect(isPlaceholderValue('***')).toBe(true);
    expect(isPlaceholderValue('your-api-key')).toBe(true);
    expect(isPlaceholderValue('<token>')).toBe(true);
    expect(isPlaceholderValue('xxx')).toBe(true);
    expect(isPlaceholderValue('1')).toBe(false);
    expect(isPlaceholderValue('real-token')).toBe(false);
  });
});

describe('applyHeaderTemplates', () => {
  it('renders provided variables and reports missing ones', () => {
    const result = applyHeaderTemplates(
      { Authorization: 'Bearer {TOKEN}', 'X-Fixed': 'literal' },
      { TOKEN: 'abc' },
    );
    expect(result.headers).toEqual({ Authorization: 'Bearer abc', 'X-Fixed': 'literal' });
    expect(result.missing).toEqual([]);

    const missing = applyHeaderTemplates({ Authorization: 'Bearer {TOKEN}' }, {});
    expect(missing.missing).toEqual(['TOKEN']);
  });
});

describe('mcpmarket provider', () => {
  it('maps mcp_config env and auth metadata to install options', async () => {
    mockFetchJson(ESIGN_FIXTURE);

    const detail = await provider('mcpmarket').detail('esign');
    expect(detail.name).toBe('e签宝');
    expect(detail.installName).toBe('esign-mcp');
    expect(detail.obtainUrl).toBe('https://open.esign.cn');
    expect(detail.installOptions).toHaveLength(1);

    const option = detail.installOptions[0];
    expect(option.kind).toBe('stdio');
    expect(option.command).toBe('npx');
    expect(option.args).toEqual(['-y', 'mcp-server-esign@1.1.2']);
    expect(option.supported).toBe(true);

    const appId = option.env.find((field) => field.name === 'APP_ID');
    const appSecret = option.env.find((field) => field.name === 'APP_SECRET');
    const python = option.env.find((field) => field.name === 'PYTHONUNBUFFERED');
    expect(appId?.required).toBe(true);
    expect(appId?.fixedValue).toBeUndefined();
    expect(appSecret?.required).toBe(true);
    expect(appSecret?.secret).toBe(true);
    expect(python?.fixedValue).toBe('1');
  });
});

describe('official provider', () => {
  it('maps npm package arguments and environment variables', async () => {
    mockFetchJson({
      server: {
        name: 'io.github.brave/brave-search-mcp-server',
        description: 'Brave Search',
        version: '2.2.0',
        packages: [
          {
            registryType: 'npm',
            identifier: '@brave/brave-search-mcp-server',
            version: '2.2.0',
            runtimeArguments: [{ type: 'positional', value: '-y' }],
            packageArguments: [{ type: 'named', name: '--transport', value: 'stdio' }],
            transport: { type: 'stdio' },
            environmentVariables: [
              {
                name: 'BRAVE_API_KEY',
                description: 'Get one at https://api.search.brave.com',
                isRequired: true,
                isSecret: true,
              },
            ],
          },
        ],
      },
    });

    const detail = await provider('official').detail('io.github.brave/brave-search-mcp-server');
    expect(detail.installName).toBe('brave-search-mcp-server');
    expect(detail.version).toBe('2.2.0');
    expect(detail.obtainUrl).toBe('https://api.search.brave.com');

    const option = detail.installOptions[0];
    expect(option.command).toBe('npx');
    expect(option.args).toEqual([
      '-y',
      '@brave/brave-search-mcp-server@2.2.0',
      '--transport=stdio',
    ]);
    expect(option.env).toHaveLength(1);
    expect(option.env[0].name).toBe('BRAVE_API_KEY');
    expect(option.env[0].required).toBe(true);
    expect(option.env[0].secret).toBe(true);
  });
});

describe('modelscope provider', () => {
  it('maps server_config and env_schema to install options', async () => {
    mockFetchJson({
      data: {
        id: '@modelcontextprotocol/fetch',
        name: 'Fetch',
        chinese_name: '网页抓取',
        description: '抓取网页',
        is_hosted: true,
        server_config: [
          {
            mcpServers: {
              fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
            },
          },
        ],
        env_schema: {
          type: 'object',
          properties: {
            FETCH_API_KEY: { type: 'string', description: 'API key' },
          },
          required: ['FETCH_API_KEY'],
        },
        operational_urls: [],
        readme: '获取地址：https://example.com/token',
      },
    });

    const detail = await provider('modelscope').detail('@modelcontextprotocol/fetch');
    expect(detail.name).toBe('网页抓取');
    expect(detail.installName).toBe('fetch');
    expect(detail.obtainUrl).toBe('https://example.com/token');

    const option = detail.installOptions[0];
    expect(option.kind).toBe('stdio');
    expect(option.command).toBe('uvx');
    expect(option.args).toEqual(['mcp-server-fetch']);
    expect(option.env[0].name).toBe('FETCH_API_KEY');
    expect(option.env[0].required).toBe(true);
    expect(option.env[0].secret).toBe(true);
  });
});

/** 无原生安装配置的条目（用于手动兜底 / README 推断测试） */
const NO_CONFIG_FIXTURE = {
  _id: 'manual-only',
  name: 'manual-only',
  alias: '无配置条目',
  description: 'no install config',
  logo: '/static/logo_cache/manual-only.png',
  mcp_config: null,
  mcp_url: null,
  env: {},
  auth_type: 'none',
  overview: null,
};

const ALPHA_VANTAGE_FIXTURE = {
  _id: 'alpha-vantage',
  name: 'alpha-vantage',
  alias: '股票金融数据',
  description: 'Alpha Vantage 官方 MCP',
  mcp_config: {
    mcpServers: {
      alphavantage: {
        command: 'uvx',
        args: ['av-mcp', 'YOUR_API_KEY'],
      },
    },
  },
  mcp_url: {
    streamable_http_url: 'https://mcp.alphavantage.co/mcp?apikey=***',
  },
  env: {},
  auth_type: 'none',
  overview: null,
};

const NPX_PLACEHOLDER_FIXTURE = {
  _id: 'npx-placeholder',
  name: 'npx-placeholder',
  alias: 'npx 占位符',
  description: 'npx with placeholder arg',
  mcp_config: {
    mcpServers: {
      demo: {
        command: 'npx',
        args: ['-y', 'demo-mcp', 'YOUR_API_KEY'],
      },
    },
  },
  env: {},
  auth_type: 'none',
  mcp_url: null,
  overview: null,
};

const HEADER_PLACEHOLDER_FIXTURE = {
  _id: 'header-placeholder',
  name: 'header-placeholder',
  alias: '请求头占位符',
  description: 'header placeholder',
  mcp_config: null,
  mcp_url: {
    streamable_http_url: 'https://example.com/mcp',
    header_templates: {
      Authorization: 'Bearer ***',
    },
  },
  env: {},
  auth_type: 'none',
  overview: null,
};

const README_NPX_FIXTURE = {
  _id: 'readme-npx',
  name: 'readme-npx',
  alias: 'README npx',
  description: 'readme only',
  mcp_config: null,
  mcp_url: null,
  env: {},
  auth_type: 'none',
  overview: {
    zh: {
      how_to_use: '在本地运行：\n```bash\nnpx -y demo-mcp@1.0.0\n```',
    },
  },
};

describe('inferOptionsFromText', () => {
  it('extracts JSON config, npx command and MCP endpoint URL', () => {
    const text = [
      '```json',
      '{"mcpServers":{"demo":{"command":"npx","args":["-y","json-mcp@1.0.0"]}}}',
      '```',
      '也可运行 `npx -y inline-mcp@2.0.0`。',
      '远程地址：https://example.com/mcp',
    ].join('\n');
    const options = inferOptionsFromText(text);
    const stdio = options.filter((option) => option.kind === 'stdio');
    expect(stdio.some((option) => option.args?.includes('json-mcp@1.0.0'))).toBe(true);
    expect(stdio.some((option) => option.args?.includes('inline-mcp@2.0.0'))).toBe(true);
    expect(options.some((option) => option.kind === 'remote' && option.url === 'https://example.com/mcp')).toBe(true);
  });
});

describe('providers without native install config', () => {
  it('infers an npx option from README text', async () => {
    mockFetchJson(README_NPX_FIXTURE);
    const detail = await provider('mcpmarket').detail('readme-npx');
    expect(detail.installOptions).toHaveLength(1);
    expect(detail.installOptions[0].kind).toBe('stdio');
    expect(detail.installOptions[0].command).toBe('npx');
    expect(detail.installOptions[0].args).toEqual(['-y', 'demo-mcp@1.0.0']);
    expect(detail.installOptions[0].supported).toBe(true);
  });

  it('falls back to a manual option when nothing can be inferred', async () => {
    mockFetchJson(NO_CONFIG_FIXTURE);
    const detail = await provider('mcpmarket').detail('manual-only');
    expect(detail.installOptions).toHaveLength(1);
    expect(detail.installOptions[0].kind).toBe('manual');
    expect(detail.installOptions[0].supported).toBe(true);
  });

  it('modelscope falls back to manual when server_config and urls are empty', async () => {
    mockFetchJson({
      data: {
        id: 'owner/empty',
        name: 'empty',
        server_config: [],
        operational_urls: [],
        env_schema: { type: 'object', properties: {}, required: [] },
        readme: '',
      },
    });
    const detail = await provider('modelscope').detail('owner/empty');
    expect(detail.installOptions).toHaveLength(1);
    expect(detail.installOptions[0].kind).toBe('manual');
    expect(detail.installOptions[0].supported).toBe(true);
  });
});

describe('placeholder recognition', () => {
  it('templateizes args without misidentifying normal parameters', () => {
    expect(templateizeText('YOUR_API_KEY', [])).toEqual({
      text: '{YOUR_API_KEY}',
      names: ['YOUR_API_KEY'],
    });
    expect(templateizeText('--api-key=YOUR_API_KEY', [])).toEqual({
      text: '--api-key={YOUR_API_KEY}',
      names: ['YOUR_API_KEY'],
    });
    expect(templateizeText('Bearer YOUR_API_KEY', [])).toEqual({
      text: 'Bearer {YOUR_API_KEY}',
      names: ['YOUR_API_KEY'],
    });
    for (const normal of ['stdio', 'JSON', 'US', 'PROD', 'info']) {
      expect(templateizeText(normal, [])).toEqual({ text: normal, names: [] });
    }
  });

  it('maps generic placeholders to the only editable secret env field', () => {
    const envFields = [
      { name: 'ALPHAVANTAGE_API_KEY', required: false, secret: true, label: 'API Key' },
    ];
    expect(templateizeText('YOUR_API_KEY', envFields)).toEqual({
      text: '{ALPHAVANTAGE_API_KEY}',
      names: ['ALPHAVANTAGE_API_KEY'],
    });
  });

  it('templateizes URL query placeholders using the query key', () => {
    expect(templateizeUrl('https://mcp.alphavantage.co/mcp?apikey=***', [])).toEqual({
      text: 'https://mcp.alphavantage.co/mcp?apikey={API_KEY}',
      names: ['API_KEY'],
    });
    expect(templateizeUrl('https://example.com/mcp?token=YOUR_TOKEN', [])).toEqual({
      text: 'https://example.com/mcp?token={YOUR_TOKEN}',
      names: ['YOUR_TOKEN'],
    });
  });

  it('merges placeholder fields as required secret env', () => {
    const merged = mergePlaceholderFields([], ['YOUR_API_KEY']);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('YOUR_API_KEY');
    expect(merged[0].required).toBe(true);
    expect(merged[0].secret).toBe(true);
  });

  it('maps Alpha Vantage args and URL placeholders to install options', async () => {
    mockFetchJson(ALPHA_VANTAGE_FIXTURE);
    const detail = await provider('mcpmarket').detail('alpha-vantage');

    const stdio = detail.installOptions.find((option) => option.kind === 'stdio');
    expect(stdio?.args).toEqual(['av-mcp', '{YOUR_API_KEY}']);
    const argField = stdio?.env.find((field) => field.name === 'YOUR_API_KEY');
    expect(argField?.required).toBe(true);
    expect(argField?.secret).toBe(true);

    const remote = detail.installOptions.find((option) => option.kind === 'remote');
    expect(remote?.url).toBe('https://mcp.alphavantage.co/mcp?apikey={API_KEY}');
    expect(remote?.supported).toBe(true);
    const urlField = remote?.env.find((field) => field.name === 'API_KEY');
    expect(urlField?.required).toBe(true);
    expect(urlField?.secret).toBe(true);
  });

  it('recognizes header placeholders such as Bearer ***', async () => {
    mockFetchJson(HEADER_PLACEHOLDER_FIXTURE);
    const detail = await provider('mcpmarket').detail('header-placeholder');
    const remote = detail.installOptions.find((option) => option.kind === 'remote');
    expect(remote?.headerTemplates?.Authorization).toBe('Bearer {AUTH_TOKEN}');
    const field = remote?.env.find((item) => item.name === 'AUTH_TOKEN');
    expect(field?.required).toBe(true);
    expect(field?.secret).toBe(true);
    expect(remote?.supported).toBe(true);
  });
});

// ============================================================================
// 安装编排（fake manager：不落盘、不真正启动子进程）
// ============================================================================

interface FakeServer {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  enabled: boolean;
  transport?: string;
  market?: ServerConfig['market'];
}

interface FakeCall {
  op: 'create' | 'update' | 'connect';
  name: string;
  def?: ServerConfig;
}

function createFakeManager(initial: FakeServer[] = []): {
  manager: MCPManager;
  calls: FakeCall[];
} {
  const servers = initial.map((server) => ({ ...server }));
  const calls: FakeCall[] = [];
  const manager = {
    listServers: () => servers.map((server) => ({ ...server })),
    createServer: async (name: string, def: unknown) => {
      const config = def as ServerConfig;
      calls.push({ op: 'create', name, def: config });
      servers.push({
        name,
        status: 'disconnected',
        toolCount: 0,
        enabled: true,
        transport: config.transport,
        ...(config.market ? { market: config.market } : {}),
      });
    },
    updateServer: async (name: string, def: unknown) => {
      calls.push({ op: 'update', name, def: def as ServerConfig });
    },
    connect: async (name: string) => {
      calls.push({ op: 'connect', name });
    },
    disconnect: async () => {},
    reloadAll: async () => {},
    listTools: () => [],
    isServerEnabled: () => true,
    getToolAnnotations: () => null,
    callTool: async () => ({ content: [] }),
    deleteServer: async () => {},
  } as unknown as MCPManager;
  return { manager, calls };
}

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const fakeEventBus = {
  broadcast: async () => {},
} as unknown as EventBus;

function createService(initial: FakeServer[] = []) {
  const { manager, calls } = createFakeManager(initial);
  const service = new McpMarketServiceImpl({
    manager,
    eventBus: fakeEventBus,
    logger: fakeLogger,
  });
  return { service, calls };
}

describe('McpMarketServiceImpl install', () => {
  it('writes a stdio config with merged env and waits for connection', async () => {
    mockFetchJson(ESIGN_FIXTURE);
    const { service, calls } = createService();

    const result = await service.install(
      { source: 'mcpmarket', id: 'esign', env: { APP_ID: 'app', APP_SECRET: 'secret' } },
      { awaitConnect: true },
    );

    expect(result).toEqual({
      name: 'esign-mcp',
      installed: true,
      connected: true,
    });
    const created = calls.find((call) => call.op === 'create');
    expect(created?.def).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server-esign@1.1.2'],
      env: { APP_ID: 'app', APP_SECRET: 'secret', PYTHONUNBUFFERED: '1' },
      market: { source: 'mcpmarket', id: 'esign' },
    });
    expect(calls.some((call) => call.op === 'connect')).toBe(true);
  });

  it('adds -y to npx args when the market config does not include it', async () => {
    mockFetchJson(NPM_NO_YES_FIXTURE);
    const { service, calls } = createService();

    await service.install({ source: 'mcpmarket', id: 'npx-no-yes' }, { awaitConnect: true });

    const created = calls.find((call) => call.op === 'create');
    expect(created?.def?.command).toBe('npx');
    expect(created?.def?.args).toEqual(['-y', 'mcp-server-demo@1.0.0']);
  });

  it('rejects missing required env', async () => {
    mockFetchJson(ESIGN_FIXTURE);
    const { service } = createService();

    let error: unknown;
    try {
      await service.install({ source: 'mcpmarket', id: 'esign', env: { APP_ID: 'app' } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(McpMarketError);
    expect((error as McpMarketError).code).toBe('ENV_REQUIRED');
    expect((error as McpMarketError).details?.missing).toEqual(['APP_SECRET']);
  });

  it('returns a suggested name on conflict with another source', async () => {
    mockFetchJson(ESIGN_FIXTURE);
    const { service } = createService([
      {
        name: 'esign-mcp',
        status: 'disconnected',
        toolCount: 0,
        enabled: true,
        transport: 'stdio',
        market: { source: 'official', id: 'io.github.other/esign' },
      },
    ]);

    let error: unknown;
    try {
      await service.install(
        { source: 'mcpmarket', id: 'esign', env: { APP_ID: 'app', APP_SECRET: 'secret' } },
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(McpMarketError);
    expect((error as McpMarketError).code).toBe('NAME_CONFLICT');
    expect((error as McpMarketError).details?.suggestedName).toBe('esign-mcp-2');
  });

  it('updates the existing server when reinstalling the same market entry', async () => {
    mockFetchJson(ESIGN_FIXTURE);
    const { service, calls } = createService([
      {
        name: 'esign-mcp',
        status: 'connected',
        toolCount: 3,
        enabled: true,
        transport: 'stdio',
        market: { source: 'mcpmarket', id: 'esign' },
      },
    ]);

    const result = await service.install(
      { source: 'mcpmarket', id: 'esign', env: { APP_ID: 'new', APP_SECRET: 'new-secret' } },
      { awaitConnect: true },
    );

    expect(result.updated).toBe(true);
    expect(calls.some((call) => call.op === 'update')).toBe(true);
    expect(calls.some((call) => call.op === 'create')).toBe(false);
  });

  it('installs a manual stdio config and persists the market icon', async () => {
    mockFetchJson(NO_CONFIG_FIXTURE);
    const { service, calls } = createService();

    const result = await service.install(
      {
        source: 'mcpmarket',
        id: 'manual-only',
        manual: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'demo-mcp@1.0.0'],
          env: { API_KEY: 'secret-value' },
        },
      },
      { awaitConnect: true },
    );

    expect(result.connected).toBe(true);
    const created = calls.find((call) => call.op === 'create');
    expect(created?.def).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'demo-mcp@1.0.0'],
      env: { API_KEY: 'secret-value' },
      market: {
        source: 'mcpmarket',
        id: 'manual-only',
        iconUrl: 'https://mcpmarket.cn/static/logo_cache/manual-only.png',
      },
    });
  });

  it('installs a manual remote config', async () => {
    mockFetchJson(NO_CONFIG_FIXTURE);
    const { service, calls } = createService();

    await service.install(
      {
        source: 'mcpmarket',
        id: 'manual-only',
        manual: {
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      },
      { awaitConnect: true },
    );

    const created = calls.find((call) => call.op === 'create');
    expect(created?.def).toEqual({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      market: {
        source: 'mcpmarket',
        id: 'manual-only',
        iconUrl: 'https://mcpmarket.cn/static/logo_cache/manual-only.png',
      },
    });
  });

  it('rejects manual remote config with a non-http protocol', async () => {
    mockFetchJson(NO_CONFIG_FIXTURE);
    const { service } = createService();

    let error: unknown;
    try {
      await service.install({
        source: 'mcpmarket',
        id: 'manual-only',
        manual: { transport: 'http', url: 'ftp://example.com/mcp' },
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(McpMarketError);
    expect((error as McpMarketError).code).toBe('OPTION_INVALID');
  });

  it('substitutes arg placeholders with user input', async () => {
    mockFetchJson(NPX_PLACEHOLDER_FIXTURE);
    const { service, calls } = createService();

    await service.install(
      {
        source: 'mcpmarket',
        id: 'npx-placeholder',
        optionIndex: 0,
        env: { YOUR_API_KEY: 'abc' },
      },
      { awaitConnect: true },
    );

    const created = calls.find((call) => call.op === 'create');
    expect(created?.def?.command).toBe('npx');
    expect(created?.def?.args).toEqual(['-y', 'demo-mcp', 'abc']);
    expect(created?.def?.env).toEqual({ YOUR_API_KEY: 'abc' });
  });

  it('substitutes and URL-encodes remote URL placeholders', async () => {
    mockFetchJson(ALPHA_VANTAGE_FIXTURE);
    const { service, calls } = createService();

    await service.install(
      {
        source: 'mcpmarket',
        id: 'alpha-vantage',
        optionIndex: 1,
        env: { API_KEY: 'a b' },
        name: 'alpha-vantage-http',
      },
      { awaitConnect: true },
    );

    const created = calls.find((call) => call.op === 'create');
    expect(created?.def?.transport).toBe('http');
    expect(created?.def?.url).toBe('https://mcp.alphavantage.co/mcp?apikey=a%20b');
  });
});

describe('McpMarketServiceImpl query cache', () => {
  it('dedupes concurrent queries and caches the result', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          current_page: 1,
          servers: [],
          total_pages: 1,
          total_servers: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const { service } = createService();

    await Promise.all([
      service.query({ source: 'mcpmarket' }),
      service.query({ source: 'mcpmarket' }),
    ]);
    await service.query({ source: 'mcpmarket' });
    expect(calls).toBe(1);
  });
});
