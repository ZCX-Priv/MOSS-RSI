// src/modules/server/routes/providers.ts
// GET /api/providers, PUT /api/providers/current, PUT /api/providers/reorder,
// POST /api/providers, PATCH /api/providers/:id, DELETE /api/providers/:id,
// POST /api/providers/:id/models, PATCH /api/providers/:id/models/:modelId,
// DELETE /api/providers/:id/models/:modelId,
// POST /api/providers/:id/models/fetch, POST /api/providers/:id/balance,
// POST /api/providers/:id/models/:modelId/test
//
// 数据模型：apiConfig.providers 为 ProviderConfig[]，服务商持有
// format/endpoint/apiKey/balanceUrl/modelsUrl，模型挂其下（名称 + 模型 id + 模型级配置）。

import type { HttpRequest, HttpResponse, RouteHandler } from '../types';
import type {
  ConfigService,
  ProviderConfig,
  ProviderModelConfig,
  ProviderServiceConfig,
  ThinkingLevelConfig,
  ServiceRegistry,
  Logger,
  ModelConfig,
} from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import type { LLMRouter } from '../../contracts';
import { ErrorCode } from '../../../core/error-codes';
import { generateProviderId, generateModelId, findModelInProviders } from '../../../core/provider-utils';
import { getProvider } from '../../llm/providers';
import { httpRequest } from '../../llm/client';

/** 外部请求超时（模型列表/余额查询，远低于 LLM 默认 120s） */
const EXTERNAL_TIMEOUT_MS = 15_000;

/** 默认思考强度等级库（provider.thinkingLevels 未定义时生效；与前端 DEFAULT_LEVELS 一致） */
const DEFAULT_THINKING_LEVELS: ThinkingLevelConfig[] = [
  { id: 'off', label: 'Off', effort: 'off' },
  { id: 'low', label: 'Low', effort: 'low' },
  { id: 'medium', label: 'Medium', effort: 'medium' },
  { id: 'high', label: 'High', effort: 'high' },
];

type ThinkingPatch = {
  enabled?: boolean;
  effort?: string;
  label?: string;
  budgetTokens?: number;
};

/** 合并 thinking 配置：patch 覆盖 existing 的字段 */
function mergeThinking(
  existing: ProviderModelConfig['thinking'],
  patch?: ThinkingPatch,
): ProviderModelConfig['thinking'] {
  if (!patch) return existing;
  const out: ProviderModelConfig['thinking'] = {
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
  };
  if (patch.effort !== undefined || existing.effort !== undefined) {
    out.effort = patch.effort !== undefined ? patch.effort : existing.effort;
  }
  if (patch.label !== undefined || existing.label !== undefined) {
    out.label = patch.label !== undefined ? patch.label : existing.label;
  }
  if (patch.budgetTokens !== undefined || existing.budgetTokens !== undefined) {
    out.budgetTokens = patch.budgetTokens !== undefined ? patch.budgetTokens : existing.budgetTokens;
  }
  return out;
}

/** 按服务商用位 cfg（供 provider.resolveHeaders 构造鉴权头） */
function pseudoModelConfig(p: ProviderConfig): ModelConfig {
  // 语音服务商没有 LLM 端点（调用方已拦截，此处兜底）
  if (p.format === 'voice') {
    throw new Error('provider has no LLM endpoint');
  }
  return {
    id: p.id,
    name: p.name,
    model: '',
    format: p.format,
    endpoint: p.endpoint,
    apiKey: p.apiKey,
    thinking: { enabled: false },
  };
}

