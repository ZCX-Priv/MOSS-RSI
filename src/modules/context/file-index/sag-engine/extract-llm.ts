// src/modules/context/file-index/sag-engine/extract-llm.ts
// 后台 LLM 语义抽取：批量处理规则 event 未覆盖语义的 chunk，
// 输出 JSON（每 chunk 一个 Event 摘要 + 实体列表），失败整批保留规则结果。
// 预算控制：每项目最多 llmMaxChunks 个；批次间 2s 节流；引擎停用即取消。

import type { LLMRouter } from '../../../contracts';
import type { UnifiedMessage } from '../../../llm/types';
import type { FileIndexRuntimeDeps, SagEngineConfig } from '../types';
import type { SagStore } from './store';
import { loadPromptFileOrNull } from '../../prompt-loader';

const BATCH_SIZE = 8;
const BATCH_INTERVAL_MS = 2000;
const MAX_CHUNK_CHARS = 6000;

interface LlmBatchItem {
  chunkId: number;
  content: string;
}

interface LlmBatchResult {
  index: number;
  summary: string;
  entities: string[];
}

export class SagLlmExtractor {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private extracted = 0;
  private busy = false;
  /** 抽取失败（LLM 输出无法解析）的 chunk：跳过避免无限重试（引擎重启后重新尝试一轮） */
  private failedChunks = new Set<number>();

  constructor(
    private readonly store: SagStore,
    private readonly config: SagEngineConfig,
    private readonly llm: LLMRouter | null,
    private readonly resolveModel: () => string,
    private readonly deps: FileIndexRuntimeDeps,
  ) {}

  /** 已抽取数（预算消耗） */
  get progress(): number {
    return this.extracted;
  }

  start(): void {
    if (!this.llm || this.config.llmMaxChunks <= 0) return;
    this.stopped = false;
    this.scheduleNext(500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped || this.busy) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.processBatch();
    }, delayMs);
  }

  private async processBatch(): Promise<void> {
    if (this.stopped || this.busy || !this.llm) return;
    this.busy = true;
    try {
      const remaining = this.config.llmMaxChunks - this.extracted;
      if (remaining <= 0) return; // 预算用尽

      const chunkIds = this.store
        .pendingLlmChunkIds(Math.min(BATCH_SIZE, remaining) + this.failedChunks.size)
        .filter(id => !this.failedChunks.has(id))
        .slice(0, Math.min(BATCH_SIZE, remaining));
      if (chunkIds.length === 0) return; // 队列清空，保持空闲轮询（低频）
      if (this.stopped) return;

      const items: LlmBatchItem[] = [];
      for (const id of chunkIds) {
        const content = this.store.chunkContent(id);
        if (!content) continue;
        items.push({ chunkId: id, content: content.slice(0, MAX_CHUNK_CHARS) });
      }
      if (items.length === 0) {
        this.scheduleNext(BATCH_INTERVAL_MS);
        return;
      }

      const results = await this.callLlm(items);
      if (results.length === 0) {
        // 整批解析失败：标记跳过（保留规则 event）
        for (const item of items) this.failedChunks.add(item.chunkId);
        this.scheduleNext(BATCH_INTERVAL_MS);
        return;
      }
      for (let i = 0; i < items.length; i++) {
        const r = results.find(x => x.index === i);
        if (!r || typeof r.summary !== 'string' || r.summary.trim() === '') {
          this.failedChunks.add(items[i].chunkId);
          continue;
        }
        const entities = (Array.isArray(r.entities) ? r.entities : [])
          .filter((e): e is string => typeof e === 'string' && e.trim().length >= 2 && e.trim().length <= 64)
          .slice(0, 12)
          .map(name => ({ name: name.trim(), type: 'concept' as const }));
        this.store.writeLlmEvent(items[i].chunkId, r.summary.trim(), entities);
        this.extracted++;
      }
      this.scheduleNext(BATCH_INTERVAL_MS);
    } catch (err) {
      this.deps.logger.warn('file-index SAG LLM 抽取批次失败（保留规则结果）', {
        err: err instanceof Error ? err.message : String(err),
      });
      this.scheduleNext(BATCH_INTERVAL_MS * 3); // 失败退避
    } finally {
      this.busy = false;
    }
  }

  private async callLlm(items: LlmBatchItem[]): Promise<LlmBatchResult[]> {
    if (!this.llm) throw new Error('llm router unavailable');
    // 抽取提示词从 agent/prompts/file-index/sag-extract.md 加载；缺失则跳过本批（保留规则结果，降级）
    const systemPrompt = loadPromptFileOrNull(this.deps.env, 'file-index/sag-extract.md');
    if (!systemPrompt) return [];
    const payload = items
      .map((item, i) => `【块 ${i}】\n${item.content}`)
      .join('\n\n========\n\n');
    const messages: UnifiedMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: payload },
    ];
    const response = await this.llm.complete({
      model: this.resolveModel(),
      messages,
      stream: false,
      max_tokens: 2048,
    });
    return parseLlmJson(response.content);
  }
}

/** 解析 LLM JSON 输出（容忍 markdown 代码围栏与前后杂文本） */
export function parseLlmJson(text: string): LlmBatchResult[] {
  const trimmed = text.trim();
  // 剥离 ```json ... ``` 围栏
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : trimmed;
  // 定位首个 [ 到最后一个 ] 的范围
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is LlmBatchResult =>
        typeof x === 'object' && x !== null &&
        typeof (x as LlmBatchResult).summary === 'string' &&
        Array.isArray((x as LlmBatchResult).entities ?? []),
    );
  } catch {
    return [];
  }
}
