// src/modules/agent/live-draft.ts
// 流式草稿存储：把「正在进行中的 assistant 回复」按会话持久化，
// 使前端刷新 / 断线重连后能恢复半截流式文本（含 thinking 与工具调用卡片），
// 并配合 offset 续传协议（messageId + offset）无重复无缺口地继续接流。
//
// 设计要点：
// - 独立目录 ~/.moss/live/<sessionId>.json：不放进 tasks/<dir>/，避免 SessionStore.loadAll
//   的目录扫描把它误认成会话文件（session.messages 因此保持纯净，无需改 context 引擎）。
// - 内存态为权威（routes / WS 快照读内存），磁盘只是「进程重启后的兜底」。
// - 写盘节流：默认 ≥500ms，且长度未变化不写；单条草稿越大间隔越长（防长文本高频写盘）。
// - 工具调用状态变更（低频且是刷新后卡片正确性的关键）强制立即写盘。

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonStore, safeSessionId, writeJsonStore } from '../filesys/store-io';
import type { Environment, Logger } from '../../core/types';

/** 流式中的工具调用状态（与前端 ToolCall.status 对齐） */
export type LiveDraftToolStatus = 'generating' | 'executing' | 'done';

export interface LiveDraftToolCall {
  id: string;
  name: string;
  arguments: string;
  status: LiveDraftToolStatus;
}

/** 会话级流式草稿（内存态 + 落盘结构） */
export interface LiveDraft {
  sessionId: string;
  /** 所属 run（前端用于事件隔离） */
  runId?: string;
  /**
   * 本轮流式 assistant 消息的稳定 id：`<sessionId>#<msgSeq>`（msgSeq = 会话级单调序号，
   * 每 turn 消耗一个，由 engine 逐轮传入）—— 同一会话内严格递增保证全局唯一（含跨 run），
   * 前端据此把「流式草稿」与「历史正式消息」对齐为同一实体；offset 以此为独立空间。
   */
  messageId: string;
  turnIndex: number;
  content: string;
  thinking: string;
  toolCalls: LiveDraftToolCall[];
  contentLength: number;
  thinkingLength: number;
  startedAt: string;
  updatedAt: string;
  /** 进程重启后从磁盘读到的残留草稿（无活跃 run）：前端渲染为「上次中断的回复」 */
  stale?: boolean;
}

/** 基础写盘间隔（ms） */
const BASE_INTERVAL_MS = 500;
/** 大草稿写盘间隔（ms）：超过阈值后降频，避免长文本高频序列化 */
const HEAVY_INTERVAL_MS = 2000;
/** 大草稿阈值（字符数） */
const HEAVY_CHARS = 256 * 1024;

export class LiveDraftStore {
  private readonly liveDir: string;
  private readonly logger: Logger;
  /** 内存权威态：sessionId → 草稿 */
  private readonly drafts = new Map<string, LiveDraft>();
  /** 每次写盘时间（节流基准） */
  private readonly lastWriteAt = new Map<string, number>();
  /** 上次写盘时的内容长度签名（长度未变化则跳过写盘） */
  private readonly lastWriteSig = new Map<string, string>();
  /** 从磁盘读取（进程重启残留）的会话集合：get 时附加 stale 标记 */
  private readonly staleIds = new Set<string>();

  constructor(env: Environment, logger: Logger) {
    this.liveDir = join(env.dataDir, 'live');
    this.logger = logger;
  }

  /** 开始新一轮的流式草稿（替换该会话的旧草稿：messageId 逐轮唯一，offset 空间独立） */
  begin(sessionId: string, messageId: string, runId?: string, turnIndex = 0): LiveDraft {
    const now = new Date().toISOString();
    const draft: LiveDraft = {
      sessionId,
      ...(runId ? { runId } : {}),
      messageId,
      turnIndex,
      content: '',
      thinking: '',
      toolCalls: [],
      contentLength: 0,
      thinkingLength: 0,
      startedAt: now,
      updatedAt: now,
    };
    this.drafts.set(sessionId, draft);
    this.staleIds.delete(sessionId);
    // 立即落盘一次：保证「turn 刚开始」这一瞬间刷新也能恢复出正确的 messageId
    this.persist(sessionId, true);
    return draft;
  }

