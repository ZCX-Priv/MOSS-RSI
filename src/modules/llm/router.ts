// src/modules/llm/router.ts
// LLM 路由器：按 modelId 查找 ModelConfig + 流式/非流式分发。

import { t } from '../../core/i18n';
import { flattenModels } from '../../core/provider-utils';
import { getProvider } from './providers';
import { httpRequest } from './client';
import { parseSSEStream } from './stream';
import { LLMError } from './types';
import type {
  LLMProvider,
  ModelConfig,
  StreamDelta,
  UnifiedRequest,
  UnifiedResponse,
} from './types';
import type { ConfigService, Logger, EventBus } from '../../core/types';
import type { LLMRouter } from '../contracts';

export class LLMRouterImpl implements LLMRouter {
  private readonly config: ConfigService;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  constructor(config: ConfigService, eventBus: EventBus, logger: Logger) {
    this.config = config;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  async complete(req: UnifiedRequest, signal?: AbortSignal): Promise<UnifiedResponse> {
    const cfg = this.resolveModel(req.model);
    const provider = getProvider(cfg.format);

    const endpoint = provider.resolveEndpoint(cfg);
    const headers = provider.resolveHeaders(cfg);
    const body = provider.transformRequest({ ...req, model: cfg.model, stream: false }, cfg);

    // 发出前 hook
    const processed = await this.eventBus.emit('llm:request:before', {
      endpoint,
      body,
      provider: cfg.format,
      model: cfg.model,
    });
    const finalEndpoint = processed.endpoint;
    const finalBody = processed.body;

    this.logger.debug(t('llm.request', { model: cfg.model }), {
      provider: cfg.format,
      endpoint: finalEndpoint,
    });

    const resp = await httpRequest(
      {
        url: finalEndpoint,
        method: 'POST',
        headers,
        body: finalBody,
        stream: false,
        signal,
      },
      this.logger,
    );

    if (!resp.text) {
      throw new LLMError('Empty response body', resp.status, false);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(resp.text);
    } catch (err) {
      throw new LLMError(
        `Invalid JSON response: ${err instanceof Error ? err.message : err}`,
        resp.status,
        false,
        resp.text,
      );
    }

    const result = provider.transformResponse(raw);

    // 响应后 hook
    await this.eventBus.broadcast('llm:response:after', {
      provider: cfg.format,
      model: cfg.model,
      usage: result.usage,
    });

    return result;
  }

  async *stream(req: UnifiedRequest, signal?: AbortSignal): AsyncIterable<StreamDelta> {
    const cfg = this.resolveModel(req.model);
    const provider = getProvider(cfg.format);

    const endpoint = this.resolveStreamEndpoint(provider, cfg);
    const headers = provider.resolveHeaders(cfg);
    const body = provider.transformRequest({ ...req, model: cfg.model, stream: true }, cfg);

    const processed = await this.eventBus.emit('llm:request:before', {
      endpoint,
      body,
      provider: cfg.format,
      model: cfg.model,
    });

    this.logger.debug(t('llm.streamRequest', { model: cfg.model }), {
      provider: cfg.format,
      endpoint: processed.endpoint,
    });

    const resp = await httpRequest(
      {
        url: processed.endpoint,
        method: 'POST',
        headers,
        body: processed.body,
        stream: true,
        signal,
      },
      this.logger,
    );

    if (!resp.stream) {
      throw new LLMError('No stream in response', resp.status, false);
    }
    // 双保险：client.ts 已检查流式状态码，这里再校验一次
    if (resp.status >= 400) {
      throw new LLMError(
        `LLM stream HTTP ${resp.status}`,
        resp.status,
        false,
      );
    }

    // 空闲超时可配置（config.agent.llmStreamIdleTimeoutMs）：长程任务/推理型模型长思考
    // 需要放宽，避免 5 分钟空档把仍在思考的 run 误判为超时而中断
    const idleTimeoutMs = this.resolveStreamIdleTimeoutMs();

    for await (const chunkText of parseSSEStream(resp.stream, { idleTimeoutMs })) {
      const delta = provider.transformStreamChunk(chunkText);
      if (delta === null) continue;
      if (Array.isArray(delta)) {
        for (const d of delta) yield d;
      } else {
        yield delta;
      }
    }

    await this.eventBus.broadcast('llm:response:after', {
      provider: cfg.format,
      model: cfg.model,
      stream: true,
    });
  }

  // ========================================================================

  /**
   * 按 modelId 查找模型：先按 id 精确匹配，找不到则按 model 字段（API 模型名）兜底。
   * 数据源为 providers 扁平视图（flattenModels 合并 provider 连接信息）。
   * 找不到则抛 LLMError；apiKey 为空也抛 LLMError。
   */
  private resolveModel(modelId: string): ModelConfig {
    const models = flattenModels(this.config.getApiConfig());

    // 先按 id 精确匹配
    const byId = models.find(m => m.id === modelId);
    if (byId) {
      this.ensureApiKey(byId);
      return byId;
    }

    // 兜底：按 model 字段（API 模型名）匹配
    const byModel = models.find(m => m.model === modelId);
    if (byModel) {
      this.ensureApiKey(byModel);
      return byModel;
    }

    throw new LLMError(
      `Model "${modelId}" not found in api.json. Available: ${models.map(m => m.id).join(', ') || '(none)'}`,
      undefined,
      false,
    );
  }

  /** 空 apiKey 校验：避免无意义的 401 往返，给用户明确指引 */
  private ensureApiKey(cfg: ModelConfig): void {
    if (!cfg.apiKey) {
      throw new LLMError(
        `模型 "${cfg.model}" 的 API Key 未配置，请在设置中填写。`,
        undefined,
        false,
      );
    }
  }

  /** 流式端点：Gemini 用 streamGenerateContent，其他 provider 用同 endpoint */
  private resolveStreamEndpoint(provider: LLMProvider, cfg: ModelConfig): string {
    // Gemini 专用流式端点
    if (cfg.format === 'gemini') {
      const base = cfg.endpoint.replace(/\/$/, '');
      return `${base}/models/${cfg.model}:streamGenerateContent?alt=sse`;
    }
    return provider.resolveEndpoint(cfg);
  }

  /**
   * 读取 SSE 空闲超时（毫秒）。配置缺失/非法时返回 undefined，
   * 由 parseSSEStream 使用内置默认值（15 分钟）与硬上限兜底。
   */
  private resolveStreamIdleTimeoutMs(): number | undefined {
    try {
      const v = this.config.getAppConfig().agent.llmStreamIdleTimeoutMs;
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  }
}
