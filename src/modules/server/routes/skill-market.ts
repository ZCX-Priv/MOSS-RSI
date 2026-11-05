// src/modules/server/routes/skill-market.ts
// 插件库主页 · SkillHub 技能市场（https://api.skillhub.cn 公开接口）
// POST /api/skills/market/query       —— 技能列表（代理 /api/skills；按内容指纹去重，支持跨页 exclude）
// GET  /api/skills/market/categories  —— 场景分类（代理 /api/v1/categories）
// POST /api/skills/market/install     —— 下载 zip 写入 ~/.moss/skills/<name>/ 并启用（热重载自动生效）
//
// 查询 / 安装的核心逻辑已抽到 tools/shared/skill-market.ts，与 set 工具共用。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ConfigService, Environment, ServiceRegistry } from '../../../core/types';
import type { SkillRegistry } from '../../tools/shared/skill-registry';
import { ErrorCode } from '../../../core/error-codes';
import {
  installMarketSkill,
  normalizeSkillName,
  queryMarketSkills,
  SkillMarketError,
} from '../../tools/shared/skill-market';

/** 保留既有导出（外部若引用过该工具函数，行为不变） */
export { normalizeSkillName };

const SKILLHUB_BASE = 'https://api.skillhub.cn';
/** 上游请求超时（分类接口） */
const FETCH_TIMEOUT_MS = 20_000;

/** 上游失败统一响应 */
function upstreamError(): HttpResponse {
  return { status: 502, body: { error: 'SKILLHUB_UNAVAILABLE' } };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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
    try {
      const { skills, total } = await queryMarketSkills({
        page: Number.parseInt(String(body.page ?? '1'), 10) || 1,
        pageSize: Number.parseInt(String(body.pageSize ?? ''), 10) || undefined,
        keyword: typeof body.keyword === 'string' ? body.keyword : '',
        category: typeof body.category === 'string' ? body.category : '',
        exclude: Array.isArray(body.exclude)
          ? body.exclude.filter((v): v is string => typeof v === 'string')
          : [],
      });
      return { status: 200, body: { skills, total } };
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

    try {
      const result = await installMarketSkill({ canonicalName, env, registry, config });
      return { status: 200, body: result };
    } catch (err) {
      if (err instanceof SkillMarketError) {
        switch (err.code) {
          case 'INVALID_NAME':
            return { status: 400, body: { error: ErrorCode.SKILL_NAME_INVALID } };
          case 'DOWNLOAD_FAILED':
            return { status: 502, body: { error: 'SKILLHUB_DOWNLOAD_FAILED' } };
          case 'ZIP_TOO_LARGE':
            return { status: 413, body: { error: 'SKILL_ZIP_TOO_LARGE' } };
          case 'FILES_REQUIRED':
            return { status: 400, body: { error: ErrorCode.SKILL_FILES_REQUIRED } };
          case 'IO_ERROR':
            return { status: 500, body: { error: err.message } };
        }
      }
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}
