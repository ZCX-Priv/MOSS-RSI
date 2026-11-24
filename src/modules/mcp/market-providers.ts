// src/modules/mcp/market-providers.ts
// MCP 市场数据源适配器（mcpmarket / official / modelscope）。
//
// 三个源的字段差异在这里收敛为统一的 McpMarketItem / McpMarketDetail /
// McpMarketInstallOption，供 market.ts 的安装编排与前端安装弹窗消费。
// 所有网络请求 15s 超时；失败统一抛 McpMarketError。

import { spawnSync } from 'node:child_process';

// ============================================================================
// 类型
// ============================================================================

export type McpMarketSource = 'mcpmarket' | 'official' | 'modelscope';

export type McpMarketErrorCode =
  | 'SOURCE_INVALID'
  | 'UPSTREAM_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'NO_INSTALL_OPTION'
  | 'OPTION_INVALID'
  | 'ENV_REQUIRED'
  | 'NAME_INVALID'
  | 'NAME_CONFLICT'
  | 'INSTALL_FAILED';

export class McpMarketError extends Error {
  constructor(
    public readonly code: McpMarketErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'McpMarketError';
  }
}

export interface McpMarketEnvField {
  name: string;
  label?: string;
  description?: string;
  required: boolean;
  secret: boolean;
  default?: string;
  placeholder?: string;
  choices?: string[];
  format?: 'string' | 'number' | 'boolean' | 'filepath';
  /** 固定值：来自配置中的常量 env，不在弹窗中编辑，但会写入最终配置 */
  fixedValue?: string;
}

export interface McpMarketInstallOption {
  index: number;
  /** manual = 市场没有可用配置时的手动兜底（命令/URL 由用户在安装弹窗填写） */
  kind: 'stdio' | 'remote' | 'manual';
  transport: 'stdio' | 'http' | 'sse';
  /** 展示标签，如 "npx · @scope/pkg@1.2.3" */
  label: string;
  registryType?: string;
  command?: string;
  args?: string[];
  url?: string;
  env: McpMarketEnvField[];
  /** 远程传输的请求头模板（值可含 {VAR} 占位符） */
  headerTemplates?: Record<string, string>;
  supported: boolean;
  unsupportedReason?: string;
}

export interface McpMarketItem {
  source: McpMarketSource;
  id: string;
  name: string;
  nameEn?: string;
  slug: string;
  installName: string;
  description: string;
  version?: string;
  iconUrl?: string;
  homepage?: string;
  stars?: number;
  views?: number;
  verified?: boolean;
  hosted?: boolean;
  updatedAt?: string;
}

export interface McpMarketDetail extends McpMarketItem {
  installOptions: McpMarketInstallOption[];
  obtainUrl?: string;
  readme?: string;
}

export interface McpMarketQueryResult {
  items: McpMarketItem[];
  nextPageToken?: string;
  total?: number;
}

export interface McpMarketProvider {
  id: McpMarketSource;
  query(keyword: string, pageToken: string | undefined, pageSize: number): Promise<McpMarketQueryResult>;
  detail(id: string): Promise<McpMarketDetail>;
}

// ============================================================================
// 公共工具
// ============================================================================

const FETCH_TIMEOUT_MS = 15_000;

/** 统一 JSON 请求：15s 超时，非 2xx 抛错 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new McpMarketError('UPSTREAM_UNAVAILABLE', `market request failed: ${url}`);
  }
  if (!res.ok) {
    throw new McpMarketError(
      res.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_UNAVAILABLE',
      `market HTTP ${res.status}: ${url}`,
    );
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new McpMarketError('UPSTREAM_UNAVAILABLE', `invalid market response: ${url}`);
  }
}

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 取本地化文本（{zh,en} / 字符串） */
export function localizedText(v: unknown, lang: 'zh' | 'en' = 'zh'): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    const picked = lang === 'zh' ? (rec.zh ?? rec.en) : (rec.en ?? rec.zh);
    return asString(picked);
  }
  return '';
}

/** 名称归一化：小写，仅保留 [a-z0-9_-]，数字开头补 mcp- */
export function sanitizeServerName(raw: string): string {
  const n = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!n) return 'mcp-server';
  return /^[a-z]/.test(n) ? n : `mcp-${n}`;
}

/** 取 id 最后一段（owner/name → name） */
export function lastSegment(raw: string): string {
  const parts = raw.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? raw).replace(/^@+/, '');
}

/** 是否像「待填写」的占位值（空 / *** / your-* / <...> / ... / xxx） */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v === '***' || v === '...') return true;
  if (/^<.*>$/.test(v)) return true;
  if (/^your[-_ ]/i.test(v)) return true;
  return /^x{3,}$/i.test(v);
}

/** 提取文本中的第一个 http(s) URL */
export function firstUrl(text?: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/https?:\/\/[^\s"'<>()\]]+/i);
  return m?.[0];
}

/** 推断环境变量是否敏感 */
export function isSecretName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name);
}

const commandCache = new Map<string, boolean>();

/** 命令是否可用（where/which；shell:false） */
export function commandExists(cmd: string): boolean {
  const cached = commandCache.get(cmd);
  if (cached !== undefined) return cached;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(probe, [cmd], { stdio: 'ignore', shell: false });
  const ok = res.status === 0;
  commandCache.set(cmd, ok);
  return ok;
}

/** stdio 命令支持度判定 */
export function stdioCommandSupport(command: string): { supported: boolean; reason?: string } {
  const base = command.toLowerCase().replace(/\.cmd$/, '');
  if (base === 'npx' || base === 'bunx') return { supported: true };
  if (base === 'uvx') {
    return commandExists('uvx')
      ? { supported: true }
      : { supported: false, reason: '需要先安装 uv（uvx）' };
  }
  if (base === 'docker') {
    return commandExists('docker')
      ? { supported: true }
      : { supported: false, reason: '需要安装 Docker' };
  }
  return { supported: false, reason: `不支持自动安装的命令：${command}` };
}

/** 从 header 模板中提取 {VAR} 变量名 */
export function extractTemplateVars(templates: Record<string, string> | undefined): string[] {
  const out = new Set<string>();
  for (const template of Object.values(templates ?? {})) {
    const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(template))) out.add(m[1]);
  }
  return Array.from(out);
}

/** 应用 header 模板：未提供的变量返回 missing */
export function applyHeaderTemplates(
  templates: Record<string, string>,
  values: Record<string, string>,
): { headers: Record<string, string>; missing: string[] } {
  const headers: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [header, template] of Object.entries(templates)) {
    let rendered = template;
    const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(template))) {
      const name = m[1];
      const value = values[name];
      if (value === undefined || value === '') {
        missing.add(name);
      } else {
        rendered = rendered.split(`{${name}}`).join(value);
      }
    }
    headers[header] = rendered;
  }
  return { headers, missing: Array.from(missing) };
}

/** 由 config.headers 生成模板（字面值直接固定） */
export function headerTemplatesFromHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value) out[name] = value;
  }
  return out;
}

function toEnvField(
  name: string,
  opts: Partial<Omit<McpMarketEnvField, 'name'>> = {},
): McpMarketEnvField {
  return {
    name,
    label: opts.label ?? name,
    description: opts.description,
    required: opts.required ?? false,
    secret: opts.secret ?? isSecretName(name),
    default: opts.default,
    placeholder: opts.placeholder ?? name,
    choices: opts.choices,
    format: opts.format ?? 'string',
    fixedValue: opts.fixedValue,
  };
}

