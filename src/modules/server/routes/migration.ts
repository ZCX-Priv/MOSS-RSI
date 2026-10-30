// src/modules/server/routes/migration.ts
// 数据迁移路由：外部 Agent 会话导入 + MOSS 备份导出/检查/恢复。
// 文件通道走「后端本机路径直读直写」（前端传绝对路径），规避 HTTP 16MB 请求体上限。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type { ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import { ErrorCode } from '../../../core/error-codes';
import { MigrationError } from '../../migration/errors';
import type { MigrationService } from '../../migration';

/** 解析迁移服务；未注册返回 null（模块启动窗口/被禁用） */
function resolveService(services: ServiceRegistry): MigrationService | null {
  return services.tryResolve<MigrationService>(ServiceNames.MIGRATION);
}

/** 统一错误响应：MigrationError 携带业务错误码，其余按 500 透出 */
function failure(err: unknown): HttpResponse {
  if (err instanceof MigrationError) {
    return { status: 400, body: { error: err.code } };
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

const UNAVAILABLE: HttpResponse = { status: 503, body: { error: ErrorCode.MIGRATION_SERVICE_UNAVAILABLE } };

/** GET /api/migration/sources — 探测本机 Claude Code / Codex 数据源 */
export function createMigrationSourcesHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const service = resolveService(services);
    if (!service) return UNAVAILABLE;
    try {
      return { status: 200, body: { sources: service.listSources() } };
    } catch (err) {
      return failure(err);
    }
  };
}

/** GET /api/migration/external-sessions?source= — 列出可导入会话 */
export function createExternalSessionsHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveService(services);
    if (!service) return UNAVAILABLE;
    const source = req.query.source ?? '';
    if (!source) return { status: 400, body: { error: ErrorCode.MIGRATION_SOURCE_INVALID } };
    try {
      return { status: 200, body: { sessions: service.listExternal(source) } };
    } catch (err) {
      return failure(err);
    }
  };
}

/** POST /api/migration/import-external — 导入选中会话 */
export function createImportExternalHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveService(services);
    if (!service) return UNAVAILABLE;
    const body = req.body as { source?: unknown; sourceIds?: unknown } | null;
    const source = typeof body?.source === 'string' ? body.source : '';
    if (!source) return { status: 400, body: { error: ErrorCode.MIGRATION_SOURCE_INVALID } };
    const sourceIds = Array.isArray(body?.sourceIds)
      ? body.sourceIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (sourceIds.length === 0) {
      return { status: 400, body: { error: ErrorCode.MIGRATION_SESSIONS_REQUIRED } };
    }
    try {
      return { status: 200, body: service.importExternal(source, sourceIds) };
    } catch (err) {
      return failure(err);
    }
  };
}

/** GET /api/migration/backup/default-path — 默认备份文件路径 */
export function createBackupDefaultPathHandler(services: ServiceRegistry): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const service = resolveService(services);
    if (!service) return UNAVAILABLE;
    return { status: 200, body: { path: service.defaultBackupPath() } };
  };
}

/** POST /api/migration/backup/export — 导出并加密备份包 */
export function createBackupExportHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveService(services);
    if (!service) return UNAVAILABLE;
    const body = req.body as { targetPath?: unknown; password?: unknown; includeSecrets?: unknown } | null;
    if (typeof body?.targetPath !== 'string' || typeof body?.password !== 'string') {
      return { status: 400, body: { error: ErrorCode.MIGRATION_PATH_REQUIRED } };
    }
    try {
      const result = await service.exportBackup({
        targetPath: body.targetPath,
        password: body.password,
        // 默认包含密钥（整包加密）；前端关闭开关时显式传 false
        includeSecrets: body.includeSecrets !== false,
      });
      return { status: 200, body: result };
    } catch (err) {
      return failure(err);
    }
  };
}

/** POST /api/migration/backup/inspect — 解密并预览包内容 */
export function createBackupInspectHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveService(services);
    if (!service) return UNAVAILABLE;
    const body = req.body as { path?: unknown; password?: unknown } | null;
    if (typeof body?.path !== 'string') {
      return { status: 400, body: { error: ErrorCode.MIGRATION_PATH_REQUIRED } };
    }
    try {
      const inspection = await service.inspectBackup({
        path: body.path,
        ...(typeof body.password === 'string' && body.password ? { password: body.password } : {}),
      });
      return { status: 200, body: inspection };
    } catch (err) {
      return failure(err);
    }
  };
}

/** POST /api/migration/backup/import — 合并导入 */
export function createBackupImportHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveService(services);
    if (!service) return UNAVAILABLE;
    const body = req.body as { path?: unknown; password?: unknown; dryRun?: unknown } | null;
    if (typeof body?.path !== 'string') {
      return { status: 400, body: { error: ErrorCode.MIGRATION_PATH_REQUIRED } };
    }
    try {
      const result = await service.importBackup({
        path: body.path,
        ...(typeof body.password === 'string' && body.password ? { password: body.password } : {}),
        ...(body.dryRun === true ? { dryRun: true } : {}),
      });
      return { status: 200, body: result };
    } catch (err) {
      return failure(err);
    }
  };
}

/** GET /api/migration/backup/download?path= — 下载本进程导出过的包（白名单校验） */
export function createBackupDownloadHandler(services: ServiceRegistry): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = resolveService(services);
    if (!service) return UNAVAILABLE;
    const path = (req.query.path ?? '').trim();
    if (!path) return { status: 400, body: { error: ErrorCode.MIGRATION_PATH_REQUIRED } };
    if (!service.isDownloadAllowed(path)) {
      return { status: 403, body: { error: ErrorCode.MIGRATION_DOWNLOAD_DENIED } };
    }
    if (!existsSync(path)) {
      return { status: 404, body: { error: ErrorCode.MIGRATION_FILE_NOT_FOUND } };
    }
    const buf = readFileSync(path);
    const size = statSync(path).size;
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(basename(path))}"`,
        'Cache-Control': 'no-store',
      },
      body: buf,
    };
  };
}
