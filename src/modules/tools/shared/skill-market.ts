// src/modules/tools/shared/skill-market.ts
// SkillHub 技能市场共享逻辑（HTTP 路由与 skill 工具共用）。
//
// 职责：
//  - 查询市场技能列表（代理 https://api.skillhub.cn/api/skills，按内容指纹去重）
//  - 下载 zip 安装到 ~/.moss/skills/<name>/（路径穿越防护、暂存目录原子落盘、rescan、安装即启用）

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ConfigService, Environment } from '../../../core/types';
import type { SkillRegistry } from './skill-registry';

const SKILLHUB_BASE = 'https://api.skillhub.cn';
/** 上游请求超时（列表/分类 与 zip 下载共用） */
const FETCH_TIMEOUT_MS = 20_000;
/** zip 上限：避免异常大包占满内存/磁盘 */
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const PAGE_SIZE_DEFAULT = 24;
const PAGE_SIZE_MAX = 50;

/** SkillHub canonicalName（@owner/slug）合法字符 */
export const CANONICAL_NAME_RE = /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type SkillMarketErrorCode =
  | 'INVALID_NAME'
  | 'DOWNLOAD_FAILED'
  | 'ZIP_TOO_LARGE'
  | 'FILES_REQUIRED'
  | 'IO_ERROR';

/** 市场操作错误：调用方按 code 映射为 HTTP 状态或工具错误文案 */
export class SkillMarketError extends Error {
  constructor(
    public readonly code: SkillMarketErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SkillMarketError';
  }
}

/**
 * slug → MOSS 本地技能名：满足 SkillRegistry 的 /^[a-z][a-z0-9-]*$/，
 * 同时作为 ~/.moss/skills/<name>/ 目录名（天然防路径穿越）。
 */
export function normalizeSkillName(raw: string): string {
  const n = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!n) return 'skill';
  return /^[a-z]/.test(n) ? n : `skill-${n}`;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * SkillHub 列表接口的 homepage 指向 API 域名（浏览器访问 405），
 * 规范化为网页详情地址：https://www.skillhub.cn/skills/{owner}/{slug}
 * 非 API 域名（如 GitHub 等真实主页）原样保留。
 */
function normalizeSkillHomepage(rawHomepage: string, canonicalName: string): string {
  const homepage = rawHomepage.trim();
  if (homepage === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(homepage);
  } catch {
    return homepage;
  }
  if (parsed.hostname !== 'api.skillhub.cn') return homepage;
  // 优先 canonicalName（@owner/slug）；缺失时用 URL 路径兜底
  const publicPath =
    canonicalName.replace(/^@/, '').trim() ||
    parsed.pathname.replace(/^\/+|\/+$/g, '');
  return publicPath === '' ? homepage : `https://www.skillhub.cn/skills/${publicPath}`;
}

/** 技能身份指纹：内容描述一致（含跨 owner / 跨 slug 副本）视为同一个技能；无描述时退回 slug */
function marketDedupeKey(slug: string, identityText: string): string {
  const text = identityText.trim();
  if (!text) return `slug:${slug}`;
  return `desc:${createHash('sha1').update(text).digest('hex').slice(0, 12)}`;
}

/** SkillHub 列表项（仅声明用到的字段，其余忽略） */
interface SkillHubSkill {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  description_zh?: unknown;
  iconUrl?: unknown;
  category?: unknown;
  subCategories?: unknown;
  downloads?: unknown;
  stars?: unknown;
  version?: unknown;
  homepage?: unknown;
  verified?: unknown;
  source?: unknown;
  namespace?: { canonicalName?: unknown };
}

/** 市场技能（前端列表 / set 工具共用形状） */
export interface MarketSkill {
  name: string;
  slug: string;
  canonicalName: string;
  installName: string;
  dedupeKey: string;
  description: string;
  iconUrl: string | null;
  category: string;
  subCategory: string;
  downloads: number;
  stars: number;
  version: string;
  homepage: string;
  verified: boolean;
  source: string;
}

