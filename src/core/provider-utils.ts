// src/core/provider-utils.ts
// 服务商层工具：扁平视图（flattenModels）、模型查找、id 生成、旧版配置迁移。
// ModelConfig 作为运行时扁平视图类型，由本文件从 providers 结构合成。

// 注意：迁移校验不使用 zod —— core/provider-utils 在启动静态闭包内（llm/context 模块
// 直接 import flattenModels），zod 会因此进入启动路径。旧版迁移只需结构校验，手写即可。
import type { ApiConfig, ModelConfig, ProviderConfig, ProviderModelConfig } from './types';

/** 生成服务商 id：provider_{timestamp}_{random} */
export function generateProviderId(): string {
  return `provider_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成模型 id：model_{timestamp}_{random} */
export function generateModelId(): string {
  return `model_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 剔除已彻底移除的服务商类型（voice / 旧 search）。
 * 快速路径（启动）与完整校验（zod preprocess）使用同一判定口径。
 * 原地修改 raw.providers；返回 true 表示发生删除（调用方需落盘）。
 */
export function stripRemovedProviders(raw: Record<string, unknown> | null): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const providers = raw.providers;
  if (!Array.isArray(providers)) return false;
  const kept = providers.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    const record = item as { kind?: unknown; format?: unknown };
    return (
      record.kind !== 'voice' &&
      record.format !== 'voice' &&
      record.kind !== 'search' &&
      record.format !== 'search'
    );
  });
  if (kept.length === providers.length) return false;
  raw.providers = kept;
  return true;
}

/**
 * 将 providers 结构展开为扁平 ModelConfig 列表：
 * provider 的 format/endpoint/apiKey 合并进每个模型，模型自身字段原样保留。
 * 供 LLMRouter / context / agent 等运行时消费。
 */
export function flattenModels(cfg: ApiConfig): ModelConfig[] {
  const out: ModelConfig[] = [];
  for (const provider of cfg.providers) {
    for (const model of provider.models) {
      out.push({
        id: model.id,
        name: model.name,
        model: model.model,
        format: provider.format,
        endpoint: provider.endpoint,
        apiKey: provider.apiKey,
        thinking: model.thinking,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.inputTokens !== undefined ? { inputTokens: model.inputTokens } : {}),
        ...(model.outputTokens !== undefined ? { outputTokens: model.outputTokens } : {}),
        ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
        ...(model.topP !== undefined ? { topP: model.topP } : {}),
        ...(model.topK !== undefined ? { topK: model.topK } : {}),
      });
    }
  }
  return out;
}

/**
 * 按 modelId 查找模型及其所属服务商：
 * 先按模型 id 精确匹配，找不到则按 model 字段（API 模型名）兜底。
 */
export function findModelInProviders(
  cfg: ApiConfig,
  modelId: string,
): { provider: ProviderConfig; model: ProviderModelConfig } | undefined {
  // 先按 id 精确匹配
  for (const provider of cfg.providers) {
    const byId = provider.models.find((m) => m.id === modelId);
    if (byId) return { provider, model: byId };
  }
  // 兜底：按 model 字段（API 模型名）匹配
  for (const provider of cfg.providers) {
    const byModel = provider.models.find((m) => m.model === modelId);
    if (byModel) return { provider, model: byModel };
  }
  return undefined;
}

// ============================================================================
// 旧版配置迁移（扁平 models → providers）
// ============================================================================

/** 旧版模型合法格式（迁移仅接受这四种；voice 是 v2 引入的） */
const LEGACY_MODEL_FORMATS = new Set(['openai-chat', 'openai-responses', 'anthropic', 'gemini']);

/**
 * 旧版扁平模型的结构校验（迁移用，宽松跳过脏条目）。
 * 等价于原 zod schema 的关键约束，不引入 zod 依赖。
 */