  /** 原地追加正文（与引擎 assistantText 相同的字符串拼接成本，无额外拷贝） */
  appendContent(sessionId: string, text: string): void {
    const d = this.drafts.get(sessionId);
    if (!d || !text) return;
    d.content += text;
    d.contentLength += text.length;
    d.updatedAt = new Date().toISOString();
    this.persistIfDue(sessionId);
  }

  /** 原地追加思维链 */
  appendThinking(sessionId: string, text: string): void {
    const d = this.drafts.get(sessionId);
    if (!d || !text) return;
    d.thinking += text;
    d.thinkingLength += text.length;
    d.updatedAt = new Date().toISOString();
    this.persistIfDue(sessionId);
  }

  /** 追加工具参数分片（找不到该工具调用时忽略） */
  appendToolArguments(sessionId: string, toolCallId: string, delta: string): void {
    const d = this.drafts.get(sessionId);
    if (!d || !delta) return;
    const tc = d.toolCalls.find((t) => t.id === toolCallId);
    if (!tc) return;
    tc.arguments += delta;
    d.updatedAt = new Date().toISOString();
    this.persistIfDue(sessionId);
  }

  /** 新增/更新工具调用（工具生命周期事件，强制立即写盘） */
  upsertToolCall(sessionId: string, tc: LiveDraftToolCall): void {
    const d = this.drafts.get(sessionId);
    if (!d) return;
    const existing = d.toolCalls.find((t) => t.id === tc.id);
    if (existing) {
      existing.name = tc.name || existing.name;
      existing.status = tc.status;
      if (tc.arguments) existing.arguments = tc.arguments;
    } else {
      d.toolCalls.push({ ...tc });
    }
    d.updatedAt = new Date().toISOString();
    this.persist(sessionId, true);
  }

  /** 更新工具调用状态（工具生命周期事件，强制立即写盘） */
  setToolCallStatus(sessionId: string, toolCallId: string, status: LiveDraftToolStatus): void {
    const d = this.drafts.get(sessionId);
    if (!d) return;
    const tc = d.toolCalls.find((t) => t.id === toolCallId);
    if (!tc || tc.status === status) return;
    tc.status = status;
    d.updatedAt = new Date().toISOString();
    this.persist(sessionId, true);
  }

  /**
   * 内部热路径读取（每次流式分片都会调用）：内存优先，内存缺失时读磁盘并登记为 stale 来源。
   * 返回的是内存中的权威对象本身（不拷贝、不附加 stale 标记），调用方只读其 messageId/长度。
   */
  get(sessionId: string): LiveDraft | null {
    const inMemory = this.drafts.get(sessionId);
    if (inMemory) return inMemory;
    const onDisk = this.loadFromDisk(sessionId);
    if (!onDisk) return null;
    this.drafts.set(sessionId, onDisk);
    this.staleIds.add(sessionId);
    return onDisk;
  }

  /** 对外快照（路由 / WS 状态回复用）：内存态直接返回；进程重启残留附加 stale 标记 */
  snapshot(sessionId: string): LiveDraft | null {
    const d = this.get(sessionId);
    if (!d) return null;
    return this.staleIds.has(sessionId) ? { ...d, stale: true } : d;
  }