/** SkillHub 技能 → 精简形状（installName 用于匹配本地已安装技能，dedupeKey 用于市场去重） */
function toMarketSkill(s: SkillHubSkill): MarketSkill {
  const slug = asString(s.slug);
  const canonicalName = asString(s.namespace?.canonicalName);
  // 展示用描述优先中文；身份指纹用原始 description（同一技能的译文/展示文案可能不同）
  const description = asString(s.description_zh) || asString(s.description);
  const identityText = asString(s.description) || asString(s.description_zh);
  const sub = Array.isArray(s.subCategories)
    ? (s.subCategories[0] as { name?: unknown } | undefined)
    : undefined;
  return {
    name: asString(s.name) || slug,
    slug,
    canonicalName,
    installName: normalizeSkillName(slug),
    dedupeKey: marketDedupeKey(slug, identityText),
    description,
    iconUrl: typeof s.iconUrl === 'string' ? s.iconUrl : null,
    category: asString(s.category),
    subCategory: asString(sub?.name),
    downloads: asNumber(s.downloads),
    stars: asNumber(s.stars),
    version: asString(s.version),
    homepage: normalizeSkillHomepage(asString(s.homepage), canonicalName),
    verified: s.verified === true,
    source: asString(s.source),
  };
}

export interface MarketQueryParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  category?: string;
  /** 已展示的内容指纹（跨页去重） */
  exclude?: string[];
}

/**
 * 查询市场技能列表（按内容指纹页内去重 + 跨页 exclude）。
 * 上游不可用时抛出 SkillMarketError('DOWNLOAD_FAILED')，由调用方决定展示方式。
 */
