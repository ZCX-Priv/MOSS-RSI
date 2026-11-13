// src/modules/server/routes/voice.ts
// 语音识别 REST 路由：能力总览 / 模型目录 / 开关 / 默认模型 / 安装 / 卸载。
//
// 安装为长耗时操作（模型 100MB+），走「启动后台任务 + 立即返回」模式，
// 前端轮询 /api/voice/models 读取 state/progress。

import type { Logger, ServiceRegistry } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { VoiceService } from '../../voice';
import type { HttpResponse, RouteHandler } from '../types';

function resolveVoice(services: ServiceRegistry): VoiceService | null {
  return services.tryResolve<VoiceService>(ServiceNames.VOICE_SERVICE) ?? null;
}

/** 读取 JSON body 中的字符串字段 */
function readStringField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** GET /api/voice/status：开关 + 运行时可用性 + 当前默认模型 + 已安装列表 */
export function createVoiceStatusHandler(services: ServiceRegistry): RouteHandler {
  return (): HttpResponse => {
    const voice = resolveVoice(services);
    if (!voice) return { status: 200, body: { available: false } };
    return { status: 200, body: { available: true, ...voice.getStatus() } };
  };
}

/** GET /api/voice/models：内置模型目录 + 本地安装状态 */
export function createVoiceModelsHandler(services: ServiceRegistry): RouteHandler {
  return (): HttpResponse => {
    const voice = resolveVoice(services);
    if (!voice) return { status: 200, body: { models: [] } };
    return { status: 200, body: { models: voice.listModels() } };
  };
}

/** POST /api/voice/enable：设置总开关 */
export function createVoiceEnableHandler(services: ServiceRegistry): RouteHandler {
  return async (req): Promise<HttpResponse> => {
    const voice = resolveVoice(services);
    if (!voice) return { status: 503, body: { error: 'VOICE_UNAVAILABLE' } };
    if (!req.body || typeof req.body !== 'object') {
      return { status: 400, body: { error: 'INVALID_BODY' } };
    }
    const enabled = Boolean((req.body as { enabled?: unknown }).enabled);
    return { status: 200, body: await voice.setEnabled(enabled) };
  };
}

/** POST /api/voice/default-model：设置默认本地模型（须已安装） */
export function createVoiceSetDefaultModelHandler(services: ServiceRegistry): RouteHandler {
  return async (req): Promise<HttpResponse> => {
    const voice = resolveVoice(services);
    if (!voice) return { status: 503, body: { error: 'VOICE_UNAVAILABLE' } };
    const id = readStringField(req.body, 'id');
    if (!id) return { status: 400, body: { error: 'MODEL_ID_REQUIRED' } };
    try {
      return { status: 200, body: await voice.setDefaultModel(id) };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  };
}

/** POST /api/voice/language：设置识别语言（auto/zh/en/ja/ko/yue） */
export function createVoiceSetLanguageHandler(services: ServiceRegistry): RouteHandler {
  return async (req): Promise<HttpResponse> => {
    const voice = resolveVoice(services);
    if (!voice) return { status: 503, body: { error: 'VOICE_UNAVAILABLE' } };
    const language = readStringField(req.body, 'language');
    if (!language) return { status: 400, body: { error: 'LANGUAGE_REQUIRED' } };
    try {
      return { status: 200, body: await voice.setLanguage(language) };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  };
}

/** POST /api/voice/models/:id/install：启动后台下载安装 */
export function createVoiceInstallHandler(services: ServiceRegistry, logger: Logger): RouteHandler {
  return (_req, params): HttpResponse => {
    const voice = resolveVoice(services);
    if (!voice) return { status: 503, body: { error: 'VOICE_UNAVAILABLE' } };
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'MODEL_ID_REQUIRED' } };
    // 后台执行：安装体积大，请求立即返回，进度由 /api/voice/models 反映
    void voice.installModel(id).catch((err: unknown) => {
      logger.warn('voice model install failed', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { status: 202, body: { started: true } };
  };
}

/** DELETE /api/voice/models/:id：卸载（删除本地模型文件） */
export function createVoiceUninstallHandler(services: ServiceRegistry): RouteHandler {
  return async (_req, params): Promise<HttpResponse> => {
    const voice = resolveVoice(services);
    if (!voice) return { status: 503, body: { error: 'VOICE_UNAVAILABLE' } };
    const id = params?.id;
    if (!id) return { status: 400, body: { error: 'MODEL_ID_REQUIRED' } };
    try {
      await voice.uninstallModel(id);
      return { status: 200, body: { ok: true } };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  };
}