function parseLegacyModel(item: unknown): ModelConfig | null {
  if (!item || typeof item !== 'object') return null;
  const m = item as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length === 0) return null;
  if (typeof m.name !== 'string' || typeof m.model !== 'string') return null;
  if (typeof m.format !== 'string' || !LEGACY_MODEL_FORMATS.has(m.format)) return null;
  if (typeof m.endpoint !== 'string' || typeof m.apiKey !== 'string') return null;
  const thinking = m.thinking;
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return null;
  const t = thinking as Record<string, unknown>;
  if (typeof t.enabled !== 'boolean') return null;
  for (const key of ['effort', 'label', 'contextWindow'] as const) {
    if (m[key] !== undefined && typeof m[key] !== 'string') return null;
  }
  for (const key of ['budgetTokens', 'inputTokens', 'outputTokens', 'topK'] as const) {
    if (m[key] !== undefined && !isPositiveInt(m[key])) return null;
  }
  for (const key of ['temperature', 'topP'] as const) {
    if (m[key] !== undefined && !(typeof m[key] === 'number' && Number.isFinite(m[key]))) return null;
  }
  return m as unknown as ModelConfig;
}

/** 正整数判定（旧版迁移的 token 数约束） */
function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 从 endpoint URL 提取 host 作为默认服务商名（如 https://api.openai.com/v1 → api.openai.com） */
function hostFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

/**
 * 旧版扁平 models（version 1）→ providers 结构（version 2）迁移（原地修改 raw 对象）。
 * 按 format|endpoint|apiKey 分组：每组生成一个服务商（name 取 endpoint host，重复追加序号），
 * 模型字段原样搬入（保留原 id，defaultModel 引用不断裂）。
 * 返回 true 表示发生了迁移；非旧结构（已是 providers 或无 models 键）返回 false。
 */
export function migrateLegacyApiConfig(raw: Record<string, unknown> | null): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const legacyModels = raw.models;
  if (!Array.isArray(legacyModels) || legacyModels.length === 0) {
    // 空旧结构（{version:1, models:[]}）：仅去掉 models 键升级 version
    if (Array.isArray(legacyModels) && !Array.isArray(raw.providers)) {
      delete raw.models;
      raw.version = 2;
      raw.providers = [];
      return true;
    }
    return false;
  }
  if (Array.isArray(raw.providers)) return false; // 已是新结构

  // 逐个校验旧模型（宽松：跳过非法条目，避免单条脏数据阻断整体迁移）
  const valid: ModelConfig[] = [];
  for (const item of legacyModels) {
    const parsed = parseLegacyModel(item);
    if (parsed) valid.push(parsed);
  }

  // 按 format|endpoint|apiKey 分组
  const groups = new Map<string, ProviderConfig>();
  for (const m of valid) {
    const key = `${m.format}|${m.endpoint}|${m.apiKey}`;
    let provider = groups.get(key);
    if (!provider) {
      provider = {
        id: generateProviderId(),
        name: hostFromEndpoint(m.endpoint),
        format: m.format,
        endpoint: m.endpoint,
        apiKey: m.apiKey,
        models: [],
      };
      groups.set(key, provider);
    }
    provider.models.push({
      id: m.id,
      name: m.name,
      model: m.model,
      thinking: m.thinking,
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.inputTokens !== undefined ? { inputTokens: m.inputTokens } : {}),
      ...(m.outputTokens !== undefined ? { outputTokens: m.outputTokens } : {}),
      ...(m.temperature !== undefined ? { temperature: m.temperature } : {}),
      ...(m.topP !== undefined ? { topP: m.topP } : {}),
      ...(m.topK !== undefined ? { topK: m.topK } : {}),
    });
  }

  // 重名服务商追加序号（同 host 不同 key 的场景）
  const providers = [...groups.values()];
  const nameCount = new Map<string, number>();
  for (const p of providers) {
    const n = nameCount.get(p.name) ?? 0;
    nameCount.set(p.name, n + 1);
    if (n > 0) p.name = `${p.name}-${n + 1}`;
  }

  delete raw.models;
  raw.version = 2;
  raw.providers = providers;
  return true;
}