/** 模型列表地址：自定义优先，否则按 format 推断 */
function resolveModelsUrl(p: ProviderConfig): string {
  if (p.modelsUrl && p.modelsUrl.trim()) return p.modelsUrl.trim();
  const base = p.endpoint.replace(/\/$/, '');
  if (p.format === 'gemini') return `${base}/models?pageSize=1000`;
  // openai-chat / openai-responses / anthropic：兼容 endpoint 含 /v1 与不含两种写法
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

/** usage 地址推导：subscription 末段替换为 usage；否则去末段拼 /usage */
function deriveUsageUrl(balanceUrl: string): string {
  const clean = balanceUrl.replace(/\/$/, '');
  const idx = clean.lastIndexOf('/');
  const dir = idx > 0 ? clean.slice(0, idx) : clean;
  const last = idx > 0 ? clean.slice(idx + 1) : '';
  if (last === 'subscription') return `${dir}/usage`;
  return `${dir}/usage`;
}

// ============================================================================
// 基础 CRUD
// ============================================================================

export function createListProvidersHandler(config: ConfigService): RouteHandler {
  return async (): Promise<HttpResponse> => {
    const apiConfig = config.getApiConfig();
    const appConfig = config.getAppConfig();
    return {
      status: 200,
      body: {
        providers: apiConfig.providers,
        current: appConfig.agent.defaultModel,
      },
    };
  };
}

export function createSetCurrentModelHandler(config: ConfigService): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const body = (req.body ?? {}) as { modelId?: string };
    if (!body.modelId) {
      return { status: 400, body: { error: ErrorCode.MODEL_ID_REQUIRED } };
    }
    const found = findModelInProviders(config.getApiConfig(), body.modelId);
    if (!found) {
      return { status: 404, body: { error: ErrorCode.MODEL_NOT_FOUND } };
    }
    try {
      await config.updateAppConfig({
        agent: { ...config.getAppConfig().agent, defaultModel: body.modelId },
      });
      return { status: 200, body: { current: body.modelId } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createCreateProviderHandler(config: ConfigService): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const body = (req.body ?? {}) as {
      name?: string;
      /** 服务商类型：model（默认）= 模型服务商；voice = 语音服务商 */
      kind?: 'model' | 'voice';
      format?: ProviderConfig['format'];
      /** 语音引擎（kind='voice' 必填）：openai-transcriptions */
      voiceEngine?: ProviderConfig['voiceEngine'];
      /** 语音模型名（kind='voice' 可选，如 whisper-1） */
      voiceModel?: string;
      endpoint?: string;
      apiKey?: string;
      balanceUrl?: string;
      modelsUrl?: string;
      icon?: string;
    };
    const kind = body.kind ?? 'model';

    if (kind === 'voice') {
      // 语音服务商：name + voiceEngine 必填；format 固定 'voice'；endpoint 为转写端点
      if (!body.name || !body.voiceEngine) {
        return { status: 400, body: { error: ErrorCode.PROVIDER_FIELDS_REQUIRED } };
      }
      try {
        const apiConfig = config.getApiConfig();
        const newProvider: ProviderConfig = {
          id: generateProviderId(),
          name: body.name,
          kind: 'voice',
          format: 'voice',
          voiceEngine: body.voiceEngine,
          ...(body.voiceModel?.trim() ? { voiceModel: body.voiceModel.trim() } : {}),
          endpoint: body.endpoint?.trim() ?? '',
          apiKey: body.apiKey ?? '',
          models: [],
          ...(body.icon?.trim() ? { icon: body.icon.trim() } : {}),
        };
        await config.updateApiConfig({ providers: [...apiConfig.providers, newProvider] });
        return { status: 201, body: newProvider };
      } catch (err) {
        return {
          status: 400,
          body: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    // 模型服务商（默认/向后兼容）：name + format + endpoint 必填
    if (!body.name || !body.format || !body.endpoint) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_FIELDS_REQUIRED } };
    }
    try {
      const apiConfig = config.getApiConfig();
      const newProvider: ProviderConfig = {
        id: generateProviderId(),
        name: body.name,
        format: body.format,
        endpoint: body.endpoint,
        apiKey: body.apiKey ?? '',
        models: [],
        ...(body.balanceUrl?.trim() ? { balanceUrl: body.balanceUrl.trim() } : {}),
        ...(body.modelsUrl?.trim() ? { modelsUrl: body.modelsUrl.trim() } : {}),
        // 品牌图标（空串 = 默认 Server，不落库；与 update handler 语义一致）
        ...(body.icon?.trim() ? { icon: body.icon.trim() } : {}),
      };
      await config.updateApiConfig({ providers: [...apiConfig.providers, newProvider] });
      return { status: 201, body: newProvider };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createUpdateProviderHandler(config: ConfigService): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    const body = (req.body ?? {}) as {
      name?: string;
      kind?: 'model' | 'voice';
      format?: ProviderConfig['format'];
      voiceEngine?: ProviderConfig['voiceEngine'];
      voiceModel?: string;
      endpoint?: string;
      apiKey?: string;
      balanceUrl?: string;
      modelsUrl?: string;
      icon?: string;
      services?: ProviderServiceConfig[];
    };
    try {
      const apiConfig = config.getApiConfig();
      const idx = apiConfig.providers.findIndex((p) => p.id === id);
      if (idx < 0) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
      }
      const existing = apiConfig.providers[idx];
      const isVoice = body.kind === 'voice' || existing.kind === 'voice';

      if (isVoice) {
        // 语音服务商：voiceEngine 必填（body 缺省沿用原值）；format 固定 'voice'
        const nextEngine = body.voiceEngine ?? existing.voiceEngine;
        if (!nextEngine) {
          return { status: 400, body: { error: 'VOICE_ENGINE_REQUIRED' } };
        }
        const newProvider: ProviderConfig = {
          id: existing.id,
          name: body.name ?? existing.name,
          kind: 'voice',
          format: 'voice',
          voiceEngine: nextEngine,
          ...(body.voiceModel !== undefined
            ? body.voiceModel.trim()
              ? { voiceModel: body.voiceModel.trim() }
              : {}
            : existing.voiceModel !== undefined
              ? { voiceModel: existing.voiceModel }
              : {}),
          endpoint: body.endpoint ?? existing.endpoint,
          apiKey: body.apiKey ?? existing.apiKey,
          models: [],
          ...(body.icon !== undefined
            ? body.icon.trim()
              ? { icon: body.icon.trim() }
              : {}
            : existing.icon !== undefined
              ? { icon: existing.icon }
              : {}),
        };
        const newProviders = [...apiConfig.providers];
        newProviders[idx] = newProvider;
        await config.updateApiConfig({ providers: newProviders });
        return { status: 200, body: newProvider };
      }

      const newProvider: ProviderConfig = {
        id: existing.id,
        name: body.name ?? existing.name,
        format: body.format ?? existing.format,
        endpoint: body.endpoint ?? existing.endpoint,
        // 空 apiKey 视为不修改（config-service 回填原值）
        apiKey: body.apiKey ?? existing.apiKey,
        models: existing.models,
        ...(body.balanceUrl !== undefined
          ? body.balanceUrl.trim()
            ? { balanceUrl: body.balanceUrl.trim() }
            : {}
          : existing.balanceUrl !== undefined
            ? { balanceUrl: existing.balanceUrl }
            : {}),
        ...(body.modelsUrl !== undefined
          ? body.modelsUrl.trim()
            ? { modelsUrl: body.modelsUrl.trim() }
            : {}
          : existing.modelsUrl !== undefined
            ? { modelsUrl: existing.modelsUrl }
            : {}),
        ...(body.icon !== undefined
          ? body.icon.trim()
            ? { icon: body.icon.trim() }
            : {}
          : existing.icon !== undefined
            ? { icon: existing.icon }
            : {}),
        ...(body.services !== undefined ? { services: body.services } : {}),
      };

      const newProviders = [...apiConfig.providers];
      newProviders[idx] = newProvider;
      await config.updateApiConfig({ providers: newProviders });
      return { status: 200, body: newProvider };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createDeleteProviderHandler(config: ConfigService): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    try {
      const apiConfig = config.getApiConfig();
      const provider = apiConfig.providers.find((p) => p.id === id);
      if (!provider) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
      }
      const newProviders = apiConfig.providers.filter((p) => p.id !== id);
      await config.updateApiConfig({ providers: newProviders });
      // 当前默认模型指向被删服务商旗下模型时重置
      const appConfig = config.getAppConfig();
      if (appConfig.agent.defaultModel && provider.models.some((m) => m.id === appConfig.agent.defaultModel)) {
        await config.updateAppConfig({
          agent: { ...appConfig.agent, defaultModel: '' },
        });
      }
      // 被删服务商是默认语音服务商时回退到本地引擎（''）
      if (appConfig.voice?.providerId && appConfig.voice.providerId === id) {
        await config.updateAppConfig({
          voice: { ...appConfig.voice, providerId: '' },
        });
      }
      return { status: 200, body: { deleted: true } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createReorderProvidersHandler(config: ConfigService): RouteHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const body = (req.body ?? {}) as { providerIds?: string[] };
    if (!body.providerIds || !Array.isArray(body.providerIds)) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_IDS_ARRAY_REQUIRED } };
    }
    try {
      const apiConfig = config.getApiConfig();
      const existingIds = new Set(apiConfig.providers.map((p) => p.id));
      if (body.providerIds.length !== apiConfig.providers.length) {
        return { status: 400, body: { error: ErrorCode.MODEL_IDS_LENGTH_MISMATCH } };
      }
      for (const id of body.providerIds) {
        if (!existingIds.has(id)) {
          return { status: 400, body: { error: ErrorCode.UNKNOWN_MODEL_ID } };
        }
      }
      const idToProvider = new Map(apiConfig.providers.map((p) => [p.id, p]));
      const reordered = body.providerIds.map((id) => idToProvider.get(id)!);
      await config.updateApiConfig({ providers: reordered });
      return { status: 200, body: { providers: reordered } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

// ============================================================================
// 服务商下的模型 CRUD
// ============================================================================

type ProviderModelInput = {
  name?: string;
  model?: string;
  thinking?: ThinkingPatch;
  contextWindow?: string;
  inputTokens?: number;
  outputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  /** 模型级思考强度等级库（整组写回；undefined = 不修改） */
  thinkingLevels?: ThinkingLevelConfig[];
};

/** 单个模型输入 → ProviderModelConfig（不含 id，由调用方决定生成或保留） */
function buildModelConfig(
  input: ProviderModelInput,
  id: string,
  baseThinking?: ProviderModelConfig['thinking'],
): ProviderModelConfig {
  return {
    id,
    name: input.name ?? input.model ?? '',
    model: input.model ?? '',
    thinking: mergeThinking(baseThinking ?? { enabled: false }, input.thinking),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { topP: input.topP } : {}),
    ...(input.topK !== undefined ? { topK: input.topK } : {}),
    ...(input.thinkingLevels !== undefined ? { thinkingLevels: input.thinkingLevels } : {}),
  };
}

export function createAddProviderModelsHandler(config: ConfigService): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    // 兼容批量 {models: [...]} 与单个 {name, model, ...} 两种 body
    const raw = (req.body ?? {}) as ProviderModelInput & { models?: ProviderModelInput[] };
    const inputs = Array.isArray(raw.models) && raw.models.length > 0 ? raw.models : [raw];
    const validated = inputs.filter((m) => m.name && m.model);
    if (validated.length === 0) {
      return { status: 400, body: { error: ErrorCode.MODEL_FIELDS_REQUIRED } };
    }
    try {
      const apiConfig = config.getApiConfig();
      const idx = apiConfig.providers.findIndex((p) => p.id === id);
      if (idx < 0) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
      }
      const provider = apiConfig.providers[idx];
      // 组内 model 名查重
      const existingModels = new Set(provider.models.map((m) => m.model));
      const toAdd: ProviderModelConfig[] = [];
      for (const input of validated) {
        if (existingModels.has(input.model!)) continue; // 已存在：跳过（幂等）
        const model = buildModelConfig(input, generateModelId());
        existingModels.add(model.model);
        toAdd.push(model);
      }
      const newProvider: ProviderConfig = { ...provider, models: [...provider.models, ...toAdd] };
      const newProviders = [...apiConfig.providers];
      newProviders[idx] = newProvider;
      await config.updateApiConfig({ providers: newProviders });
      return { status: 201, body: { provider: newProvider, added: toAdd.length } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createUpdateProviderModelHandler(config: ConfigService): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const providerId = params?.id;
    const modelId = params?.modelId;
    if (!providerId) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    if (!modelId) {
      return { status: 400, body: { error: ErrorCode.MODEL_ID_REQUIRED } };
    }
    const body = (req.body ?? {}) as ProviderModelInput;
    try {
      // thinkingLevels 专项校验：至少保留 1 个等级，每条 id/label/effort 非空
      if (body.thinkingLevels !== undefined) {
        const levels = body.thinkingLevels;
        if (!Array.isArray(levels) || levels.length === 0) {
          return { status: 400, body: { error: 'THINKING_LEVELS_KEEP_ONE' } };
        }
        if (levels.some((l) => !l.id?.trim() || !l.label?.trim() || !l.effort?.trim())) {
          return { status: 400, body: { error: 'THINKING_LEVELS_INVALID' } };
        }
      }
      const apiConfig = config.getApiConfig();
      const pIdx = apiConfig.providers.findIndex((p) => p.id === providerId);
      if (pIdx < 0) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
      }
      const provider = apiConfig.providers[pIdx];
      const mIdx = provider.models.findIndex((m) => m.id === modelId);
      if (mIdx < 0) {
        return { status: 404, body: { error: ErrorCode.MODEL_NOT_FOUND } };
      }
      const existing = provider.models[mIdx];
      // thinking 合并；thinkingLevels 变更后若模型当前档被删 → 原子回退到相邻档位
      let nextThinking = mergeThinking(existing.thinking, body.thinking);
      if (body.thinkingLevels !== undefined) {
        const newEfforts = new Set(body.thinkingLevels.map((l) => l.effort));
        const curEffort = nextThinking.effort;
        if (nextThinking.enabled && curEffort && !newEfforts.has(curEffort)) {
          const oldLevels = existing.thinkingLevels ?? DEFAULT_THINKING_LEVELS;
          const i = oldLevels.findIndex((l) => l.effort === curEffort);
          if (i >= 0) {
            // 回退目标：原列表前一个（更低档）；无则向后找；均需存在于新库
            let target: ThinkingLevelConfig | undefined;
            for (let j = i - 1; j >= 0; j--) {
              if (newEfforts.has(oldLevels[j].effort)) { target = oldLevels[j]; break; }
            }
            if (!target) {
              for (let j = i + 1; j < oldLevels.length; j++) {
                if (newEfforts.has(oldLevels[j].effort)) { target = oldLevels[j]; break; }
              }
            }
            if (target) {
              nextThinking = target.effort === 'off'
                ? { enabled: false }
                : { enabled: true, effort: target.effort, label: target.label };
            }
          }
        }
      }
      const newModel: ProviderModelConfig = {
        id: existing.id,
        name: body.name ?? existing.name,
        model: body.model ?? existing.model,
        thinking: nextThinking,
        ...(body.contextWindow !== undefined
          ? { contextWindow: body.contextWindow }
          : existing.contextWindow !== undefined
            ? { contextWindow: existing.contextWindow }
            : {}),
        ...(body.inputTokens !== undefined
          ? { inputTokens: body.inputTokens }
          : existing.inputTokens !== undefined
            ? { inputTokens: existing.inputTokens }
            : {}),
        ...(body.outputTokens !== undefined
          ? { outputTokens: body.outputTokens }
          : existing.outputTokens !== undefined
            ? { outputTokens: existing.outputTokens }
            : {}),
        ...(body.temperature !== undefined
          ? { temperature: body.temperature }
          : existing.temperature !== undefined
            ? { temperature: existing.temperature }
            : {}),
        ...(body.topP !== undefined
          ? { topP: body.topP }
          : existing.topP !== undefined
            ? { topP: existing.topP }
            : {}),
        ...(body.topK !== undefined
          ? { topK: body.topK }
          : existing.topK !== undefined
            ? { topK: existing.topK }
            : {}),
        ...(body.thinkingLevels !== undefined
          ? { thinkingLevels: body.thinkingLevels }
          : existing.thinkingLevels !== undefined
            ? { thinkingLevels: existing.thinkingLevels }
            : {}),
      };
      const newModels = [...provider.models];
      newModels[mIdx] = newModel;
      const newProvider = { ...provider, models: newModels };
      const newProviders = [...apiConfig.providers];
      newProviders[pIdx] = newProvider;
      await config.updateApiConfig({ providers: newProviders });
      return { status: 200, body: newModel };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createDeleteProviderModelHandler(config: ConfigService): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const providerId = params?.id;
    const modelId = params?.modelId;
    if (!providerId) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    if (!modelId) {
      return { status: 400, body: { error: ErrorCode.MODEL_ID_REQUIRED } };
    }
    try {
      const apiConfig = config.getApiConfig();
      const pIdx = apiConfig.providers.findIndex((p) => p.id === providerId);
      if (pIdx < 0) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
      }
      const provider = apiConfig.providers[pIdx];
      const exists = provider.models.some((m) => m.id === modelId);
      if (!exists) {
        return { status: 404, body: { error: ErrorCode.MODEL_NOT_FOUND } };
      }
      const newProvider: ProviderConfig = {
        ...provider,
        models: provider.models.filter((m) => m.id !== modelId),
      };
      const newProviders = [...apiConfig.providers];
      newProviders[pIdx] = newProvider;
      await config.updateApiConfig({ providers: newProviders });
      // 当前默认模型被删时重置
      const appConfig = config.getAppConfig();
      if (appConfig.agent.defaultModel === modelId) {
        await config.updateAppConfig({
          agent: { ...appConfig.agent, defaultModel: '' },
        });
      }
      return { status: 200, body: { deleted: true } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

// ============================================================================
// 服务商附加服务 CRUD（当前仅文件存储）
// ============================================================================

/** 生成服务 id：service_{timestamp}_{random} */
function generateServiceId(): string {
  return `service_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createAddProviderServiceHandler(config: ConfigService): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    const body = (req.body ?? {}) as {
      name?: string;
      type?: ProviderServiceConfig['type'];
      endpoint?: string;
      apiKey?: string;
      maxQuota?: number;
      quotaUnit?: ProviderServiceConfig['quotaUnit'];
    };
    if (!body.name || !body.endpoint) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_FIELDS_REQUIRED } };
    }
    try {
      const apiConfig = config.getApiConfig();
      const idx = apiConfig.providers.findIndex((p) => p.id === id);
      if (idx < 0) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
      }
      const provider = apiConfig.providers[idx];
      const newService: ProviderServiceConfig = {
        id: generateServiceId(),
        name: body.name,
        type: body.type ?? 'file-storage',
        endpoint: body.endpoint,
        apiKey: body.apiKey ?? '',
        ...(body.maxQuota !== undefined ? { maxQuota: body.maxQuota } : {}),
        ...(body.quotaUnit !== undefined ? { quotaUnit: body.quotaUnit } : {}),
      };
      const newProvider: ProviderConfig = {
        ...provider,
        services: [...(provider.services ?? []), newService],
      };
      const newProviders = [...apiConfig.providers];
      newProviders[idx] = newProvider;
      await config.updateApiConfig({ providers: newProviders });
      return { status: 201, body: newService };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createUpdateProviderServiceHandler(config: ConfigService): RouteHandler {
  return async (req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const providerId = params?.id;
    const serviceId = params?.serviceId;
    if (!providerId) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    if (!serviceId) {
      return { status: 400, body: { error: ErrorCode.ID_REQUIRED } };
    }
    const body = (req.body ?? {}) as {
      name?: string;
      type?: ProviderServiceConfig['type'];
      endpoint?: string;
      apiKey?: string;
      maxQuota?: number;
      quotaUnit?: ProviderServiceConfig['quotaUnit'];
    };
    try {
      const apiConfig = config.getApiConfig();
      const pIdx = apiConfig.providers.findIndex((p) => p.id === providerId);
      if (pIdx < 0) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
      }
      const provider = apiConfig.providers[pIdx];
      const services = provider.services ?? [];
      const sIdx = services.findIndex((s) => s.id === serviceId);
      if (sIdx < 0) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_SERVICE_NOT_FOUND } };
      }
      const existing = services[sIdx];
      // 空 apiKey 视为不修改（保留原值）
      const newService: ProviderServiceConfig = {
        id: existing.id,
        name: body.name ?? existing.name,
        type: body.type ?? existing.type,
        endpoint: body.endpoint ?? existing.endpoint,
        apiKey: body.apiKey !== undefined && body.apiKey !== '' ? body.apiKey : existing.apiKey,
        ...(body.maxQuota !== undefined
          ? { maxQuota: body.maxQuota }
          : existing.maxQuota !== undefined
            ? { maxQuota: existing.maxQuota }
            : {}),
        ...(body.quotaUnit !== undefined
          ? { quotaUnit: body.quotaUnit }
          : existing.quotaUnit !== undefined
            ? { quotaUnit: existing.quotaUnit }
            : {}),
      };
      const newServices = [...services];
      newServices[sIdx] = newService;
      const newProvider = { ...provider, services: newServices };
      const newProviders = [...apiConfig.providers];
      newProviders[pIdx] = newProvider;
      await config.updateApiConfig({ providers: newProviders });
      return { status: 200, body: newService };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function createDeleteProviderServiceHandler(config: ConfigService): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const providerId = params?.id;
    const serviceId = params?.serviceId;
    if (!providerId) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    if (!serviceId) {
      return { status: 400, body: { error: ErrorCode.ID_REQUIRED } };
    }
    try {
      const apiConfig = config.getApiConfig();
      const pIdx = apiConfig.providers.findIndex((p) => p.id === providerId);
      if (pIdx < 0) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
      }
      const provider = apiConfig.providers[pIdx];
      const services = provider.services ?? [];
      const exists = services.some((s) => s.id === serviceId);
      if (!exists) {
        return { status: 404, body: { error: ErrorCode.PROVIDER_SERVICE_NOT_FOUND } };
      }
      const newProvider: ProviderConfig = {
        ...provider,
        services: services.filter((s) => s.id !== serviceId),
      };
      const newProviders = [...apiConfig.providers];
      newProviders[pIdx] = newProvider;
      await config.updateApiConfig({ providers: newProviders });
      return { status: 200, body: { deleted: true } };
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

// ============================================================================
// 模型连通性测试
// ============================================================================

export function createTestProviderModelHandler(services: ServiceRegistry): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const providerId = params?.id;
    const modelId = params?.modelId;
    if (!providerId) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    if (!modelId) {
      return { status: 400, body: { error: ErrorCode.MODEL_ID_REQUIRED } };
    }
    const router = services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER);
    if (!router) {
      return { status: 503, body: { error: ErrorCode.LLM_ROUTER_UNAVAILABLE } };
    }
    const start = Date.now();
    try {
      await router.complete({
        model: modelId,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
        stream: false,
      });
      const latencyMs = Date.now() - start;
      return { status: 200, body: { success: true, latencyMs, model: modelId } };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return {
        status: 200,
        body: {
          success: false,
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };
}

// ============================================================================
// 远程模型列表拉取（服务端代理）
// ============================================================================

type RemoteModel = { id: string; name?: string };

/** 归一化各格式模型列表响应：OpenAI/Anthropic {data:[]}；Gemini {models:[{name}]} */
function parseRemoteModels(raw: unknown): RemoteModel[] {
  if (raw === null || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const out: RemoteModel[] = [];

  // OpenAI / Anthropic：{ data: [{ id, display_name? }] }
  if (Array.isArray(obj.data)) {
    for (const item of obj.data) {
      if (item === null || typeof item !== 'object') continue;
      const m = item as Record<string, unknown>;
      if (typeof m.id !== 'string' || !m.id) continue;
      const displayName = typeof m.display_name === 'string' ? m.display_name : undefined;
      out.push({ id: m.id, ...(displayName && displayName !== m.id ? { name: displayName } : {}) });
    }
    return out;
  }

  // Gemini：{ models: [{ name: 'models/xxx', displayName? }] }
  if (Array.isArray(obj.models)) {
    for (const item of obj.models) {
      if (item === null || typeof item !== 'object') continue;
      const m = item as Record<string, unknown>;
      if (typeof m.name !== 'string' || !m.name) continue;
      const id = m.name.replace(/^models\//, '');
      if (!id) continue;
      const displayName = typeof m.displayName === 'string' ? m.displayName : undefined;
      out.push({ id, ...(displayName && displayName !== id ? { name: displayName } : {}) });
    }
    return out;
  }

  return out;
}

export function createFetchProviderModelsHandler(
  config: ConfigService,
  logger: Logger,
): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    const provider = config.getApiConfig().providers.find((p) => p.id === id);
    if (!provider) {
      return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
    }
    // 语音服务商无模型列表概念
    if (provider.kind === 'voice' || provider.format === 'voice') {
      return { status: 200, body: { success: false, error: 'NOT_A_MODEL_PROVIDER' } };
    }
    const url = resolveModelsUrl(provider);
    try {
      const provider0 = getProvider(provider.format);
      const headers = provider0.resolveHeaders(pseudoModelConfig(provider));
      const resp = await httpRequest(
        { url, method: 'GET', headers, body: null, timeoutMs: EXTERNAL_TIMEOUT_MS },
        logger,
      );
      if (resp.status >= 400 || !resp.text) {
        return {
          status: 200,
          body: { success: false, error: `HTTP ${resp.status} from ${url}` },
        };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(resp.text);
      } catch {
        return { status: 200, body: { success: false, error: 'Invalid JSON response' } };
      }
      const models = parseRemoteModels(raw);
      return { status: 200, body: { success: true, models, url } };
    } catch (err) {
      return {
        status: 200,
        body: { success: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

// ============================================================================
// 余额查询（服务端代理，OpenAI 兼容计费格式）
// ============================================================================

export function createProviderBalanceHandler(
  config: ConfigService,
  logger: Logger,
): RouteHandler {
  return async (_req: HttpRequest, params?: Record<string, string>): Promise<HttpResponse> => {
    const id = params?.id;
    if (!id) {
      return { status: 400, body: { error: ErrorCode.PROVIDER_ID_REQUIRED } };
    }
    const provider = config.getApiConfig().providers.find((p) => p.id === id);
    if (!provider) {
      return { status: 404, body: { error: ErrorCode.PROVIDER_NOT_FOUND } };
    }
    // 语音服务商无余额查询概念
    if (provider.kind === 'voice' || provider.format === 'voice') {
      return { status: 200, body: { success: false, error: 'NOT_A_MODEL_PROVIDER' } };
    }
    if (!provider.balanceUrl || !provider.balanceUrl.trim()) {
      return {
        status: 200,
        body: { success: false, error: 'BALANCE_URL_NOT_CONFIGURED' },
      };
    }
    const subscriptionUrl = provider.balanceUrl.trim();
    const usageUrl = deriveUsageUrl(subscriptionUrl);
    const headers = getProvider(provider.format).resolveHeaders(pseudoModelConfig(provider));

    try {
      const subResp = await httpRequest(
        { url: subscriptionUrl, method: 'GET', headers, body: null, timeoutMs: EXTERNAL_TIMEOUT_MS },
        logger,
      );
      if (subResp.status >= 400 || !subResp.text) {
        return {
          status: 200,
          body: { success: false, error: `subscription HTTP ${subResp.status}` },
        };
      }
      const sub = JSON.parse(subResp.text) as { hard_limit_usd?: number };
      const totalUsd = typeof sub.hard_limit_usd === 'number' ? sub.hard_limit_usd : undefined;
      if (totalUsd === undefined) {
        return {
          status: 200,
          body: { success: false, error: 'hard_limit_usd missing in response' },
        };
      }

      // usage 请求失败（如 404）时降级：仅返回总额度
      let usedUsd: number | undefined;
      try {
        const usageResp = await httpRequest(
          { url: usageUrl, method: 'GET', headers, body: null, timeoutMs: EXTERNAL_TIMEOUT_MS },
          logger,
        );
        if (usageResp.status < 400 && usageResp.text) {
          const usage = JSON.parse(usageResp.text) as { total_usage?: number };
          if (typeof usage.total_usage === 'number') {
            usedUsd = usage.total_usage / 100; // total_usage 单位为分
          }
        }
      } catch {
        // usage 不可用：降级，不阻断
      }

      const balanceUsd = usedUsd !== undefined ? totalUsd - usedUsd : undefined;
      return {
        status: 200,
        body: {
          success: true,
          totalUsd,
          ...(usedUsd !== undefined ? { usedUsd } : {}),
          ...(balanceUsd !== undefined ? { balanceUsd } : {}),
        },
      };
    } catch (err) {
      return {
        status: 200,
        body: { success: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}