export async function queryMarketSkills(
  params: MarketQueryParams = {},
): Promise<{ skills: MarketSkill[]; total: number }> {
  const page = Math.max(1, Number.parseInt(String(params.page ?? '1'), 10) || 1);
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Number.parseInt(String(params.pageSize ?? ''), 10) || PAGE_SIZE_DEFAULT),
  );
  const keyword = typeof params.keyword === 'string' ? params.keyword.trim() : '';
  const category = typeof params.category === 'string' ? params.category.trim() : '';
  const exclude = (params.exclude ?? []).filter((v): v is string => typeof v === 'string').slice(0, 500);

  const search = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    sortBy: 'score',
    order: 'desc',
  });
  if (keyword) search.set('keyword', keyword);
  if (category) search.set('category', category);

  let res: Response;
  try {
    res = await fetch(`${SKILLHUB_BASE}/api/skills?${search.toString()}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new SkillMarketError('DOWNLOAD_FAILED', 'SkillHub request failed');
  }
  if (!res.ok) throw new SkillMarketError('DOWNLOAD_FAILED', `SkillHub HTTP ${res.status}`);

  const data = (await res.json()) as {
    data?: { skills?: SkillHubSkill[]; total?: unknown };
  };
  const raw = Array.isArray(data.data?.skills) ? data.data.skills : [];
  const excluded = new Set(exclude);
  const seen = new Set<string>();
  const skills: MarketSkill[] = [];
  for (const item of raw.map(toMarketSkill)) {
    if (excluded.has(item.dedupeKey) || seen.has(item.dedupeKey)) continue;
    seen.add(item.dedupeKey);
    skills.push(item);
  }
  return { skills, total: asNumber(data.data?.total) || raw.length };
}

/* ============================================================================
 * 市场技能内容（详情页「预览 / 文件」）
 * 逆向 SkillHub 公开接口：
 *   GET /api/v1/skills/{slug}                → 详情（summary / stats）
 *   GET /api/v1/skills/{slug}/files          → 文件清单（path / size）
 *   GET /api/v1/skills/{slug}/file?path=xxx  → 单文件原文（纯文本）
 * ========================================================================== */

export interface MarketSkillFileEntry {
  path: string;
  size: number;
}

export interface MarketSkillContent {
  canonicalName: string;
  slug: string;
  name: string;
  /** 「简介」：详情接口的中文摘要（summary_zh → summary） */
  summaryMarkdown: string;
  files: MarketSkillFileEntry[];
  /** 「预览」Tab：SKILL.md 原文 */
  preview: { path: string; content: string } | null;
  version: string;
  stats?: { downloads: number; stars: number; installs: number; versions: number };
  publisher?: { name: string; verified: boolean };
  security?: Array<{ vendor: string; status: string; statusText: string; reportUrl: string }>;
}

interface MarketSkillDetailPayload {
  latestVersion?: { version?: unknown };
  publisher?: { name?: unknown; verified?: unknown };
  skill?: {
    displayName?: unknown;
    summary?: unknown;
    summary_zh?: unknown;
    stats?: { downloads?: unknown; stars?: unknown; installs?: unknown; versions?: unknown };
  };
  securityReports?: Record<
    string,
    { status?: unknown; statusText?: unknown; reportUrl?: unknown }
  >;
}

interface MarketSkillFilesPayload {
  files?: Array<{ path?: unknown; size?: unknown }>;
}

/** 内容接口超时（比列表略短，详情页允许失败降级） */
const CONTENT_TIMEOUT_MS = 15_000;
const CONTENT_CACHE_MS = 5 * 60_000;
const MAX_CONTENT_FILES = 1000;
const MAX_PREVIEW_CHARS = 512 * 1024;

/** canonicalName → 内容缓存（5 分钟；避免切换 Tab/刷新重复打上游） */
const contentCache = new Map<string, { at: number; value: MarketSkillContent }>();

async function fetchJsonOrNull<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchTextOrNull(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.text()).slice(0, MAX_PREVIEW_CHARS);
  } catch {
    return null;
  }
}

/**
 * 拉取市场技能内容（简介 / 文件 / SKILL.md 预览）。
 * 单个上游失败按空值降级；三项全部失败才抛 DOWNLOAD_FAILED。
 */
export async function fetchMarketSkillContent(
  canonicalName: string,
): Promise<MarketSkillContent> {
  const name = canonicalName.trim();
  if (!CANONICAL_NAME_RE.test(name)) {
    throw new SkillMarketError('INVALID_NAME', 'canonicalName must match @owner/slug');
  }
  const cached = contentCache.get(name);
  if (cached && Date.now() - cached.at < CONTENT_CACHE_MS) return cached.value;

  const slug = name.slice(name.lastIndexOf('/') + 1);
  const base = `${SKILLHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}`;
  const [detail, filesPayload, previewText] = await Promise.all([
    fetchJsonOrNull<MarketSkillDetailPayload>(base),
    fetchJsonOrNull<MarketSkillFilesPayload>(`${base}/files`),
    fetchTextOrNull(`${base}/file?path=${encodeURIComponent('SKILL.md')}`),
  ]);

  if (detail === null && filesPayload === null && previewText === null) {
    throw new SkillMarketError('DOWNLOAD_FAILED', 'SkillHub content unavailable');
  }

  const skill = detail?.skill;
  const summaryMarkdown = asString(skill?.summary_zh) || asString(skill?.summary);

  const rawFiles = Array.isArray(filesPayload?.files) ? filesPayload.files : [];
  const files: MarketSkillFileEntry[] = rawFiles
    .map((item) => ({
      path: asString(item.path),
      size: Math.max(0, asNumber(item.size)),
    }))
    .filter((item) => item.path !== '')
    .sort((a, b) => {
      if (a.path === 'SKILL.md') return -1;
      if (b.path === 'SKILL.md') return 1;
      return a.path.localeCompare(b.path);
    })
    .slice(0, MAX_CONTENT_FILES);

  const stats = skill?.stats
    ? {
        downloads: asNumber(skill.stats.downloads),
        stars: asNumber(skill.stats.stars),
        installs: asNumber(skill.stats.installs),
        versions: asNumber(skill.stats.versions),
      }
    : undefined;

  const security = detail?.securityReports
    ? Object.entries(detail.securityReports).map(([vendor, report]) => ({
        vendor,
        status: asString(report?.status),
        statusText: asString(report?.statusText),
        reportUrl: asString(report?.reportUrl),
      }))
    : undefined;

  const value: MarketSkillContent = {
    canonicalName: name,
    slug,
    name: asString(skill?.displayName) || slug,
    summaryMarkdown,
    files,
    preview:
      previewText !== null && previewText.trim() !== ''
        ? { path: 'SKILL.md', content: previewText }
        : null,
    version: asString(detail?.latestVersion?.version),
    ...(stats ? { stats } : {}),
    ...(detail?.publisher
      ? {
          publisher: {
            name: asString(detail.publisher.name),
            verified: detail.publisher.verified === true,
          },
        }
      : {}),
    ...(security && security.length > 0 ? { security } : {}),
  };

  contentCache.set(name, { at: Date.now(), value });
  return value;
}

/**
 * 改写 SKILL.md frontmatter 的 name 为本地技能名（SkillRegistry 要求小写字母开头）。
 * 无 frontmatter name 时在首个 --- 块内补一行；无 frontmatter 时原样返回。
 */
function rewriteSkillName(markdown: string, name: string): string {
  if (!/^---\s*\n/.test(markdown)) return markdown;
  const fmEnd = markdown.indexOf('\n---', 4);
  if (fmEnd < 0) return markdown;
  const head = markdown.slice(0, fmEnd);
  const tail = markdown.slice(fmEnd);
  const nameLine = /^name\s*:\s*.*$/m;
  if (nameLine.test(head)) {
    return head.replace(nameLine, `name: ${name}`) + tail;
  }
  return `${head}\nname: ${name}${tail}`;
}

/** 从 zip 定位 SKILL.md 所在前缀（根 '' 或单一顶层目录 '<dir>/'） */
function resolveSkillPrefix(entries: string[]): string | null {
  if (entries.includes('SKILL.md')) return '';
  const tops = new Set(entries.map((p) => p.split('/')[0]));
  if (tops.size !== 1) return null;
  const top = Array.from(tops)[0];
  return entries.includes(`${top}/SKILL.md`) ? `${top}/` : null;
}

/** 相对路径合法性：非空、无 .. 段、非绝对路径，且不在 macOS 元数据目录内 */
function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return false;
  const segs = rel.split('/');
  if (segs.includes('..')) return false;
  return !segs.some((s) => s === '__MACOSX' || s === '.DS_Store');
}

export interface InstallMarketSkillOptions {
  canonicalName: string;
  /** 市场图标（写入 .market.json，管理面板优先展示） */
  iconUrl?: string;
  env: Environment;
  registry: SkillRegistry;
  /** 安装后启用（缺省即启用；存在同名禁用配置时显式打开） */
  config?: ConfigService;
}

/**
 * 下载 SkillHub zip，写入 ~/.moss/skills/<name>/ 并启用（热重载 + 显式 rescan）。
 * 已存在同名目录/技能时幂等返回 installed=false，不覆盖用户内容。
 */
export async function installMarketSkill(
  opts: InstallMarketSkillOptions,
): Promise<{ name: string; installed: boolean }> {
  const canonicalName = opts.canonicalName.trim();
  if (!CANONICAL_NAME_RE.test(canonicalName)) {
    throw new SkillMarketError('INVALID_NAME', 'canonicalName must match @owner/slug');
  }

  const { env, registry, config } = opts;
  const iconUrl =
    typeof opts.iconUrl === 'string' && /^https?:\/\//i.test(opts.iconUrl) && opts.iconUrl.length <= 2048
      ? opts.iconUrl
      : undefined;
  const slug = canonicalName.slice(canonicalName.indexOf('/') + 1);
  const name = normalizeSkillName(slug);
  const skillDir = resolve(env.dataDir, 'skills', name);

  // 幂等：已存在同名目录或已注册同名技能 → 视为已安装，不覆盖
  // （仍重扫一次：目录存在但未注册的历史技能可借此自愈）
  if (existsSync(skillDir) || registry.get(name)) {
    registry.rescan();
    return { name, installed: false };
  }

  let buffer: Buffer;
  try {
    const res = await fetch(
      `${SKILLHUB_BASE}/api/v1/download?slug=${encodeURIComponent(canonicalName)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) {
      throw new SkillMarketError('DOWNLOAD_FAILED', `SkillHub HTTP ${res.status}`);
    }
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof SkillMarketError) throw err;
    throw new SkillMarketError('DOWNLOAD_FAILED', 'Skill zip download failed');
  }
  if (buffer.byteLength > MAX_ZIP_BYTES) {
    throw new SkillMarketError('ZIP_TOO_LARGE', 'Skill zip exceeds size limit');
  }

  const JSZipModule = await import('jszip').catch(() => null);
  if (!JSZipModule) {
    throw new SkillMarketError('DOWNLOAD_FAILED', 'jszip unavailable');
  }
  let zip: Awaited<ReturnType<typeof JSZipModule.default.loadAsync>>;
  try {
    zip = await JSZipModule.default.loadAsync(buffer);
  } catch {
    throw new SkillMarketError('DOWNLOAD_FAILED', 'Invalid skill zip');
  }

  const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const prefix = resolveSkillPrefix(entries);
  if (prefix === null) {
    throw new SkillMarketError('FILES_REQUIRED', 'SKILL.md not found in zip');
  }

  // 先整体校验 + 读取内容（避免半写状态）
  const files: Array<{ rel: string; data: Buffer }> = [];
  for (const p of entries) {
    const rel = p.slice(prefix.length);
    if (!isSafeRelPath(rel)) continue;
    const data =
      rel === 'SKILL.md'
        ? null
        : await zip.files[p].async('nodebuffer');
    if (data) files.push({ rel, data });
  }
  const skillMd = rewriteSkillName(await zip.files[`${prefix}SKILL.md`].async('text'), name);

  // 暂存目录（与目标同卷，隐藏前缀不会被 watcher 视为技能）写完后整体 rename，
  // watcher 只会看到完整技能目录
  const skillsRoot = join(env.dataDir, 'skills');
  try {
    mkdirSync(skillsRoot, { recursive: true });
    const staging = mkdtempSync(join(skillsRoot, '.mk-'));
    try {
      for (const f of files) {
        const target = resolve(staging, f.rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.data);
      }
      // 市场图标元数据（隐藏文件，不计入技能附件）
      if (iconUrl) {
        writeFileSync(
          resolve(staging, '.market.json'),
          JSON.stringify({ source: 'skillhub', canonicalName, iconUrl }, null, 2),
          'utf8',
        );
      }
      // SKILL.md 最后写（watcher 以它为来源文件）
      writeFileSync(resolve(staging, 'SKILL.md'), skillMd, 'utf8');
      mkdirSync(dirname(skillDir), { recursive: true });
      renameSync(staging, skillDir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  } catch (err) {
    rmSync(skillDir, { recursive: true, force: true });
    throw new SkillMarketError(
      'IO_ERROR',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 显式重扫：接口返回时技能已注册，不依赖 fs.watch 的 300ms 防抖
  registry.rescan();

  // 安装即启用（若此前存在同名禁用配置，显式打开）
  if (config) {
    try {
      await config.updateAppConfig({ skills: { [name]: { enabled: true } } });
    } catch {
      // 启用失败不影响安装结果：缺省即为启用
    }
  }

  return { name, installed: true };
}