/** 从 config.env 合并出输入项 + 固定项（同名字段以 config 中的常量值为准） */
function mergeConfigEnv(
  fields: McpMarketEnvField[],
  rawEnv: Record<string, unknown> | undefined,
  requiredDefault: boolean,
): McpMarketEnvField[] {
  const out = fields.map((field) => ({ ...field }));
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) return out;
  const index = new Map(out.map((field, i) => [field.name, i]));
  for (const [name, raw] of Object.entries(rawEnv ?? {})) {
    const value = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
    const existingIndex = index.get(name);
    if (existingIndex !== undefined) {
      if (!isPlaceholderValue(value)) {
        out[existingIndex] = {
          ...out[existingIndex],
          fixedValue: value,
          required: false,
        };
      } else if (requiredDefault) {
        out[existingIndex] = { ...out[existingIndex], required: true };
      }
      continue;
    }
    index.set(name, out.length);
    if (isPlaceholderValue(value)) {
      out.push(
        toEnvField(name, {
          required: requiredDefault,
          placeholder: value || name,
          secret: isSecretName(name),
        }),
      );
    } else {
      out.push(toEnvField(name, { required: false, fixedValue: value }));
    }
  }
  return out;
}

function dedupeOptions(options: McpMarketInstallOption[]): McpMarketInstallOption[] {
  const seen = new Set<string>();
  const out: McpMarketInstallOption[] = [];
  for (const option of options) {
    const key = `${option.kind}|${option.command ?? ''}|${option.url ?? ''}|${(option.args ?? []).join('\u0000')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...option, index: out.length });
  }
  return out;
}

// ============================================================================
// 占位符识别与模板化
// ----------------------------------------------------------------------------
// 市场配置中常见 args / url / headers 里直接写 YOUR_API_KEY、*** 等占位符。
// 这里统一转成 {VAR} 模板 + 必填 env 字段，安装时由后端替换成用户输入。
// ============================================================================

export interface TemplateOutcome {
  text: string;
  names: string[];
}

const FIELD_NAME_ALIASES: Record<string, string> = {
  APIKEY: 'API_KEY',
  ACCESSTOKEN: 'ACCESS_TOKEN',
  AUTHTOKEN: 'AUTH_TOKEN',
  CLIENTID: 'CLIENT_ID',
  CLIENTSECRET: 'CLIENT_SECRET',
};

const GENERIC_SECRET_NAMES = new Set([
  'API_KEY',
  'APIKEY',
  'KEY',
  'TOKEN',
  'ACCESS_TOKEN',
  'AUTH_TOKEN',
  'SECRET',
  'CLIENT_SECRET',
  'PASSWORD',
  'CREDENTIAL',
  'CREDENTIALS',
]);

/** 生成合法环境变量名（大写、下划线、数字开头补 VAR_） */
function normalizeFieldName(raw: string): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return '';
  const aliased = FIELD_NAME_ALIASES[cleaned] ?? cleaned;
  const withPrefix = /^[0-9]/.test(aliased) ? `VAR_${aliased}` : aliased;
  return /^[A-Z_][A-Z0-9_]{1,63}$/.test(withPrefix) ? withPrefix : '';
}

/** 判断字符串是否是占位符，并返回规范化后的变量名（*** / ... 返回 null） */
function normalizePlaceholderToken(raw: string): string | null {
  const token = raw.trim();
  if (!token || token.length > 64) return null;
  const unwrapped = token
    .replace(/^\$\{([^}]+)\}$/, '$1')
    .replace(/^\{\{([^}]+)\}\}$/, '$1')
    .replace(/^<([^>]+)>$/, '$1')
    .replace(/^\{([^}]+)\}$/, '$1')
    .trim();
  if (!unwrapped) return null;
  const placeholder = isPlaceholderValue(unwrapped);
  const secretLike =
    /^[A-Z][A-Z0-9_-]{3,}$/.test(unwrapped) &&
    /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(unwrapped);
  if (!placeholder && !secretLike) return null;
  return normalizeFieldName(unwrapped) || null;
}

/** 通用密钥名（可映射到市场已声明的唯一 secret 字段） */
function isGenericSecretName(name: string): boolean {
  if (GENERIC_SECRET_NAMES.has(name)) return true;
  return /^YOUR_(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/.test(name);
}

/** 优先复用已声明的同名/唯一 secret 字段，避免重复输入 */
function pickFieldName(name: string, envFields: McpMarketEnvField[]): string {
  if (envFields.some((field) => field.name === name && field.fixedValue === undefined)) {
    return name;
  }
  if (isGenericSecretName(name)) {
    const editableSecrets = envFields.filter(
      (field) => field.fixedValue === undefined && field.secret,
    );
    if (editableSecrets.length === 1) return editableSecrets[0].name;
  }
  return name;
}

/** 合并占位符字段：已存在则标记必填，不存在则新增 */
export function mergePlaceholderFields(
  envFields: McpMarketEnvField[],
  names: string[],
  opts: { forceSecret?: boolean } = {},
): McpMarketEnvField[] {
  const out = envFields.map((field) => ({ ...field }));
  for (const name of names) {
    const index = out.findIndex((field) => field.name === name);
    if (index >= 0) {
      if (out[index].fixedValue === undefined) {
        out[index] = {
          ...out[index],
          required: true,
          ...(opts.forceSecret ? { secret: true } : {}),
        };
      }
      continue;
    }
    out.push(
      toEnvField(name, {
        required: true,
        secret: opts.forceSecret === true || isSecretName(name),
      }),
    );
  }
  return out;
}

/** 把字符串中的占位符替换为 {VAR}，返回模板与变量名 */
export function templateizeText(
  text: string,
  envFields: McpMarketEnvField[],
): TemplateOutcome {
  const names: string[] = [];
  const resolve = (raw: string): string | null => {
    const normalized = normalizePlaceholderToken(raw);
    if (!normalized) return null;
    const name = pickFieldName(normalized, envFields);
    if (!names.includes(name)) names.push(name);
    return name;
  };

  const whole = resolve(text);
  if (whole) return { text: `{${whole}}`, names };

  let out = text.replace(
    /\$\{([^}]+)\}|\{\{([^}]+)\}\}|<([^>]+)>|\{([^}]+)\}/g,
    (match: string, ...groups: Array<string | undefined>) => {
      const inner =
        groups.find((value): value is string => typeof value === 'string' && value.length > 0) ??
        '';
      const name = resolve(inner);
      return name ? `{${name}}` : match;
    },
  );

  out = out
    .split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/g)
    .map((segment) => {
      if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)) return segment;
      return segment.replace(/[A-Za-z][A-Za-z0-9_-]*/g, (token) => {
        const name = resolve(token);
        return name ? `{${name}}` : token;
      });
    })
    .join('');

  return { text: out, names };
}

/** args 模板化（URL 参数走 URL 解析，其他走文本 token 识别） */
export function templateizeArgs(
  args: string[],
  envFields: McpMarketEnvField[],
): { args: string[]; names: string[] } {
  const names: string[] = [];
  const out = args.map((arg) => {
    const result = /^https?:\/\//i.test(arg)
      ? templateizeUrl(arg, envFields)
      : templateizeText(arg, envFields);
    for (const name of result.names) {
      if (!names.includes(name)) names.push(name);
    }
    return result.text;
  });
  return { args: out, names };
}

/** 请求头键名 → 变量名（Authorization 统一 AUTH_TOKEN） */
function headerFieldName(headerName: string): string {
  const lower = headerName.trim().toLowerCase();
  if (lower === 'authorization' || lower === 'proxy-authorization') return 'AUTH_TOKEN';
  if (lower === 'x-api-key' || lower === 'api-key' || lower === 'apikey') return 'API_KEY';
  return normalizeFieldName(headerName) || 'HEADER_VALUE';
}

/** headers 模板化（支持 Bearer YOUR_API_KEY / Bearer ***） */
export function templateizeHeaders(
  headers: Record<string, string>,
  envFields: McpMarketEnvField[],
): { templates: Record<string, string>; names: string[] } {
  const templates: Record<string, string> = {};
  const names: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const outcome = templateizeText(value, envFields);
    if (outcome.names.length > 0) {
      templates[key] = outcome.text;
      for (const name of outcome.names) {
        if (!names.includes(name)) names.push(name);
      }
      continue;
    }
    const trimmed = value.trim();
    const prefixMatch = trimmed.match(/^(\S+\s+)(\*\*\*|\.{3})$/);
    if (isPlaceholderValue(trimmed) || prefixMatch) {
      const name = pickFieldName(headerFieldName(key), envFields);
      const prefix = prefixMatch ? prefixMatch[1] : '';
      templates[key] = `${prefix}{${name}}`;
      if (!names.includes(name)) names.push(name);
      continue;
    }
    templates[key] = value;
  }
  return { templates, names };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** URL 模板化：查询参数值中的占位符优先用查询键命名（apikey=*** → {API_KEY}） */
export function templateizeUrl(
  url: string,
  envFields: McpMarketEnvField[],
): TemplateOutcome {
  const names: string[] = [];
  const add = (name: string): void => {
    if (!names.includes(name)) names.push(name);
  };

  let out = url.replace(
    /([?&])([^=&#]+)=([^&#]*)/g,
    (match: string, separator: string, rawKey: string, rawValue: string) => {
      const value = safeDecode(rawValue);
      const direct = normalizePlaceholderToken(value);
      if (direct) {
        const name = pickFieldName(direct, envFields);
        add(name);
        return `${separator}${rawKey}={${name}}`;
      }
      if (isPlaceholderValue(value)) {
        const keyName = normalizeFieldName(safeDecode(rawKey)) || 'API_KEY';
        const name = pickFieldName(keyName, envFields);
        add(name);
        return `${separator}${rawKey}={${name}}`;
      }
      return match;
    },
  );

  const rest = templateizeText(out, envFields);
  out = rest.text;
  for (const name of rest.names) add(name);
  return { text: out, names };
}

/** URL/headers 是否覆盖了所有可编辑 env 字段（用于远端 option 支持度判定） */
function isEnvMapped(
  envFields: McpMarketEnvField[],
  urlTemplate: string,
  headerTemplates: Record<string, string> | undefined,
): boolean {
  const refs = new Set<string>();
  const collect = (text: string): void => {
    const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) refs.add(match[1]);
  };
  collect(urlTemplate);
  for (const value of Object.values(headerTemplates ?? {})) collect(value);
  return envFields.every(
    (field) => field.fixedValue !== undefined || refs.has(field.name),
  );
}

/** 确保至少有一条可安装路径：没有 supported 时追加手动配置兜底 */
function ensureManualOption(
  options: McpMarketInstallOption[],
  envFields: McpMarketEnvField[] = [],
): McpMarketInstallOption[] {
  if (options.some((option) => option.supported)) return options;
  return dedupeOptions([
    ...options,
    {
      index: 0,
      kind: 'manual',
      transport: 'stdio',
      label: '手动配置（自定义命令或 URL）',
      // 市场声明的变量作为手动表单的预填提示（名称/默认值）
      env: envFields.map((field) => ({ ...field })),
      supported: true,
    },
  ]);
}

/** 从一份 mcpServers 配置条目生成安装方式（README 推断与原生 provider 共用） */
function optionFromConfigEntry(
  cfg: Record<string, unknown>,
  baseEnv: McpMarketEnvField[],
  labelPrefix?: string,
): McpMarketInstallOption | null {
  const base = mergeConfigEnv(baseEnv, cfg.env as Record<string, unknown> | undefined, false);
  const url = asString(cfg.url);
  if (url) {
    const typeRaw = asString(cfg.type).toLowerCase();
    const transport: 'http' | 'sse' = typeRaw === 'sse' ? 'sse' : 'http';
    const headers = headerTemplatesFromHeaders(cfg.headers as Record<string, unknown> | undefined);
    const urlOutcome = templateizeUrl(url, base);
    let env = mergePlaceholderFields(base, urlOutcome.names);
    const headerOutcome = templateizeHeaders(headers, env);
    env = mergePlaceholderFields(env, headerOutcome.names, { forceSecret: true });
    const mapped = isEnvMapped(
      env.filter((field) => field.required),
      urlOutcome.text,
      headerOutcome.templates,
    );
    return {
      index: 0,
      kind: 'remote',
      transport,
      label: labelPrefix
        ? `${labelPrefix} · 远程`
        : `远程 · ${transport === 'sse' ? 'sse' : 'streamable-http'}`,
      url: urlOutcome.text,
      env,
      ...(Object.keys(headerOutcome.templates).length > 0
        ? { headerTemplates: headerOutcome.templates }
        : {}),
      supported: mapped,
      ...(mapped
        ? {}
        : { unsupportedReason: '该远程地址需要认证，请使用手动配置填写请求头' }),
    };
  }
  const command = asString(cfg.command);
  if (!command) return null;
  const rawArgs = Array.isArray(cfg.args) ? cfg.args.map((value) => String(value)) : [];
  const argOutcome = templateizeArgs(rawArgs, base);
  const env = mergePlaceholderFields(base, argOutcome.names);
  const spec = argOutcome.args.filter((value) => !value.startsWith('-')).join(' ');
  const support = stdioCommandSupport(command);
  return {
    index: 0,
    kind: 'stdio',
    transport: 'stdio',
    label: `${labelPrefix ?? command}${spec ? ` · ${spec}` : ''}`.slice(0, 100),
    command,
    args: argOutcome.args,
    env,
    supported: support.supported,
    ...(support.reason ? { unsupportedReason: support.reason } : {}),
  };
}

/** 解析 JSON 配置对象（mcpServers 包装或单条配置） */
function optionsFromParsedConfig(
  parsed: unknown,
  baseEnv: McpMarketEnvField[],
): McpMarketInstallOption[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const servers = record.mcpServers;
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    const out: McpMarketInstallOption[] = [];
    for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
      const option = optionFromConfigEntry(cfg as Record<string, unknown>, baseEnv, name);
      if (option) out.push(option);
    }
    return out;
  }
  const single = optionFromConfigEntry(record, baseEnv);
  return single ? [single] : [];
}

/**
 * 从 README / overview 文本保守推断安装方式：
 *   1. 围栏代码块中的 JSON（mcpServers / command / url）
 *   2. 代码块或行内代码中的 npx / uvx 命令
 *   3. 以 /mcp、/sse、/message 结尾的 MCP 端点 URL
 * 最多返回 4 条，供“市场没有原生安装配置”的条目使用。
 */
export function inferOptionsFromText(
  text: string,
  baseEnv: McpMarketEnvField[] = [],
): McpMarketInstallOption[] {
  if (!text.trim()) return [];
  const out: McpMarketInstallOption[] = [];

  // 收集代码块与行内代码（命令只在代码语境里推断，避免把正文里的 npx 单词当成包名）
  const blocks: string[] = [];
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let fence: RegExpExecArray | null;
  while ((fence = fenceRe.exec(text))) {
    const body = fence[1].trim();
    if (!body) continue;
    blocks.push(body);
    if (!body.includes('{')) continue;
    try {
      out.push(...optionsFromParsedConfig(JSON.parse(body), baseEnv));
    } catch {
      // 非 JSON 代码块：交给下面的命令/URL 推断
    }
  }
  const inlineRe = /`([^`\n]+)`/g;
  let inline: RegExpExecArray | null;
  while ((inline = inlineRe.exec(text))) blocks.push(inline[1]);
  const codeText = blocks.join('\n');

  const npxRe = /(?:^|[\s`"'])(npx)(?:\s+-{1,2}(?:y|yes))?\s+([^\s`"']+)/gim;
  const uvxRe = /(?:^|[\s`"'])(uvx)\s+([^\s`"']+)/gim;
  for (const [command, re] of [
    ['npx', npxRe],
    ['uvx', uvxRe],
  ] as const) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(codeText))) {
      const rawSpec = match[2].replace(/[),.;]+$/, '');
      if (!rawSpec || rawSpec.startsWith('-') || rawSpec.includes('://')) continue;
      if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:@[A-Za-z0-9._^~+-]+)?$/.test(rawSpec)) {
        continue;
      }
      const support = stdioCommandSupport(command);
      out.push({
        index: 0,
        kind: 'stdio',
        transport: 'stdio',
        label: `${command} · ${rawSpec}`.slice(0, 100),
        command,
        args: command === 'npx' ? ['-y', rawSpec] : [rawSpec],
        env: baseEnv.map((field) => ({ ...field })),
        supported: support.supported,
        ...(support.reason ? { unsupportedReason: support.reason } : {}),
      });
    }
  }

  const urlRe = /https?:\/\/[^\s`"'<>)\]]+(?:\/mcp|\/sse|\/message)\/?/gi;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRe.exec(text))) {
    const rawUrl = urlMatch[0].replace(/[),.;]+$/, '');
    const transport: 'http' | 'sse' = /\/sse\/?$/i.test(rawUrl) ? 'sse' : 'http';
    const urlOutcome = templateizeUrl(rawUrl, baseEnv);
    const env = mergePlaceholderFields(baseEnv, urlOutcome.names);
    // 远程地址无法确认 env → header 的映射：必填 env 未被 URL/headers 覆盖时标记不可用
    const mapped = isEnvMapped(
      env.filter((field) => field.required),
      urlOutcome.text,
      undefined,
    );
    out.push({
      index: 0,
      kind: 'remote',
      transport,
      label: `远程 · ${transport === 'sse' ? 'sse' : 'streamable-http'}`,
      url: urlOutcome.text,
      env,
      supported: mapped,
      ...(mapped
        ? {}
        : { unsupportedReason: '该远程地址需要认证，请使用手动配置填写请求头' }),
    });
  }

  return dedupeOptions(out).slice(0, 4);
}

// ============================================================================
// mcpmarket.cn
// ============================================================================

const MCPMARKET_BASE = 'https://mcpmarket.cn';

interface McpMarketCnServer {
  _id?: unknown;
  name?: unknown;
  alias?: unknown;
  alias_en?: unknown;
  description?: unknown;
  logo?: unknown;
  url?: unknown;
  stars?: unknown;
  hosted?: unknown;
  featured?: unknown;
  created_at?: unknown;
}

interface McpMarketCnConfigEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  type?: unknown;
  headers?: unknown;
}

interface McpMarketCnDetail extends McpMarketCnServer {
  mcp_config?: { mcpServers?: Record<string, McpMarketCnConfigEntry> } | null;
  mcp_url?: {
    streamable_http_url?: unknown;
    sse_url?: unknown;
    header_templates?: unknown;
    auth_help?: unknown;
  } | null;
  env?: unknown;
  auth_type?: unknown;
  header_templates?: unknown;
  auth_help?: unknown;
  overview?: unknown;
}

function cnDescription(raw: unknown): string {
  return localizedText(raw) || localizedText(raw, 'en');
}

function cnIconUrl(raw: unknown): string | undefined {
  const logo = asString(raw);
  if (!logo) return undefined;
  if (logo.startsWith('/')) return `${MCPMARKET_BASE}${logo}`;
  return logo;
}

function cnToItem(raw: McpMarketCnServer): McpMarketItem {
  const slug = asString(raw.name) || asString(raw.alias_en) || asString(raw.alias);
  return {
    source: 'mcpmarket',
    id: asString(raw._id),
    name: asString(raw.alias) || asString(raw.alias_en) || asString(raw.name),
    nameEn: asString(raw.alias_en) || undefined,
    slug,
    installName: sanitizeServerName(lastSegment(slug)),
    description: cnDescription(raw.description),
    iconUrl: cnIconUrl(raw.logo),
    homepage: asString(raw.url) || undefined,
    stars: asNumber(raw.stars),
    verified: false,
    hosted: raw.hosted === true,
    updatedAt: asString(raw.created_at) || undefined,
  };
}

function cnHeaderTemplates(detail: McpMarketCnDetail): Record<string, string> {
  const direct = detail.header_templates;
  const fromUrl = detail.mcp_url?.header_templates;
  const raw = direct && typeof direct === 'object' ? direct : fromUrl;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value) out[name] = value;
  }
  return out;
}

function cnAuthHelp(detail: McpMarketCnDetail): Record<string, unknown> {
  const direct = detail.auth_help;
  const fromUrl = detail.mcp_url?.auth_help;
  const raw = direct && typeof direct === 'object' ? direct : fromUrl;
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function cnObtainUrl(detail: McpMarketCnDetail): string | undefined {
  const help = cnAuthHelp(detail);
  const direct = asString(help.obtain_url) || asString(help.url);
  if (direct) return direct;
  const overview = detail.overview;
  if (overview && typeof overview === 'object') {
    const rec = overview as Record<string, unknown>;
    const zh = rec.zh && typeof rec.zh === 'object' ? (rec.zh as Record<string, unknown>) : {};
    const en = rec.en && typeof rec.en === 'object' ? (rec.en as Record<string, unknown>) : {};
    return firstUrl(asString(zh.how_to_use)) || firstUrl(asString(en.how_to_use));
  }
  return undefined;
}

/** 拼接 mcpmarket 的 overview / auth_help 文本，用于 README 推断与详情展示 */
function cnReadme(detail: McpMarketCnDetail): string {
  const parts: string[] = [];
  const overview = detail.overview;
  if (overview && typeof overview === 'object') {
    for (const lang of ['zh', 'en']) {
      const localized = (overview as Record<string, unknown>)[lang];
      if (!localized || typeof localized !== 'object') continue;
      const rec = localized as Record<string, unknown>;
      for (const key of ['what_is', 'key_features', 'how_to_use', 'use_cases', 'where_to_use']) {
        const value = rec[key];
        if (typeof value === 'string' && value.trim()) parts.push(value.trim());
      }
    }
  }
  const help = cnAuthHelp(detail);
  for (const lang of ['zh', 'en']) {
    const value = help[lang];
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  }
  return parts.join('\n\n');
}

function cnEnvFields(detail: McpMarketCnDetail, requiredByAuth: boolean): McpMarketEnvField[] {
  const rawEnv =
    detail.env && typeof detail.env === 'object' && !Array.isArray(detail.env)
      ? (detail.env as Record<string, unknown>)
      : {};
  const fields: McpMarketEnvField[] = [];
  for (const [name, raw] of Object.entries(rawEnv)) {
    const masked = typeof raw === 'string' && raw === '***';
    const label = masked ? name : localizedText(raw) || asString(raw) || name;
    fields.push(
      toEnvField(name, {
        label: label === '***' ? name : label,
        required: requiredByAuth,
        secret: masked || isSecretName(name),
      }),
    );
  }
  // header_templates 里的变量如果没有出现在 env 中，也补成必填输入
  for (const varName of extractTemplateVars(cnHeaderTemplates(detail))) {
    if (fields.some((f) => f.name === varName)) continue;
    fields.push(toEnvField(varName, { required: true, secret: isSecretName(varName) }));
  }
  return fields;
}

function isMcpMarketProxyUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '8.217.130.241' || host.endsWith('mcpmarket.cn');
  } catch {
    return false;
  }
}

class McpMarketCnProvider implements McpMarketProvider {
  readonly id = 'mcpmarket' as const;

  async query(keyword: string, pageToken: string | undefined, pageSize: number): Promise<McpMarketQueryResult> {
    const page = Math.max(1, Number.parseInt(pageToken ?? '1', 10) || 1);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(pageSize),
    });
    if (keyword.trim()) params.set('search', keyword.trim());
    const data = await fetchJson<{
      current_page?: unknown;
      servers?: unknown;
      total_pages?: unknown;
      total_servers?: unknown;
    }>(`${MCPMARKET_BASE}/api/servers?${params.toString()}`);
    const rawServers = Array.isArray(data.servers) ? (data.servers as McpMarketCnServer[]) : [];
    const items = rawServers
      .map(cnToItem)
      .filter((item) => item.id && item.name);
    const current = asNumber(data.current_page) ?? page;
    const totalPages = asNumber(data.total_pages) ?? 0;
    return {
      items,
      nextPageToken: current < totalPages ? String(current + 1) : undefined,
      total: asNumber(data.total_servers),
    };
  }

  async detail(id: string): Promise<McpMarketDetail> {
    const raw = await fetchJson<McpMarketCnDetail>(`${MCPMARKET_BASE}/api/servers/${encodeURIComponent(id)}`);
    const item = cnToItem(raw);
    // 详情响应偶发缺少 _id：用请求 id 兜底，保证 installed 匹配稳定
    if (!item.id) item.id = id;
    const authType = asString(raw.auth_type);
    const requiredByAuth = authType === 'env';
    const baseEnv = cnEnvFields(raw, requiredByAuth);
    const templates = cnHeaderTemplates(raw);
    const options: McpMarketInstallOption[] = [];

    // 1) mcp_config 中的本地 stdio / 直连 remote
    const configServers = raw.mcp_config?.mcpServers;
    if (configServers && typeof configServers === 'object') {
      for (const cfg of Object.values(configServers)) {
        const base = mergeConfigEnv(baseEnv, cfg.env as Record<string, unknown> | undefined, true);
        const configHeaders = headerTemplatesFromHeaders(cfg.headers as Record<string, unknown> | undefined);
        const rawUrl = asString(cfg.url);
        if (rawUrl) {
          const transport = asString(cfg.type).toLowerCase() === 'sse' ? 'sse' : 'http';
          const urlOutcome = templateizeUrl(rawUrl, base);
          let env = mergePlaceholderFields(base, urlOutcome.names);
          const headerSource = Object.keys(configHeaders).length > 0 ? configHeaders : templates;
          const headerOutcome = templateizeHeaders(headerSource, env);
          env = mergePlaceholderFields(env, headerOutcome.names, { forceSecret: true });
          const hasTemplates = Object.keys(headerOutcome.templates).length > 0;
          options.push({
            index: 0,
            kind: 'remote',
            transport,
            label: `远程 · ${transport}`,
            url: urlOutcome.text,
            env,
            ...(hasTemplates ? { headerTemplates: headerOutcome.templates } : {}),
            supported: true,
          });
          continue;
        }
        const command = asString(cfg.command);
        if (!command) continue;
        const rawArgs = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [];
        const argOutcome = templateizeArgs(rawArgs, base);
        const env = mergePlaceholderFields(base, argOutcome.names);
        const support = stdioCommandSupport(command);
        const spec = argOutcome.args.filter((a) => !a.startsWith('-')).join(' ');
        options.push({
          index: 0,
          kind: 'stdio',
          transport: 'stdio',
          label: `${command}${spec ? ` · ${spec}` : ''}`.slice(0, 100),
          command,
          args: argOutcome.args,
          env,
          ...(support.reason ? { unsupportedReason: support.reason } : {}),
          supported: support.supported,
        });
      }
    }

    // 2) mcp_url 中的托管地址
    const remoteUrls: Array<{ url: string; transport: 'http' | 'sse' }> = [];
    const httpUrl = asString(raw.mcp_url?.streamable_http_url);
    const sseUrl = asString(raw.mcp_url?.sse_url);
    if (httpUrl) remoteUrls.push({ url: httpUrl, transport: 'http' });
    if (sseUrl) remoteUrls.push({ url: sseUrl, transport: 'sse' });
    for (const remote of remoteUrls) {
      const urlOutcome = templateizeUrl(remote.url, baseEnv);
      let env = mergePlaceholderFields(baseEnv, urlOutcome.names);
      const headerOutcome = templateizeHeaders(templates, env);
      env = mergePlaceholderFields(env, headerOutcome.names, { forceSecret: true });
      const hasTemplates = Object.keys(headerOutcome.templates).length > 0;
      const hasEnv = env.some((f) => f.fixedValue === undefined);
      const mapped = isEnvMapped(env, urlOutcome.text, headerOutcome.templates);
      const proxy = isMcpMarketProxyUrl(remote.url);
      let supported = true;
      let unsupportedReason: string | undefined;
      if (hasEnv && !hasTemplates && proxy) {
        supported = false;
        unsupportedReason = '该托管地址需要登录 MCP 市场创建实例，暂不能直接导入';
      } else if (hasEnv && !hasTemplates && !mapped) {
        supported = false;
        unsupportedReason = '该远程服务缺少请求头映射，暂不能自动导入';
      }
      options.push({
        index: 0,
        kind: 'remote',
        transport: remote.transport,
        label: `远程 · ${remote.transport === 'http' ? 'streamable-http' : 'sse'}`,
        url: urlOutcome.text,
        env,
        ...(hasTemplates ? { headerTemplates: headerOutcome.templates } : {}),
        supported,
        ...(unsupportedReason ? { unsupportedReason } : {}),
      });
    }

    const readme = cnReadme(raw);
    let deduped = dedupeOptions(options);
    if (deduped.length === 0) {
      deduped = dedupeOptions([...deduped, ...inferOptionsFromText(readme, baseEnv)]);
    }
    deduped = ensureManualOption(deduped, baseEnv);

    return {
      ...item,
      installOptions: deduped,
      obtainUrl: cnObtainUrl(raw),
      readme: readme || undefined,
    };
  }
}

// ============================================================================
// 官方 MCP Registry
// ============================================================================

const OFFICIAL_BASE = 'https://registry.modelcontextprotocol.io';

interface OfficialServer {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  version?: unknown;
  websiteUrl?: unknown;
  repository?: { url?: unknown };
  icons?: unknown;
  packages?: unknown;
  remotes?: unknown;
}

interface OfficialPackage {
  registryType?: unknown;
  identifier?: unknown;
  version?: unknown;
  runtimeHint?: unknown;
  runtimeArguments?: unknown;
  packageArguments?: unknown;
  transport?: { type?: unknown };
  environmentVariables?: unknown;
}

interface OfficialRemote {
  type?: unknown;
  url?: unknown;
  headers?: unknown;
}

interface OfficialInput {
  name?: unknown;
  description?: unknown;
  isRequired?: unknown;
  isSecret?: unknown;
  default?: unknown;
  placeholder?: unknown;
  format?: unknown;
  choices?: unknown;
  value?: unknown;
  variables?: unknown;
}

interface OfficialArgument {
  type?: unknown;
  name?: unknown;
  value?: unknown;
  variables?: unknown;
}

function officialToItem(server: OfficialServer): McpMarketItem {
  const name = asString(server.name);
  const slug = lastSegment(name);
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const icons = Array.isArray(server.icons) ? server.icons : [];
  const firstIcon = icons[0] && typeof icons[0] === 'object' ? icons[0] as Record<string, unknown> : null;
  const repository = server.repository && typeof server.repository === 'object' ? server.repository : null;
  return {
    source: 'official',
    id: name,
    name: asString(server.title) || slug,
    nameEn: slug,
    slug,
    installName: sanitizeServerName(slug),
    description: asString(server.description),
    version: asString(server.version) || undefined,
    iconUrl: firstIcon ? asString(firstIcon.src) || undefined : undefined,
    homepage: asString(server.websiteUrl) || (repository ? asString(repository.url) : '') || undefined,
    verified: false,
    hosted: remotes.length > 0 && packages.length === 0,
    updatedAt: undefined,
  };
}

function officialEnvFields(raw: unknown): McpMarketEnvField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is OfficialInput => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const name = asString(item.name);
      const value = asString(item.value);
      const formatRaw = asString(item.format);
      const format: McpMarketEnvField['format'] =
        formatRaw === 'number' || formatRaw === 'boolean' || formatRaw === 'filepath'
          ? formatRaw
          : 'string';
      return toEnvField(name, {
        label: name,
        description: asString(item.description) || undefined,
        required: item.isRequired === true,
        secret: item.isSecret === true,
        default: asString(item.default) || undefined,
        placeholder: asString(item.placeholder) || undefined,
        choices: Array.isArray(item.choices) ? item.choices.map(String) : undefined,
        format,
        ...(value && !isPlaceholderValue(value) && !value.includes('{') ? { fixedValue: value } : {}),
      });
    })
    .filter((field) => field.name);
}

function substituteVars(text: string, variables: unknown, values: Record<string, string>): string {
  const vars = variables && typeof variables === 'object' ? (variables as Record<string, OfficialInput>) : {};
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    const provided = values[key];
    if (provided !== undefined && provided !== '') return provided;
    const variable = vars[key];
    const fallback = variable ? asString(variable.default) || asString(variable.value) : '';
    return fallback || match;
  });
}

function resolveOfficialArguments(raw: unknown, values: Record<string, string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const arg = item as OfficialArgument;
    const value = substituteVars(asString(arg.value), arg.variables, values);
    if (asString(arg.type) === 'named') {
      const name = asString(arg.name);
      if (!name) continue;
      out.push(value ? `${name}=${value}` : name);
    } else if (value) {
      out.push(value);
    }
  }
  return out;
}

function officialObtainUrl(env: McpMarketEnvField[], server: OfficialServer): string | undefined {
  for (const field of env) {
    const url = firstUrl(field.description);
    if (url) return url;
  }
  const repository = server.repository && typeof server.repository === 'object' ? server.repository : null;
  return asString(server.websiteUrl) || (repository ? asString(repository.url) : '') || undefined;
}

class OfficialRegistryProvider implements McpMarketProvider {
  readonly id = 'official' as const;

  async query(keyword: string, pageToken: string | undefined, pageSize: number): Promise<McpMarketQueryResult> {
    const params = new URLSearchParams({ version: 'latest', limit: String(pageSize) });
    const keywordTrimmed = keyword.trim();
    // 官方 Registry 要求搜索词至少 3 个字符；更短的输入退化为浏览
    if (keywordTrimmed.length >= 3) params.set('search', keywordTrimmed);
    if (pageToken) params.set('cursor', pageToken);
    const data = await fetchJson<{
      servers?: unknown;
      metadata?: { nextCursor?: unknown };
    }>(`${OFFICIAL_BASE}/v0/servers?${params.toString()}`);
    const raw = Array.isArray(data.servers) ? data.servers : [];
    const items: McpMarketItem[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as { server?: OfficialServer; _meta?: Record<string, unknown> };
      const server = rec.server;
      if (!server || typeof server !== 'object') continue;
      const meta = rec._meta?.['io.modelcontextprotocol.registry/official'];
      const official = meta && typeof meta === 'object' ? meta as Record<string, unknown> : null;
      if (official && (official.status === 'deleted' || official.status === 'deprecated')) continue;
      if (official && official.isLatest === false) continue;
      const item = officialToItem(server);
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return {
      items,
      nextPageToken: asString(data.metadata?.nextCursor) || undefined,
      total: undefined,
    };
  }

  async detail(id: string): Promise<McpMarketDetail> {
    const data = await fetchJson<{ server?: OfficialServer }>(
      `${OFFICIAL_BASE}/v0/servers/${encodeURIComponent(id)}/versions/latest`,
    );
    const server = data.server;
    if (!server) throw new McpMarketError('NOT_FOUND', `market server not found: ${id}`);
    const item = officialToItem(server);
    if (!item.id) item.id = id;
    const options: McpMarketInstallOption[] = [];

    // packages
    if (Array.isArray(server.packages)) {
      for (const raw of server.packages) {
        if (!raw || typeof raw !== 'object') continue;
        const pkg = raw as OfficialPackage;
        const registryType = asString(pkg.registryType);
        const identifier = asString(pkg.identifier);
        const version = asString(pkg.version);
        const transportRaw = asString(pkg.transport?.type);
        if (transportRaw && transportRaw !== 'stdio') continue;
        if (!identifier) continue;
        const env = officialEnvFields(pkg.environmentVariables);
        const inputs = Object.fromEntries(
          env.filter((f) => f.default !== undefined).map((f) => [f.name, f.default as string]),
        );
        const runtimeArgs = resolveOfficialArguments(pkg.runtimeArguments, inputs);
        const packageArgs = resolveOfficialArguments(pkg.packageArguments, inputs);

        if (registryType === 'npm') {
          const command = asString(pkg.runtimeHint) || 'npx';
          const spec = version ? `${identifier}@${version}` : identifier;
          const args = [...runtimeArgs, spec, ...packageArgs];
          if (command.replace(/\.cmd$/i, '') === 'npx' && !args.includes('-y') && !args.includes('--yes')) {
            args.unshift('-y');
          }
          const support = stdioCommandSupport(command);
          const argOutcome = templateizeArgs(args, env);
          const finalEnv = mergePlaceholderFields(env, argOutcome.names);
          options.push({
            index: 0,
            kind: 'stdio',
            transport: 'stdio',
            label: `npm · ${spec}`,
            registryType,
            command,
            args: argOutcome.args,
            env: finalEnv,
            supported: support.supported,
            ...(support.reason ? { unsupportedReason: support.reason } : {}),
          });
          continue;
        }
        if (registryType === 'pypi') {
          const command = asString(pkg.runtimeHint) || 'uvx';
          const spec = version ? `${identifier}==${version}` : identifier;
          const support = stdioCommandSupport(command);
          const argOutcome = templateizeArgs([...runtimeArgs, spec, ...packageArgs], env);
          const finalEnv = mergePlaceholderFields(env, argOutcome.names);
          options.push({
            index: 0,
            kind: 'stdio',
            transport: 'stdio',
            label: `pypi · ${spec}`,
            registryType,
            command,
            args: argOutcome.args,
            env: finalEnv,
            supported: support.supported,
            ...(support.reason ? { unsupportedReason: support.reason } : {}),
          });
          continue;
        }
        const reason =
          registryType === 'oci'
            ? '需要 Docker，暂未支持一键安装'
            : registryType === 'mcpb'
              ? '暂不支持 MCPB 包'
              : registryType === 'nuget'
                ? '暂不支持 NuGet 包'
                : `暂不支持 ${registryType || '未知'} 包`;
        options.push({
          index: 0,
          kind: 'stdio',
          transport: 'stdio',
          label: `${registryType || 'package'} · ${identifier}`,
          registryType,
          env,
          supported: false,
          unsupportedReason: reason,
        });
      }
    }

    // remotes
    if (Array.isArray(server.remotes)) {
      for (const raw of server.remotes) {
        if (!raw || typeof raw !== 'object') continue;
        const remote = raw as OfficialRemote;
        const rawUrl = asString(remote.url);
        if (!rawUrl) continue;
        const typeRaw = asString(remote.type).toLowerCase();
        const transport: 'http' | 'sse' = typeRaw === 'sse' ? 'sse' : 'http';
        const templates: Record<string, string> = {};
        let fields: McpMarketEnvField[] = [];
        const urlOutcome = templateizeUrl(rawUrl, fields);
        fields = mergePlaceholderFields(fields, urlOutcome.names);
        const headersRaw = Array.isArray(remote.headers) ? remote.headers : [];
        for (const headerRaw of headersRaw) {
          if (!headerRaw || typeof headerRaw !== 'object') continue;
          const header = headerRaw as OfficialInput & { name?: unknown };
          const name = asString(header.name);
          if (!name) continue;
          const value = asString(header.value);
          if (value.includes('{') || value.includes('<')) {
            const outcome = templateizeText(value, fields);
            templates[name] = outcome.text;
            for (const varName of outcome.names) {
              if (!fields.some((f) => f.name === varName)) {
                fields.push(
                  toEnvField(varName, {
                    required: header.isRequired !== false,
                    secret: header.isSecret === true || isSecretName(varName),
                    default: asString(header.default) || undefined,
                    description: asString(header.description) || undefined,
                  }),
                );
              } else {
                fields = mergePlaceholderFields(fields, [varName], {
                  forceSecret: header.isSecret === true,
                });
              }
            }
          } else if (value) {
            const headerOutcome = templateizeHeaders({ [name]: value }, fields);
            templates[name] = headerOutcome.templates[name] ?? value;
            if (headerOutcome.names.length > 0) {
              fields = mergePlaceholderFields(fields, headerOutcome.names, {
                forceSecret: true,
              });
            }
          } else {
            templates[name] = `{${name}}`;
            if (!fields.some((f) => f.name === name)) {
              fields.push(
                toEnvField(name, {
                  required: header.isRequired !== false,
                  secret: header.isSecret === true || isSecretName(name),
                  default: asString(header.default) || undefined,
                  description: asString(header.description) || undefined,
                }),
              );
            }
          }
        }
        options.push({
          index: 0,
          kind: 'remote',
          transport,
          label: `远程 · ${typeRaw === 'sse' ? 'sse' : 'streamable-http'}`,
          url: urlOutcome.text,
          env: fields,
          ...(Object.keys(templates).length > 0 ? { headerTemplates: templates } : {}),
          supported: true,
        });
      }
    }

    const deduped = ensureManualOption(dedupeOptions(options), dedupeEnvFields(options));

    return {
      ...item,
      installOptions: deduped,
      obtainUrl: officialObtainUrl(dedupeEnvFields(deduped), server),
    };
  }
}

/** 聚合所有 option 的 env 字段（去重），用于提取「获取」链接 */
function dedupeEnvFields(options: McpMarketInstallOption[]): McpMarketEnvField[] {
  const seen = new Set<string>();
  const out: McpMarketEnvField[] = [];
  for (const option of options) {
    for (const field of option.env) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      out.push(field);
    }
  }
  return out;
}

// ============================================================================
// ModelScope
// ============================================================================

const MODELSCOPE_BASE = 'https://modelscope.cn';

interface ModelScopeServer {
  id?: unknown;
  name?: unknown;
  chinese_name?: unknown;
  description?: unknown;
  tags?: unknown;
  logo_url?: unknown;
  view_count?: unknown;
  is_hosted?: unknown;
  is_verified?: unknown;
  locales?: unknown;
  source_url?: unknown;
}

interface ModelScopeConfigEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  type?: unknown;
  headers?: unknown;
}

interface ModelScopeDetail extends ModelScopeServer {
  server_config?: unknown;
  env_schema?: unknown;
  operational_urls?: unknown;
  readme?: unknown;
}

interface JsonSchemaProperty {
  type?: unknown;
  description?: unknown;
  title?: unknown;
  default?: unknown;
  enum?: unknown;
}

function modelscopeToItem(raw: ModelScopeServer): McpMarketItem {
  const id = asString(raw.id);
  const locales = raw.locales && typeof raw.locales === 'object' ? raw.locales as Record<string, unknown> : {};
  const zh = locales.zh && typeof locales.zh === 'object' ? locales.zh as Record<string, unknown> : {};
  const en = locales.en && typeof locales.en === 'object' ? locales.en as Record<string, unknown> : {};
  const slug = lastSegment(id);
  return {
    source: 'modelscope',
    id,
    name: asString(raw.chinese_name) || asString(raw.name) || asString(zh.name) || slug,
    nameEn: asString(en.name) || slug,
    slug,
    installName: sanitizeServerName(slug),
    description: asString(raw.description) || asString(zh.description) || asString(en.description),
    iconUrl: asString(raw.logo_url) || undefined,
    views: asNumber(raw.view_count),
    verified: raw.is_verified === true,
    hosted: raw.is_hosted === true,
    homepage: asString(raw.source_url) || undefined,
  };
}

function modelscopeEnvFields(detail: ModelScopeDetail): McpMarketEnvField[] {
  const schema = detail.env_schema && typeof detail.env_schema === 'object'
    ? detail.env_schema as { properties?: unknown; required?: unknown }
    : {};
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, JsonSchemaProperty>
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties).map(([name, prop]) => {
    const typeRaw = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    const type = asString(typeRaw);
    return toEnvField(name, {
      label: asString(prop.title) || name,
      description: asString(prop.description) || undefined,
      required: required.has(name),
      secret: isSecretName(name),
      default: prop.default !== undefined && prop.default !== null ? String(prop.default) : undefined,
      choices: Array.isArray(prop.enum) ? prop.enum.map(String) : undefined,
      format: type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : 'string',
    });
  });
}

function modelscopeObtainUrl(detail: ModelScopeDetail): string | undefined {
  return firstUrl(asString(detail.readme)) || asString(detail.source_url) || undefined;
}

/** 拼接 ModelScope 的 readme（顶层 + locales）用于 README 推断 */
function modelscopeReadme(detail: ModelScopeDetail): string {
  const parts: string[] = [];
  const direct = asString(detail.readme);
  if (direct.trim()) parts.push(direct.trim());
  const locales = detail.locales && typeof detail.locales === 'object'
    ? detail.locales as Record<string, unknown>
    : {};
  for (const lang of ['zh', 'en']) {
    const localized = locales[lang];
    if (!localized || typeof localized !== 'object') continue;
    const readme = (localized as Record<string, unknown>).readme;
    if (typeof readme === 'string' && readme.trim()) parts.push(readme.trim());
  }
  return parts.join('\n\n');
}

class ModelScopeProvider implements McpMarketProvider {
  readonly id = 'modelscope' as const;

  async query(keyword: string, pageToken: string | undefined, pageSize: number): Promise<McpMarketQueryResult> {
    const page = Math.max(1, Number.parseInt(pageToken ?? '1', 10) || 1);
    // ModelScope 限制 page_number * page_size <= 100；固定 20/页，最多 5 页
    const size = Math.min(20, pageSize);
    const body = {
      search: keyword.trim(),
      page_number: page,
      page_size: size,
    };
    const data = await fetchJson<{
      data?: { mcp_server_list?: unknown; total_count?: unknown };
    }>(`${MODELSCOPE_BASE}/openapi/v1/mcp/servers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = Array.isArray(data.data?.mcp_server_list)
      ? (data.data?.mcp_server_list as ModelScopeServer[])
      : [];
    const items = raw.map(modelscopeToItem).filter((item) => item.id);
    const total = asNumber(data.data?.total_count);
    const next =
      total !== undefined && page * size < total && (page + 1) * size <= 100
        ? String(page + 1)
        : undefined;
    return { items, nextPageToken: next, total };
  }

  async detail(id: string): Promise<McpMarketDetail> {
    const data = await fetchJson<{ data?: ModelScopeDetail }>(
      `${MODELSCOPE_BASE}/openapi/v1/mcp/servers/${encodeURIComponent(id)}`,
    );
    const raw = data.data;
    if (!raw) throw new McpMarketError('NOT_FOUND', `market server not found: ${id}`);
    const item = modelscopeToItem(raw);
    if (!item.id) item.id = id;
    const baseEnv = modelscopeEnvFields(raw);
    const options: McpMarketInstallOption[] = [];

    // server_config：数组，每一项是一份 { mcpServers: {...} }
    if (Array.isArray(raw.server_config)) {
      for (const entry of raw.server_config) {
        if (!entry || typeof entry !== 'object') continue;
        const servers = (entry as { mcpServers?: unknown }).mcpServers;
        if (!servers || typeof servers !== 'object') continue;
        for (const cfg of Object.values(servers as Record<string, ModelScopeConfigEntry>)) {
          const base = mergeConfigEnv(baseEnv, cfg.env as Record<string, unknown> | undefined, false);
          const rawUrl = asString(cfg.url);
          if (rawUrl) {
            const transport = asString(cfg.type).toLowerCase() === 'sse' ? 'sse' : 'http';
            const rawHeaders = headerTemplatesFromHeaders(cfg.headers as Record<string, unknown> | undefined);
            const urlOutcome = templateizeUrl(rawUrl, base);
            let env = mergePlaceholderFields(base, urlOutcome.names);
            const headerOutcome = templateizeHeaders(rawHeaders, env);
            env = mergePlaceholderFields(env, headerOutcome.names, { forceSecret: true });
            options.push({
              index: 0,
              kind: 'remote',
              transport,
              label: `远程 · ${transport}`,
              url: urlOutcome.text,
              env,
              ...(Object.keys(headerOutcome.templates).length > 0
                ? { headerTemplates: headerOutcome.templates }
                : {}),
              supported: true,
            });
            continue;
          }
          const command = asString(cfg.command);
          if (!command) continue;
          const rawArgs = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [];
          const argOutcome = templateizeArgs(rawArgs, base);
          const env = mergePlaceholderFields(base, argOutcome.names);
          const support = stdioCommandSupport(command);
          const spec = argOutcome.args.join(' ');
          options.push({
            index: 0,
            kind: 'stdio',
            transport: 'stdio',
            label: `${command}${spec ? ` · ${spec}` : ''}`.slice(0, 100),
            command,
            args: argOutcome.args,
            env,
            supported: support.supported,
            ...(support.reason ? { unsupportedReason: support.reason } : {}),
          });
        }
      }
    }

    // operational_urls：已托管地址
    if (Array.isArray(raw.operational_urls)) {
      for (const entry of raw.operational_urls) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const rawUrl = asString(rec.url);
        if (!rawUrl) continue;
        const typeRaw = (asString(rec.transport_type) || asString(rec.type)).toLowerCase();
        const transport: 'http' | 'sse' = typeRaw === 'sse' ? 'sse' : 'http';
        const urlOutcome = templateizeUrl(rawUrl, baseEnv);
        const env = mergePlaceholderFields(baseEnv, urlOutcome.names);
        options.push({
          index: 0,
          kind: 'remote',
          transport,
          label: `远程 · ${typeRaw === 'sse' ? 'sse' : 'streamable-http'}`,
          url: urlOutcome.text,
          env,
          supported: true,
        });
      }
    }

    const readme = modelscopeReadme(raw);
    let deduped = dedupeOptions(options);
    if (deduped.length === 0) {
      deduped = dedupeOptions([...deduped, ...inferOptionsFromText(readme, baseEnv)]);
    }
    deduped = ensureManualOption(deduped, baseEnv);

    return {
      ...item,
      installOptions: deduped,
      obtainUrl: modelscopeObtainUrl(raw),
      readme: asString(raw.readme) || undefined,
    };
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createMarketProviders(): McpMarketProvider[] {
  return [new McpMarketCnProvider(), new OfficialRegistryProvider(), new ModelScopeProvider()];
}
