// src/modules/server/routes/skill-market.ts
// 插件库主页 · SkillHub 技能市场（https://api.skillhub.cn 公开接口）
// POST /api/skills/market/query       —— 技能列表（代理 /api/skills；按内容指纹去重，支持跨页 exclude）
// GET  /api/skills/market/categories  —— 场景分类（代理 /api/v1/categories）
// POST /api/skills/market/install     —— 下载 zip 写入 ~/.moss/skills/<name>/ 并启用（热重载自动生效）

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ConfigService, Environment, ServiceRegistry } from '../../../core/types';
import type { SkillRegistry } from '../../tools/shared/skill-registry';
import { ErrorCode } from '../../../core/error-codes';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import JSZip from 'jszip';

const SKILLHUB_BASE = 'https://api.skillhub.cn';
/** 上游请求超时（列表/分类 与 zip 下载共用） */
const FETCH_TIMEOUT_MS = 20_000;
/** zip 上限：避免异常大包占满内存/磁盘 */
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const PAGE_SIZE_DEFAULT = 24;
const PAGE_SIZE_MAX = 50;

/** SkillHub canonicalName（@owner/slug）合法字符 */
const CANONICAL_NAME_RE = /^@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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

/** SkillHub 技能 → 前端精简形状（installName 用于匹配本地已安装技能，dedupeKey 用于市场去重） */
function toMarketSkill(s: SkillHubSkill): Record<string, unknown> {
  const slug = asString(s.slug);
  const canonicalName = asString(s.namespace?.canonicalName);
  // 展示用描述优先中文；身份指纹用原始 description（同一技能的译文/展示文案可能不同）
  const description = asString(s.description_zh) || asString(s.description);
  const identityText = asString(s.description) || asString(s.description_zh);
  const sub = Array.isArray(s.subCategories) ? (s.subCategories[0] as { name?: unknown } | undefined) : undefined;
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
    homepage: asString(s.homepage),
    verified: s.verified === true,
    source: asString(s.source),
  };
}

/** 上游失败统一响应 */
function upstreamError(): HttpResponse {
  return { status: 502, body: { error: 'SKILLHUB_UNAVAILABLE' } };
}