  /** 清除草稿（run 结束时调用：最终消息已由 addAssistantMessage 落盘） */
  clear(sessionId: string): void {
    this.drafts.delete(sessionId);
    this.staleIds.delete(sessionId);
    this.lastWriteAt.delete(sessionId);
    this.lastWriteSig.delete(sessionId);
    try {
      const p = this.filePath(sessionId);
      if (existsSync(p)) unlinkSync(p);
    } catch (err) {
      this.logger.warn('agent: live draft clear failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 列出磁盘残留草稿（无内存态 = 进程重启后遗留），供启动期清理/展示 */
  listStale(): LiveDraft[] {
    const out: LiveDraft[] = [];
    try {
      if (!existsSync(this.liveDir)) return out;
      for (const name of readdirSync(this.liveDir)) {
        if (!name.endsWith('.json')) continue;
        const sessionId = name.slice(0, -'.json'.length);
        if (this.drafts.has(sessionId)) continue;
        const d = this.loadFromDisk(sessionId);
        if (d) out.push({ ...d, stale: true });
      }
    } catch {
      // 目录不可读：视为无残留
    }
    return out;
  }

  // ------------------------------------------------------------------------

  private filePath(sessionId: string): string {
    return join(this.liveDir, `${safeSessionId(sessionId)}.json`);
  }

  private loadFromDisk(sessionId: string): LiveDraft | null {
    const parsed = readJsonStore<Partial<LiveDraft> | null>(this.filePath(sessionId), null, this.logger);
    if (!parsed || typeof parsed.messageId !== 'string') return null;
    return {
      sessionId,
      ...(typeof parsed.runId === 'string' ? { runId: parsed.runId } : {}),
      messageId: parsed.messageId,
      turnIndex: typeof parsed.turnIndex === 'number' ? parsed.turnIndex : 0,
      content: typeof parsed.content === 'string' ? parsed.content : '',
      thinking: typeof parsed.thinking === 'string' ? parsed.thinking : '',
      toolCalls: Array.isArray(parsed.toolCalls)
        ? parsed.toolCalls
            .filter((tc): tc is LiveDraftToolCall => !!tc && typeof tc.id === 'string')
            .map((tc) => ({
              id: tc.id,
              name: typeof tc.name === 'string' ? tc.name : '',
              arguments: typeof tc.arguments === 'string' ? tc.arguments : '',
              status: tc.status === 'executing' || tc.status === 'done' ? tc.status : 'generating',
            }))
        : [],
      contentLength: typeof parsed.contentLength === 'number' ? parsed.contentLength : (parsed.content?.length ?? 0),
      thinkingLength: typeof parsed.thinkingLength === 'number' ? parsed.thinkingLength : (parsed.thinking?.length ?? 0),
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  }

  /** 节流写盘：长度签名未变化则跳过；间隔随草稿体积增长 */
  private persistIfDue(sessionId: string): void {
    const d = this.drafts.get(sessionId);
    if (!d) return;
    const sig = `${d.contentLength}|${d.thinkingLength}|${d.toolCalls.length}`;
    if (this.lastWriteSig.get(sessionId) === sig) return;
    const last = this.lastWriteAt.get(sessionId) ?? 0;
    const size = d.content.length + d.thinking.length;
    const interval = size > HEAVY_CHARS ? HEAVY_INTERVAL_MS : BASE_INTERVAL_MS;
    if (Date.now() - last < interval) return;
    this.persist(sessionId, false);
  }

  private persist(sessionId: string, force: boolean): void {
    const d = this.drafts.get(sessionId);
    if (!d) return;
    if (!force) {
      const sig = `${d.contentLength}|${d.thinkingLength}|${d.toolCalls.length}`;
      if (this.lastWriteSig.get(sessionId) === sig) return;
    }
    try {
      writeJsonStore(this.filePath(sessionId), {
        sessionId: d.sessionId,
        ...(d.runId ? { runId: d.runId } : {}),
        messageId: d.messageId,
        turnIndex: d.turnIndex,
        content: d.content,
        thinking: d.thinking,
        toolCalls: d.toolCalls,
        contentLength: d.contentLength,
        thinkingLength: d.thinkingLength,
        startedAt: d.startedAt,
        updatedAt: d.updatedAt,
      }, { fsync: false });
      this.lastWriteAt.set(sessionId, Date.now());
      this.lastWriteSig.set(sessionId, `${d.contentLength}|${d.thinkingLength}|${d.toolCalls.length}`);
    } catch (err) {
      this.logger.warn('agent: live draft persist failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}