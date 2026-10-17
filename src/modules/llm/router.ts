// src/modules/llm/router.ts
// LLM 路由器：按 modelId 查找 ModelConfig + 流式/非流式分发。

import { t } from '../../core/i18n';
import { flattenModels } from '../../core/provider-utils';
import { getProvider } from './providers';
import { httpRequest, type HttpResponse } from './client';
import { parseSSEStream } from './stream';
import { LLMError } from './types';
import { serializedBodyBytes, shrinkUnifiedRequest, type ShrinkOptions } from './request-budget';
import { DEFAULT_MAX_REQUEST_BYTES, MIN_MAX_REQUEST_BYTES } from '../context/types';
import type {
  LLMProvider,
  ModelConfig,
  StreamDelta,
  UnifiedRequest,
  UnifiedResponse,
} from './types';
import type { ConfigService, Logger, EventBus } from '../../core/types';
import type { LLMRouter } from '../contracts';

/** 发送前字节护栏：单次请求最多执行多少步降级（丢图/截断） */
const MAX_SHRINK_STEPS = 8;
/** 收到 HTTP 413 后最多收紧上限并重试的次数 */
const MAX_413_RETRIES = 2;
/** 末位护栏的截断口径（与 context.toolPruning 无关，仅保证任何请求体可收敛） */
const SHRINK_OPTIONS: ShrinkOptions = { keepHeadChars: 8192, keepTailChars: 2048 };

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

    const resp = await this.sendWithByteGuard(
      provider,
      cfg,
      req,
      false,
      provider.resolveEndpoint(cfg),
      signal,
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

    const resp = await this.sendWithByteGuard(
      provider,
      cfg,
      req,
      true,
      this.resolveStreamEndpoint(provider, cfg),
      signal,
    );

    if (!resp.stream) {
      throw new LLMError('No stream in response', resp.status, false);
    }
    // 双保险：client.ts 已检查流式状态码，这里再校验一次
    if (resp.status >= 400) {
      throw new LLMError(`LLM stream HTTP ${resp.status}`, resp.status, false);
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
   * 发送请求（含请求体字节护栏；complete / stream 共用）：
   *  1. transform → 精确测量序列化字节；超上限则逐级降级（丢图片 → 截断超长内容）后重新测量；
   *  2. 发出前 hook（可改 endpoint/body）；
   *  3. 发送；若服务端返回 413（真实上限小于配置值）→ 收紧上限一半并重试（有界）。
   * 所有 provider / 格式共用这一条路径 → 任何请求体都不会无界增长。
   */
  private async sendWithByteGuard(
    provider: LLMProvider,
    cfg: ModelConfig,
    req: UnifiedRequest,
    stream: boolean,
    defaultEndpoint: string,
    signal: AbortSignal | undefined,
  ): Promise<HttpResponse> {
    let cap = this.resolveMaxRequestBytes();
    for (let retry = 0; ; retry++) {
      // 1. 构建 body 并按字节上限逐级降级
      let current: UnifiedRequest = { ...req, model: cfg.model, stream };
      let body = provider.transformRequest(current, cfg);
      let bytes = serializedBodyBytes(body);
      let droppedImages = 0;
      let truncatedContents = 0;
      for (let step = 0; step < MAX_SHRINK_STEPS && bytes > cap; step++) {
        const shrunk = shrinkUnifiedRequest(current.messages, SHRINK_OPTIONS);
        if (!shrunk.changed) break;
        current = { ...current, messages: shrunk.messages };
        droppedImages += shrunk.droppedImages;
        truncatedContents += shrunk.truncatedContents;
        body = provider.transformRequest(current, cfg);
        bytes = serializedBodyBytes(body);
      }

      // 诊断日志：bytes/cap 是校准「服务端真实上限」的关键数据
      this.logger.debug(
        stream
          ? t('llm.streamRequest', { model: cfg.model })
          : t('llm.request', { model: cfg.model }),
        { provider: cfg.format, endpoint: defaultEndpoint, bytes, cap, droppedImages, truncatedContents },
      );
      if (droppedImages > 0 || truncatedContents > 0 || bytes > cap) {
        this.logger.warn(
          t('llm.requestBodyGuard', { bytes, cap, droppedImages, truncatedContents }),
          {
            model: cfg.model,
            provider: cfg.format,
            bytes,
            cap,
            droppedImages,
            truncatedContents,
            overCap: bytes > cap,
          },
        );
      }

      // 2. 发出前 hook
      const processed = await this.eventBus.emit('llm:request:before', {
        endpoint: defaultEndpoint,
        body,
        provider: cfg.format,
        model: cfg.model,
      });

      // 3. 发送 + 413 收紧上限重试
      try {
        return await httpRequest(
          {
            url: processed.endpoint,
            method: 'POST',
            headers: provider.resolveHeaders(cfg),
            body: processed.body,
            stream,
            signal,
          },
          this.logger,
        );
      } catch (err) {
        const is413 = err instanceof LLMError && err.status === 413;
        if (!is413 || retry >= MAX_413_RETRIES) throw err;
        const nextCap = Math.max(MIN_MAX_REQUEST_BYTES, Math.floor(cap / 2));
        if (nextCap >= cap) throw err; // 已到下限，无法再收紧
        this.logger.warn(
          t('llm.http413Retry', { nextCap, attempt: retry + 1, maxRetries: MAX_413_RETRIES }),
          {
            model: cfg.model,
            provider: cfg.format,
            cap,
            nextCap,
            bytes: serializedBodyBytes(processed.body),
          },
        );
        cap = nextCap;
      }
    }
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

  /**
   * 读取请求体字节上限（config.context.maxRequestBytes）。
   * 配置缺失/非法时回退内置默认值（8 MiB）。
   */
  private resolveMaxRequestBytes(): number {
    try {
      const v = this.config.getAppConfig().context?.maxRequestBytes;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    } catch {
      // 配置不可用
    }
    return DEFAULT_MAX_REQUEST_BYTES;
  }
}