/** POST /api/skills/market/query —— 代理 SkillHub 技能列表，按内容指纹去重（页内 + 跨页 exclude） */
export function createMarketSkillsHandler(): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const body = (req.body ?? {}) as {
      page?: unknown;
      pageSize?: unknown;
      keyword?: unknown;
      category?: unknown;
      exclude?: unknown;
    };
    const page = Math.max(1, Number.parseInt(String(body.page ?? '1'), 10) || 1);
    const pageSize = Math.min(
      PAGE_SIZE_MAX,
      Math.max(1, Number.parseInt(String(body.pageSize ?? ''), 10) || PAGE_SIZE_DEFAULT),
    );
    const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    // 已展示指纹（跨页去重）：仅保留字符串并限长，避免异常请求体
    const exclude = Array.isArray(body.exclude)
      ? body.exclude.filter((v): v is string => typeof v === 'string').slice(0, 500)
      : [];

    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortBy: 'score',
      order: 'desc',
    });
    if (keyword) params.set('keyword', keyword);
    if (category) params.set('category', category);

    try {
      const res = await fetch(`${SKILLHUB_BASE}/api/skills?${params.toString()}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return upstreamError();
      const data = (await res.json()) as {
        data?: { skills?: SkillHubSkill[]; total?: unknown };
      };
      const raw = Array.isArray(data.data?.skills) ? data.data.skills : [];
      const excluded = new Set(exclude);
      const seen = new Set<string>();
      const skills: Record<string, unknown>[] = [];
      for (const item of raw.map(toMarketSkill)) {
        const key = asString(item.dedupeKey);
        if (excluded.has(key) || seen.has(key)) continue;
        seen.add(key);
        skills.push(item);
      }
      return {
        status: 200,
        body: { skills, total: asNumber(data.data?.total) || raw.length },
      };
    } catch {
      return upstreamError();
    }
  };
}

/** GET /api/skills/market/categories —— 代理 SkillHub 场景分类（排除 Pay Skill） */
export function createMarketCategoriesHandler(): RouteHandler {
  return async (): Promise<HttpResponse> => {
    try {
      const res = await fetch(`${SKILLHUB_BASE}/api/v1/categories`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return upstreamError();
      const data = (await res.json()) as {
        items?: Array<{ key?: unknown; name?: unknown; nameEn?: unknown; sortOrder?: unknown; active?: unknown }>;
      };
      const items = Array.isArray(data.items) ? data.items : [];
      const categories = items
        .filter((c) => asString(c.key) && c.key !== 'pay-skill' && c.active !== false)
        .sort((a, b) => asNumber(a.sortOrder) - asNumber(b.sortOrder))
        .map((c) => ({
          key: asString(c.key),
          name: asString(c.name) || asString(c.key),
          nameEn: asString(c.nameEn),
        }));
      return { status: 200, body: { categories } };
    } catch {
      return upstreamError();
    }
  };
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

/** POST /api/skills/market/install —— 下载 SkillHub zip，写入本地技能目录并启用 */
export function createInstallMarketSkillHandler(
  services: ServiceRegistry,
  config: ConfigService,
  env: Environment,
): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const registry = services.tryResolve<SkillRegistry>('skill.registry');
    if (!registry) {
      return { status: 404, body: { error: ErrorCode.SKILL_REGISTRY_UNAVAILABLE } };
    }
    const body = req.body as { canonicalName?: unknown } | undefined;
    const canonicalName =
      typeof body?.canonicalName === 'string' ? body.canonicalName.trim() : '';
    if (!CANONICAL_NAME_RE.test(canonicalName)) {
      return { status: 400, body: { error: ErrorCode.SKILL_NAME_INVALID } };
    }

    const slug = canonicalName.slice(canonicalName.indexOf('/') + 1);
    const name = normalizeSkillName(slug);
    const skillDir = resolve(env.dataDir, 'skills', name);

    // 幂等：已存在同名目录或已注册同名技能 → 视为已安装，不覆盖
    // （仍重扫一次：目录存在但未注册的历史技能可借此自愈）
    if (existsSync(skillDir) || registry.get(name)) {
      registry.rescan();
      return { status: 200, body: { name, installed: false } };
    }

    let buffer: Buffer;
    try {
      const res = await fetch(
        `${SKILLHUB_BASE}/api/v1/download?slug=${encodeURIComponent(canonicalName)}`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) {
        return { status: 502, body: { error: 'SKILLHUB_DOWNLOAD_FAILED' } };
      }
      buffer = Buffer.from(await res.arrayBuffer());
    } catch {
      return { status: 502, body: { error: 'SKILLHUB_DOWNLOAD_FAILED' } };
    }
    if (buffer.byteLength > MAX_ZIP_BYTES) {
      return { status: 413, body: { error: 'SKILL_ZIP_TOO_LARGE' } };
    }

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      return { status: 502, body: { error: 'SKILLHUB_DOWNLOAD_FAILED' } };
    }

    const entries = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
    const prefix = resolveSkillPrefix(entries);
    if (prefix === null) {
      return { status: 400, body: { error: ErrorCode.SKILL_FILES_REQUIRED } };
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
    mkdirSync(skillsRoot, { recursive: true });
    const staging = mkdtempSync(join(skillsRoot, '.mk-'));
    try {
      for (const f of files) {
        const target = resolve(staging, f.rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.data);
      }
      // SKILL.md 最后写（watcher 以它为来源文件）
      writeFileSync(resolve(staging, 'SKILL.md'), skillMd, 'utf8');
      mkdirSync(dirname(skillDir), { recursive: true });
      renameSync(staging, skillDir);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(skillDir, { recursive: true, force: true });
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    // 显式重扫：接口返回时技能已注册，不依赖 fs.watch 的 300ms 防抖
    registry.rescan();

    // 安装即启用（若此前存在同名禁用配置，显式打开）
    try {
      await config.updateAppConfig({ skills: { [name]: { enabled: true } } });
    } catch {
      // 启用失败不影响安装结果：缺省即为启用
    }

    return { status: 200, body: { name, installed: true } };
  };
}
