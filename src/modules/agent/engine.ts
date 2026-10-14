// src/modules/agent/engine.ts
// Agent ReAct 循环引擎。

import { t } from '../../core/i18n';
import { flattenModels } from '../../core/provider-utils';
import { statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { buildTools } from './context';
import { SessionStore, type ContextFile, type Session, type ActiveSkill } from './session';
import { TaskStore, type TaskItem, type TaskGroup } from './task-store';
import { LiveDraftStore, type LiveDraft } from './live-draft';
import { computeHistorySlice, describeSlice } from './history-page';
import { LLMError, type UnifiedRequest, type UnifiedMessage } from '../llm/types';
import type {
  AgentMessage,
  AgentEngine,
  AgentEvent,
  AgentRunInput,
  AgentRunResult,
  ContextEngine,
  RunStats,
  TruncatePreview,
  TruncateResult,
  TruncateRestoreResult,
} from '../contracts';
import type { LLMRouter, ToolRegistry, MCPManager, FileHistoryService, FilesysService } from '../contracts';
import type { SafetyService } from '../contracts';
import type { PermissionMode } from '../safety/types';
import type { FileChangeEvent } from '../filesys/types';
import type { ConfigService, EventBus, Logger, ServiceRegistry, Environment, ApiConfig } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AskOutcome, AskPayload, ToolResult } from '../tools/types';
import type { SkillRegistry } from '../tools/shared/skill-registry';
import { readSessionTodoStore, getSessionTodoPath } from '../tools/todo/shared/store';
import { buildStaticSystemPrompt, buildRequestView, MAX_TURNS_NOTICE_MSG_NAME } from '../context/compiler';
import { DEFAULT_TOOL_PRUNING_CONFIG } from '../context/types';
import type { RulesEngineServiceImpl } from '../rules/service';
import type { HooksEngineServiceImpl } from '../hooks/service';
import type { MemoryEngineServiceImpl } from '../memory/service';

/** 规则引擎关注的文件访问类工具（recordFileAccess 触发源） */
const FILE_ACCESS_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep']);

/** 从工具参数提取文件路径（规则 paths 匹配输入） */
function extractToolPaths(toolName: string, args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') out.push(v);
  };
  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
      push(a.path);
      push(a.filePath);
      break;
    case 'glob':
    case 'grep':
      push(a.path);
      break;
    default:
      break;
  }
  return out;
}

/** ask 超时兜底上限（即使配置异常也不会让 Promise 永久悬挂） */
const ASK_TIMEOUT_CEILING_MS = 24 * 60 * 60 * 1000; // 24h

/** 存在性校验：绝对路径直接 stat；相对路径基于 base 解析。非普通文件（目录/丢失/不可访问）视为不存在 */
function fileExistsAsFile(p: string, base: string): boolean {
  try {
    const abs = isAbsolute(p) ? p : resolvePath(base, p);
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * 从消息数组挑选「最后一条真实用户消息」→「重新生成」的重跑起点。
 * 判据：role='user' 且未软删除、且 name 为空（排除 env-context / memory-l1 / active-rules /
 * max-turns-notice 等内部锚定消息——它们同样带 role='user' 但有 name）。纯函数，便于单测。
 */
export function pickLastUserMessage(
  messages: AgentMessage[],
): { timestamp: string; content: string; attachments?: string[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || m.deletedAt || m.name) continue;
    return {
      timestamp: m.timestamp ?? '',
      content: m.content,
      ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
    };
  }
  return null;
}

export class AgentEngineImpl implements AgentEngine {
  private readonly sessions: SessionStore;
  private readonly tasks: TaskStore;
  /** 流式草稿（刷新/重连后恢复半截回复 + offset 续接的持久化载体） */
  private readonly liveDraft: LiveDraftStore;
  private readonly services: ServiceRegistry;
  private readonly config: ConfigService;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly env: Environment;
  /** filesys 事件订阅取消函数（destroy 时调用） */
  private unsubFilesys: (() => void) | null = null;
  /** pending ask 调用：toolCallId -> { resolve, reject, timer?, sessionId, payload } */
  private readonly pendingAsks = new Map<string, {
    resolve: (outcome: AskOutcome) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
    sessionId: string;
    payload: AskPayload;
  }>();

  /** pending confirm 调用：toolCallId -> { resolve, reject, timer, sessionId, question, ruleSuggestion } */
  private readonly pendingConfirms = new Map<string, {
    resolve: (ok: boolean) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    sessionId: string;
    question: string;
    /** 「始终允许」规则建议（confirm-required 事件携带，前端卡片展示） */
    ruleSuggestion?: string;
  }>();

  constructor(deps: {
    services: ServiceRegistry;
    config: ConfigService;
    eventBus: EventBus;
    logger: Logger;
    env: Environment;
  }) {
    this.services = deps.services;
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.env = deps.env;
    // TaskStore 先建：SessionStore 路径解析依赖总管索引（task↔session 归属目录）。
    // 不注入时 resolveSessionDir 恒 null，非 default 组的 session 文件指向无法解析
    this.tasks = new TaskStore(deps.env, deps.logger);
    this.sessions = new SessionStore(deps.env, deps.logger, {
      resolveSessionDir: (sid) => this.tasks.getDirOf(sid),
    });
    this.liveDraft = new LiveDraftStore(deps.env, deps.logger);

    // 订阅 filesys 变更事件总线：file-created/edited/deleted/moved/terminal-changed 统一转 WS，
    // delete/move/copy 的路径进 contextFiles（修复旧版无任何通知的割裂）。
    // filesys 模块在 kernel 中先于 agent 注册（见 core/kernel.ts 模块顺序）。
    const filesys = deps.services.tryResolve<FilesysService>(ServiceNames.FILESYS);
    if (filesys) {
      this.unsubFilesys = filesys.onFileChange((e) => this.onFilesysChange(e));
    }
  }

  /** 释放资源（模块 destroy 时调用）：取消 filesys 事件订阅 + 强制刷盘脏 session（写盘降载兜底） */
  dispose(): void {
    if (this.unsubFilesys) {
      this.unsubFilesys();
      this.unsubFilesys = null;
    }
    this.sessions.dispose();
  }

  /** filesys 变更事件 → WS 推送 + contextFiles 轨迹 */
  private onFilesysChange(e: FileChangeEvent): void {
    if (!e.sessionId) return;
    const server = this.services.tryResolve<{
      sendToSession: (sid: string, msg: unknown) => void;
    }>(ServiceNames.SERVER_INSTANCE);
    if (!server) return;

    try {
      // 变更路径进 contextFiles（moved：旧路径记录迁移到新路径；delete/move/copy 首次纳入轨迹）
      const reason = e.source as ContextFile['reason'];
      if (reason === 'write' || reason === 'edit' || reason === 'delete' || reason === 'move' || reason === 'copy') {
        if (e.kind === 'moved' && e.destPath) {
          // move：旧路径记录（相对/绝对形态统一匹配）迁移到新路径，避免旧路径残留被误判为丢失
          this.sessions.migrateContextFilesForMove(e.sessionId, e.absPath, e.destPath);
        } else {
          this.sessions.addContextFile(e.sessionId, { path: e.destPath ?? e.absPath, reason });
        }
        const files = this.getContextFiles(e.sessionId);
        const totalTokens = this.sessions.estimateContextTokens(e.sessionId);
        const maxTokens = this.config.getAppConfig().agent.maxTokens * 4;
        server.sendToSession(e.sessionId, {
          type: 'context-updated',
          sessionId: e.sessionId,
          payload: { files, totalTokens, maxTokens },
        });
      }

      switch (e.kind) {
        case 'created':
          server.sendToSession(e.sessionId, {
            type: 'file-created', sessionId: e.sessionId,
            payload: { path: e.absPath, source: e.source },
          });
          break;
        case 'edited':
          server.sendToSession(e.sessionId, {
            type: 'file-edited', sessionId: e.sessionId,
            payload: { path: e.absPath, source: e.source },
          });
          break;
        case 'deleted':
          server.sendToSession(e.sessionId, {
            type: 'file-deleted', sessionId: e.sessionId,
            payload: { path: e.absPath, source: e.source },
          });
          break;
        case 'moved':
          server.sendToSession(e.sessionId, {
            type: 'file-moved', sessionId: e.sessionId,
            payload: { path: e.absPath, destPath: e.destPath, source: e.source },
          });
          break;
        case 'terminal-changed':
          server.sendToSession(e.sessionId, {
            type: 'terminal-changed', sessionId: e.sessionId,
            payload: { report: e.report },
          });
          break;
      }
    } catch (err) {
      this.logger.warn(t('agent.notifySideEffectsFailed'), {
        kind: e.kind,
        path: e.absPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { sessionId, userMessage, cwd, onEvent, signal } = input;
    const cfg = this.config.getAppConfig().agent;
    const model = input.model ?? cfg.defaultModel;

    this.logger.info(t('agent.runStart'), { sessionId, model });

    /**
     * 事件出口包装（offset 续传协议 + 流式草稿维护的唯一入口）：
     * - assistant-text / assistant-thinking / tool-call-delta 附加 messageId + offset/total，
     *   并把内容原地写入草稿（由 LiveDraftStore 节流落盘）→ 刷新/重连后可精确续接。
     * - 工具生命周期事件（start/executing/end）同步草稿中的工具卡片状态，强制落盘。
     * - 其余事件原样透传。
     */
    // 当前轮的流式身份（emit 闭包使用；循环内逐轮更新）。
    // 草稿缺失时用它重建，避免分片被静默丢弃——静默丢弃会让整轮文本对前端不可见，
    // 只在 run 结束的 catchUpTail 拉历史时才出现（用户症状「响应中很久才有内容」）。
    let currentTurnMessageId = '';
    let currentTurnIndex = 0;
    /**
     * 每轮流式分片账本：produced = provider 实际产出；emitted = 实际发出的分片。
     * 用途：一旦出现「前端只显示响应中、内容最后才整块出现」，可直接从日志判定
     * 是「后端没发出」（emitted < produced）还是「前端丢流」（emitted == produced 但前端无输出）。
     */
    const streamAccount = {
      produced: { text: 0, thinking: 0, toolArgs: 0 },
      emitted: { text: 0, thinking: 0, toolArgs: 0 },
      /** 草稿缺失后按本轮身份重建的次数（>0 说明发生了并发 clear/快照竞态） */
      draftRebuilt: 0,
      /** 无轮身份、只能退化裸分片的次数（异常窗口，>0 需排查） */
      bareFallback: 0,
    };
    const resetStreamAccount = (): void => {
      streamAccount.produced = { text: 0, thinking: 0, toolArgs: 0 };
      streamAccount.emitted = { text: 0, thinking: 0, toolArgs: 0 };
      streamAccount.draftRebuilt = 0;
      streamAccount.bareFallback = 0;
    };
    /** 取本轮草稿；缺失则重建（无轮身份时返回 null，由调用方退化为裸分片） */
    const draftFor = (sessionId: string): LiveDraft | null => {
      const existing = this.liveDraft.get(sessionId);
      if (existing) return existing;
      if (!currentTurnMessageId) {
        streamAccount.bareFallback++;
        return null;
      }
      streamAccount.draftRebuilt++;
      return this.liveDraft.begin(sessionId, currentTurnMessageId, input.runId, currentTurnIndex);
    };

    const emit = (event: AgentEvent): void => {
      switch (event.type) {
        case 'assistant-text': {
          streamAccount.emitted.text += event.text.length;
          const d = draftFor(event.sessionId);
          if (!d) {
            // 无轮身份（异常窗口）：退化为无 messageId/offset 的裸分片，前端按尾部追加兜底——
            // 宁可顺序略有风险，也不让整轮内容对用户不可见
            onEvent({
              type: 'assistant-text',
              sessionId: event.sessionId,
              text: event.text,
              ...(event.runId ? { runId: event.runId } : {}),
            });
            return;
          }
          const offset = d.contentLength;
          onEvent({
            type: 'assistant-text',
            sessionId: event.sessionId,
            text: event.text,
            ...(event.runId ? { runId: event.runId } : {}),
            messageId: d.messageId,
            offset,
            total: offset + event.text.length,
          });
          this.liveDraft.appendContent(event.sessionId, event.text);
          return;
        }
        case 'assistant-thinking': {
          streamAccount.emitted.thinking += event.text.length;
          const d = draftFor(event.sessionId);
          if (!d) {
            onEvent({
              type: 'assistant-thinking',
              sessionId: event.sessionId,
              text: event.text,
              ...(event.runId ? { runId: event.runId } : {}),
            });
            return;
          }
          const offset = d.thinkingLength;
          onEvent({
            type: 'assistant-thinking',
            sessionId: event.sessionId,
            text: event.text,
            ...(event.runId ? { runId: event.runId } : {}),
            messageId: d.messageId,
            offset,
            total: offset + event.text.length,
          });
          this.liveDraft.appendThinking(event.sessionId, event.text);
          return;
        }
        case 'tool-call-delta': {
          streamAccount.emitted.toolArgs += event.argumentsDelta.length;
          const d = draftFor(event.sessionId);
          if (!d) {
            onEvent({
              type: 'tool-call-delta',
              sessionId: event.sessionId,
              toolCallId: event.toolCallId,
              argumentsDelta: event.argumentsDelta,
              ...(event.runId ? { runId: event.runId } : {}),
            });
            return;
          }
          const offset = d.toolCalls.find((tc) => tc.id === event.toolCallId)?.arguments.length ?? 0;
          onEvent({
            type: 'tool-call-delta',
            sessionId: event.sessionId,
            toolCallId: event.toolCallId,
            argumentsDelta: event.argumentsDelta,
            ...(event.runId ? { runId: event.runId } : {}),
            messageId: d.messageId,
            offset,
            total: offset + event.argumentsDelta.length,
          });
          this.liveDraft.appendToolArguments(event.sessionId, event.toolCallId, event.argumentsDelta);
          return;
        }
        case 'tool-call-start': {
          const d = this.liveDraft.get(event.sessionId);
          this.liveDraft.upsertToolCall(event.sessionId, {
            id: event.toolCallId,
            name: event.toolName,
            arguments: '',
            status: 'generating',
          });
          onEvent({ ...event, ...(d ? { messageId: d.messageId } : {}) });
          return;
        }
        case 'tool-call-executing': {
          const d = this.liveDraft.get(event.sessionId);
          this.liveDraft.setToolCallStatus(event.sessionId, event.toolCallId, 'executing');
          onEvent({ ...event, ...(d ? { messageId: d.messageId } : {}) });
          return;
        }
        case 'tool-call-end': {
          const d = this.liveDraft.get(event.sessionId);
          this.liveDraft.setToolCallStatus(event.sessionId, event.toolCallId, 'done');
          onEvent({ ...event, ...(d ? { messageId: d.messageId } : {}) });
          return;
        }
        default:
          onEvent(event);
      }
    };

    // 解析依赖服务
    const llm = this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER);
    if (!llm) {
      const msg = 'LLM router not available';
      onEvent({ type: 'error', sessionId, message: msg });
      return {
        sessionId,
        finishReason: 'error',
        finalText: msg,
        history: [],
      };
    }

    const toolRegistry = this.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
    const mcpManager = this.services.tryResolve<MCPManager>(ServiceNames.MCP_MANAGER);

    // ===== 钩子事件：SessionStart + UserPromptSubmit（addUserMessage 前触发；UserPromptSubmit 可 deny） =====
    const hooksEngine = this.services.tryResolve<HooksEngineServiceImpl>(ServiceNames.HOOKS_ENGINE);
    if (hooksEngine) {
      try {
        await hooksEngine.dispatch('SessionStart', { sessionId, cwd });
      } catch (err) {
        this.logger.warn('agent: SessionStart hook failed (fail-open)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const promptDecision = await hooksEngine.dispatch('UserPromptSubmit', {
          sessionId,
          cwd,
          prompt: userMessage,
        });
        if (promptDecision.decision === 'deny') {
          const msg = `Blocked by hook: ${promptDecision.reason ?? 'prompt denied'}`;
          this.logger.info('agent: prompt blocked by hook', { sessionId, reason: promptDecision.reason });
          onEvent({ type: 'error', sessionId, message: msg });
          return {
            sessionId,
            finishReason: 'error',
            finalText: msg,
            history: [],
          };
        }
      } catch (err) {
        this.logger.warn('agent: UserPromptSubmit hook failed (fail-open)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 构建会话（系统提示词由 context 引擎构建/缓存；fallback 见 buildFallbackMessages）
    const apiCfg = this.config.getApiConfig();
    const modelDisplayName = resolveModelDisplayName(apiCfg, model);
    // 请求 max_tokens：模型输出窗口（设置中可配）优先，缺省回退全局 agent.maxTokens 兜底。
    // 旧实现无条件用 agent.maxTokens（默认 8192，且无 UI 可改），会覆盖模型声明的输出窗口；
    // 对开启思考的推理模型，思考 token 与回复 token 共用该预算 → 思考/回复被硬性截断
    // （finish_reason=length）。详见 .trae/documents/修复MOSS生成中途截断的严重bug.md
    const maxOutputTokens = resolveRequestMaxTokens(apiCfg, model, cfg.maxTokens);
    const session = this.sessions.getOrCreate(sessionId);
    // clientMessageId 随消息持久化：前端本地乐观副本与历史副本据此同身份去重
    this.sessions.addUserMessage(session, userMessage, input.attachments, input.clientMessageId);
    // messageId 由会话级单调序号生成（`<sessionId>#<msgSeq>`，每 turn 消耗一个，持久化在
    // session.msgSeq）—— 严格递增且不受 messages.length 波动（压缩折叠 / 撤回恢复 /
    // healDanglingToolCalls 都会中部 splice 使 length 回落，用 length 派生 id 会与历史已落盘的
    // id 相撞 → 前端流式分片 attach 到旧消息 / 原位覆盖 = 「新消息替换旧消息」错位）。
    // 取号在下方 turn 循环内逐轮进行（见 turnMessageId），保证 run 内与跨 run 均唯一。
    // 记录本次 run 的工作目录（上下文文件相对路径的存在性校验/归一化匹配基准）
    this.sessions.setLastCwd(session, cwd);
    // 活跃置顶：task.id 即 sessionId；无对应任务时静默返回 null
    this.tasks.touchTask(sessionId);

    // 上下文引擎（基础设施：每轮请求流水线 + 工具自愈）；不可用时降级 fallback
    const contextEngine = this.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
    contextEngine?.markBusy(sessionId);

    // 权限模式解析（副作用集中化）：前端显式传递 > 会话记忆 > 全局默认（config.safety.defaultMode）。
    // 变化时写入 session 持久化（刷新恢复，对齐 activeSkill 先例）。
    const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
    const permissionMode: PermissionMode =
      input.permissionMode ?? session.permissionMode ?? safety?.getDefaultMode() ?? 'ask';
    this.sessions.setPermissionMode(session, permissionMode);

    // 工具集（含 MCP 工具）
    let mcpTools: Array<{ server: string; name: string; description?: string; inputSchema?: unknown }> = [];
    try {
      mcpTools = mcpManager?.listTools() ?? [];
    } catch (err) {
      this.logger.warn(t('agent.listMcpToolsFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const tools = buildTools(toolRegistry, mcpTools);

    // ReAct 循环（maxTurns=0 表示不限制 → Infinity；while 条件与触顶判断天然兼容）
    let turn = 0;
    const maxTurns = cfg.maxTurns === 0 ? Infinity : cfg.maxTurns;
    let finalText = '';
    let finishReason: AgentRunResult['finishReason'] = 'stop';
    // 最后一轮自然结束标记：最后一轮恰好无工具调用时是正常完成，不应判为触顶
    let completedNaturally = false;

    // 会话级累计统计：以 session.lastRunStats 为种子跨 run 累加（刷新/重启后继续累计；
    // 轮/工具结束与 done 时推送 stats-updated）
    const prevStats = session.lastRunStats;
    const stats: RunStats = prevStats
      ? { ...prevStats, runId: input.runId, runTurns: 0 }
      : {
          runId: input.runId,
          turns: 0,
          runTurns: 0,
          steps: 0,
          llmMs: 0,
          toolMs: 0,
          ttftCount: 0,
          ttftMsTotal: 0,
          decodeMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        };
    const pushStats = () => onEvent({ type: 'stats-updated', sessionId, stats: { ...stats } });

    while (turn < maxTurns) {
      if (signal?.aborted) {
        finishReason = 'aborted';
        break;
      }
      turn++;

      // 逐轮重建流式草稿：messageId = `<sessionId>#<msgSeq>`，每 turn 消耗一个会话级序号。
      // 逐轮取号（而非「run 基数 + turn」）保证同一会话内所有 run、所有 turn 的 id 严格单调
      // 唯一 —— 旧方案每 run 只 +1，跨 run 时 base+turn 区间重叠：上一条消息若触发过工具调用
      // （多 turn），下一条消息会复用其 messageId，前端按 id 去重即把新回复的流式分片全部当作
      // 「重复分片」丢弃（前端无输出、「响应中」永挂，后端却正常跑的根因）。
      // 每个 messageId 拥有独立 offset 空间，前端据此判定「是否同一轮」并精确续接。
      // turnMessageId 轮内快照：落盘时一律用它（而非回读 liveDraft —— 打断竞态下新 run
      // 的 begin() 可能已替换草稿，回读会让旧 run 的半截消息写上新 run 的身份 → 重复 id）。
      const turnMessageId = `${sessionId}#${this.sessions.nextMsgSeq(session)}`;
      this.liveDraft.begin(sessionId, turnMessageId, input.runId, turn);
      // 同步给 emit 闭包：草稿若被并发 clear，用该身份重建而不是丢弃分片
      currentTurnMessageId = turnMessageId;
      currentTurnIndex = turn;
      resetStreamAccount();

      // 构建请求：context 引擎每轮流水线（env 保障 → 压缩决策 → 缓存对齐视图）
      // 服务不可用/异常时降级为纯函数 fallback（静态提示 + 视图构建，无压缩）
      let messages: UnifiedMessage[];
      if (contextEngine) {
        try {
          const prepared = await contextEngine.prepareRequest(session, {
            cwd,
            model,
            modelDisplayName,
          });
          messages = prepared.messages;
          if (prepared.degradedReason) {
            this.logger.warn('agent: context engine degraded', {
              sessionId,
              reason: prepared.degradedReason,
            });
          }
        } catch (err) {
          this.logger.warn('agent: context engine prepareRequest failed, using fallback', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          messages = this.buildFallbackMessages(session, cwd, model, modelDisplayName);
        }
      } else {
        messages = this.buildFallbackMessages(session, cwd, model, modelDisplayName);
      }

      // 最后一轮收尾提醒：有限轮数模式下，本轮是最后一个允许的轮次时注入 user 提醒
      // （仅本次请求视图、不持久化），让 LLM 主动总结进展而非被拦腰截断
      if (maxTurns !== Infinity && turn === maxTurns) {
        messages = [...messages, { role: 'user', content: t('agent.finalTurnReminder') }];
      }

      const req: UnifiedRequest = {
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        max_tokens: maxOutputTokens,
        toolChoice: 'auto',
      };

      // 流式调用 LLM
      let assistantText = '';
      let assistantThinking = '';
      const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();
      // 本轮计时与 usage（usage 各字段在流内单调不减，按字段取 max 合并以兼容
      // Anthropic 流式拆分 message_start/message_delta、Gemini 累积值）
      const turnStart = performance.now();
      let ttftMs = -1;
      let turnUsage = { prompt: 0, completion: 0, cached: 0 };
      // 思考计时：首个 thinking 分片 → 首个非思考内容分片（text/tool_call）；未捕获到结束时间则用当前时间兜底
      let thinkingStartMs = -1;
      let thinkingEndMs = -1;
      const computeThinkingMs = (): number | undefined =>
        thinkingStartMs >= 0
          ? Math.max(0, Math.round((thinkingEndMs >= 0 ? thinkingEndMs : performance.now()) - thinkingStartMs))
          : undefined;

      try {
        for await (const delta of llm.stream(req, signal)) {
          if (signal?.aborted) break;

          // TTFT：首个内容型 delta（text/thinking/tool_call）
          if (ttftMs < 0 && (delta.type === 'text' || delta.type === 'thinking' || delta.type === 'tool_call')) {
            ttftMs = performance.now() - turnStart;
          }

          switch (delta.type) {
            case 'text':
              // 首个非思考内容分片：思考阶段结束
              if (thinkingStartMs >= 0 && thinkingEndMs < 0) thinkingEndMs = performance.now();
              assistantText += delta.text;
              streamAccount.produced.text += delta.text.length;
              emit({ type: 'assistant-text', sessionId, text: delta.text });
              break;
            case 'thinking':
              if (thinkingStartMs < 0) thinkingStartMs = performance.now();
              assistantThinking += delta.text;
              streamAccount.produced.thinking += delta.text.length;
              emit({ type: 'assistant-thinking', sessionId, text: delta.text });
              break;
            case 'tool_call': {
              // 首个工具调用分片：思考阶段结束
              if (thinkingStartMs >= 0 && thinkingEndMs < 0) thinkingEndMs = performance.now();
              const wasNew = !toolCallAccumulators.has(delta.index);
              const existing = toolCallAccumulators.get(delta.index) ?? {
                id: delta.toolCallId,
                name: delta.name,
                args: '',
              };
              if (delta.toolCallId) existing.id = delta.toolCallId;
              if (delta.name) existing.name = delta.name;
              existing.args += delta.argumentsDelta;
              streamAccount.produced.toolArgs += (delta.argumentsDelta ?? '').length;
              toolCallAccumulators.set(delta.index, existing);

              // 首次收到该 index：推送 tool-call-start（LLM 开始生成工具调用）
              if (wasNew) {
                emit({
                  type: 'tool-call-start',
                  sessionId,
                  toolName: existing.name,
                  toolCallId: existing.id,
                  args: '',
                });
              }
              // 参数增量推送（toolCallId 已确定后才有意义）
              if (delta.argumentsDelta && existing.id) {
                emit({
                  type: 'tool-call-delta',
                  sessionId,
                  toolCallId: existing.id,
                  argumentsDelta: delta.argumentsDelta,
                });
              }
              break;
            }
            case 'finish':
              if (delta.finishReason === 'length') {
                finishReason = 'length';
              }
              break;
            case 'error':
              onEvent({ type: 'error', sessionId, message: delta.message });
              finishReason = 'error';
              break;
            case 'usage':
              turnUsage = {
                prompt: Math.max(turnUsage.prompt, delta.usage.prompt_tokens ?? 0),
                completion: Math.max(turnUsage.completion, delta.usage.completion_tokens ?? 0),
                cached: Math.max(turnUsage.cached, delta.usage.cached_tokens ?? 0),
              };
              break;
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          // 用户主动中断：不发 error 事件，静默退出
          finishReason = 'aborted';
          finalText = assistantText;
          if (finalText || assistantThinking) {
            this.sessions.addAssistantMessage(
              session,
              finalText,
              undefined,
              assistantThinking || undefined,
              turnMessageId,
              computeThinkingMs(),
            );
          }
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(t('agent.llmStreamFailed'), { error: msg, turn });
        // 稳定错误消息身份：与同轮正常 assistant 消息（`<sid>#<turn>`）区分。
        // 前端 WS 临时错误消息与持久化历史消息据此同 id → mergeHistory 原位 patch，
        // 实时与刷新后都只有一条错误卡片（根治「运行时两条、刷新后一条」）。
        const errorMessageId = `${turnMessageId}#error`;
        onEvent({ type: 'error', sessionId, message: msg, providerError: msg, messageId: errorMessageId });
        finishReason = 'error';
        // 把已收集的文本作为最终输出
        finalText = assistantText || `Error: ${msg}`;
        // 已有正文：保留为正常 assistant 消息（部分输出不丢失）；无正文：不伪造普通消息
        if (assistantText) {
          this.sessions.addAssistantMessage(
            session,
            assistantText,
            undefined,
            assistantThinking || undefined,
            turnMessageId,
            computeThinkingMs(),
          );
        }
        // 持久化「模型请求失败」错误消息：刷新后经历史恢复仍渲染为红色错误卡片。
        // （旧实现仅在流内落一条普通 assistant 消息，刷新后按普通正文渲染 → 丢失错误样式）
        this.sessions.addSystemErrorMessage(session, msg, { providerError: msg }, errorMessageId);
        break;
      } finally {
        // 轮统计（正常/中断/异常路径统一在此结算；finally 先于 break 生效）
        const elapsed = performance.now() - turnStart;
        const ttft = ttftMs >= 0 ? ttftMs : elapsed;
        stats.turns++;
        stats.runTurns = turn;
        stats.llmMs += elapsed;
        stats.ttftCount++;
        stats.ttftMsTotal += ttft;
        stats.decodeMs += Math.max(0, elapsed - ttft);
        stats.inputTokens += turnUsage.prompt;
        stats.outputTokens += turnUsage.completion;
        stats.cachedTokens += turnUsage.cached;
        // 上下文引擎 usage 上报（缓存命中采样 + tokPerChar 校准 + 最近一次真实 usage + WS 推送）
        if (turnUsage.prompt > 0) {
          contextEngine?.onTurnUsage(sessionId, {
            promptTokens: turnUsage.prompt,
            cachedTokens: turnUsage.cached,
            completionTokens: turnUsage.completion,
          });
        }
        pushStats();

        // 每轮流式账本：produced 与 emitted 应当一致；不一致说明后端发不出去（草稿竞态/裸兜底），
        // 一致却前端无输出则说明前端丢流（对照前端 stream-account 日志定位）。
        // 降噪：不一致/有兜底 → warn；有思考产出（长思考是本症状主体）→ info；普通轮 → debug。
        const acct = {
          sessionId,
          turn,
          messageId: currentTurnMessageId,
          produced: streamAccount.produced,
          emitted: streamAccount.emitted,
          draftRebuilt: streamAccount.draftRebuilt,
          bareFallback: streamAccount.bareFallback,
          ttftMs: Math.round(ttft),
          turnMs: Math.round(elapsed),
          aborted: signal?.aborted === true,
        };
        const mismatched =
          streamAccount.produced.text !== streamAccount.emitted.text ||
          streamAccount.produced.thinking !== streamAccount.emitted.thinking ||
          streamAccount.produced.toolArgs !== streamAccount.emitted.toolArgs ||
          streamAccount.draftRebuilt > 0 ||
          streamAccount.bareFallback > 0;
        if (mismatched) {
          this.logger.warn('agent.turnStreamAccounting', acct);
        } else if (streamAccount.produced.thinking > 0) {
          this.logger.info('agent.turnStreamAccounting', acct);
        } else {
          this.logger.debug('agent.turnStreamAccounting', acct);
        }
      }

      if (signal?.aborted) {
        finishReason = 'aborted';
        break;
      }

      // 收集工具调用
      const toolCalls: AgentMessage['toolCalls'] = [];
      for (const [, acc] of toolCallAccumulators) {
        if (acc.name) {
          toolCalls.push({
            id: acc.id || `call_${turn}_${Math.random().toString(36).slice(2, 8)}`,
            name: acc.name,
            arguments: acc.args,
          });
        }
      }

      // 记录 assistant 消息
      this.sessions.addAssistantMessage(
        session,
        assistantText,
        toolCalls.length > 0 ? toolCalls : undefined,
        assistantThinking || undefined,
        turnMessageId,
        computeThinkingMs(),
      );

      // 无工具调用：本轮结束
      if (toolCalls.length === 0) {
        finalText = assistantText;
        if (finishReason !== 'length' && finishReason !== 'error') {
          finishReason = 'stop';
        }
        completedNaturally = true;
        break;
      }

      // 执行工具调用
      for (const tc of toolCalls) {
        if (signal?.aborted) {
          // abort 时补一个错误 tool 结果，保持 tool_calls 配对完整
          // 否则 assistant 消息已带 tool_calls 但缺少对应 tool 结果，session 复用时会触发 HTTP 400
          this.sessions.addToolMessage(
            this.sessions.get(sessionId)!,
            tc.id,
            'Error: aborted by user',
            tc.name,
            { isError: true },
          );
          finishReason = 'aborted';
          continue;
        }
        // 单工具失败隔离：executeToolCall 抛错时兜底补错误 tool_result，
        // 避免中断后续 tc 导致多个 tool_use 失去 tool_result（触发 HTTP 400）。
        const toolStart = performance.now();
        try {
          await this.executeToolCall(tc, {
            sessionId,
            cwd,
            toolCallId: tc.id,
            // 统一走 emit：工具生命周期事件同步草稿状态（刷新后工具卡片状态保真）
            onEvent: emit,
            signal,
            permissionMode,
          });
          // 工具执行完毕后检查 abort：这里**不能** break，
          // 否则尚未执行的 tc 会缺失 tool 结果，assistant.tool_calls 悬挂 → HTTP 400。
          // 改为 continue，让下一轮循环顶部为每个剩余 tc 统一补错误 tool 结果。
          if (signal?.aborted) {
            finishReason = 'aborted';
            continue;
          }
        } catch (err) {
          this.logger.error(t('agent.executeToolCallThrew'), {
            toolCallId: tc.id,
            toolName: tc.name,
            error: err instanceof Error ? err.message : String(err),
          });
          this.sessions.addToolMessage(
            this.sessions.get(sessionId)!,
            tc.id,
            `Error: ${err instanceof Error ? err.message : String(err)}`,
            tc.name,
            { isError: true },
          );
        } finally {
          stats.steps++;
          stats.toolMs += performance.now() - toolStart;
          pushStats();
        }
      }

      // 兜底自愈：确保本轮每个 tool_call_id 都有对应 tool 消息。
      // 正常路径下 executeToolCall 会为每个 tc 落一条 tool 结果，此处不会触发；
      // 但若未来新增异常路径漏写，这里会补齐缺失项并告警，从根上杜绝
      // 「assistant.tool_calls 后 tool 消息不足」导致的 HTTP 400。
      const persistedToolIds = new Set<string>();
      for (const m of this.sessions.get(sessionId)!.messages) {
        if (m.role === 'tool' && m.toolCallId) persistedToolIds.add(m.toolCallId);
      }
      const missingToolIds = toolCalls.filter(tc => !persistedToolIds.has(tc.id));
      if (missingToolIds.length > 0) {
        this.logger.warn('agent: detected dangling tool_calls, auto-appending error tool results', {
          sessionId,
          missing: missingToolIds.map(tc => tc.id),
        });
        for (const tc of missingToolIds) {
          this.sessions.addToolMessage(
            this.sessions.get(sessionId)!,
            tc.id,
            'Error: tool result missing (auto-repaired)',
            tc.name,
            { isError: true },
          );
        }
      }

      // 引导模式：所有工具调用完成后，检查是否有引导消息（准备进入思考前中止）
      if (input.guideMessages && input.guideMessages.length > 0 && !signal?.aborted) {
        const guide = input.guideMessages[0];
        try {
          this.sessions.setLastRunStats(session, stats);
          this.sessions.persistSession(session);
        } catch (err) {
          this.logger.warn(t('agent.persistRunStatsFailed'), {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        contextEngine?.markIdle(sessionId);
        this.cleanupPendingAsks();
        // 本轮流式草稿作废：最终消息已由 addAssistantMessage 落盘
        this.liveDraft.clear(sessionId);
        return {
          sessionId,
          finishReason: 'aborted',
          finalText: assistantText,
          history: session.messages,
          guideInterrupt: true,
          guideMessage: guide.message,
          guideAttachments: guide.attachments,
        };
      }

      if (finishReason === 'aborted') break;

      // 继续下一轮（让 LLM 看到工具结果后继续）
      finalText = assistantText;
    }

    // 触顶判定：轮数耗尽且非自然结束（最后一轮恰好完成）/错误/中断 → max_turns
    if (turn >= maxTurns && !completedNaturally && finishReason === 'stop') {
      this.logger.warn(t('agent.reachedMaxTurns', { maxTurns }), { sessionId });
      finishReason = 'max_turns';
      // 触顶提示消息持久化进 session（刷新后由 history 恢复渲染；view-builder 排除不发给 LLM）
      session.messages.push({
        role: 'user',
        name: MAX_TURNS_NOTICE_MSG_NAME,
        content: t('agent.maxTurnsNotice', { maxTurns }),
        metadata: { maxTurns },
        timestamp: new Date().toISOString(),
      });
    }

    // 持久化本次 run 统计（刷新后经 GET /api/session/:id 恢复指标栏）
    try {
      this.sessions.setLastRunStats(session, stats);
      this.sessions.persistSession(session);
    } catch (err) {
      this.logger.warn(t('agent.persistRunStatsFailed'), {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // run 结束：解除 busy（手动压缩恢复可用）
    contextEngine?.markIdle(sessionId);

    // ===== 钩子事件：Stop（通知型）+ 记忆蒸馏调度（finishReason=stop 时） =====
    if (finishReason === 'stop') {
      if (hooksEngine) {
        void hooksEngine
          .dispatch('Stop', { sessionId, cwd })
          .catch(err => {
            this.logger.warn('agent: Stop hook failed (fail-open)', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
      const memoryEngine = this.services.tryResolve<MemoryEngineServiceImpl>(ServiceNames.MEMORY_ENGINE);
      if (memoryEngine) {
        try {
          memoryEngine.scheduleDistill(session, cwd);
        } catch (err) {
          this.logger.warn('agent: schedule memory distillation failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 流式草稿作废：最终 assistant 消息已随各轮 addAssistantMessage 落盘，
    // 草稿只承载「进行中」的中间态（清掉后前端经 after 增量补齐正式消息）
    this.liveDraft.clear(sessionId);

    onEvent({ type: 'done', sessionId, finishReason });

    // 兜底清理未完成的 ask（正常流程下应已被 resolve/reject）
    this.cleanupPendingAsks();

    this.logger.info(t('agent.runComplete'), { sessionId, turn, finishReason });

    return {
      sessionId,
      finishReason,
      finalText,
      history: session.messages,
    };
  }

  // ========================================================================

  /** 列出所有会话（供 Server 路由调用） */
  listSessions(): Array<{ id: string; createdAt: string; updatedAt: string; messageCount: number }> {
    return this.sessions.list().map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
    }));
  }

  /** 获取会话历史（不含已撤回的软删除消息） */
  getHistory(sessionId: string): AgentMessage[] {
    return (this.sessions.get(sessionId)?.messages ?? []).filter(m => !m.deletedAt);
  }

  /**
   * 最近一条「真实用户消息」→「重新生成」的重跑起点。
   * 由服务端在**完整历史**上定位，避免前端只加载最后一页时找不到触发本轮回复的 user 消息。
   */
  getLastUserMessage(
    sessionId: string,
  ): { timestamp: string; content: string; attachments?: string[] } | null {
    return pickLastUserMessage(this.sessions.get(sessionId)?.messages ?? []);
  }

  /**
   * 会话历史分页视图：游标 = 「过滤软删除后的数组下标」。
   * 会话消息只在尾部追加，截断/恢复也只影响尾部 —— 头部下标天然稳定，
   * 因此 before/after 游标在分页、上滑加载、断线补齐下都不会错位。
   * 每条消息附带绝对 index，供前端生成稳定 id（分页后不漂移）。
   */
  getHistoryPage(
    sessionId: string,
    opts?: { limit?: number; before?: number; after?: number },
  ): {
    messages: Array<AgentMessage & { index: number }>;
    total: number;
    oldestIndex: number;
    newestIndex: number;
    hasMoreBefore: boolean;
  } {
    const all = this.getHistory(sessionId);
    const total = all.length;
    const { start, end } = computeHistorySlice(total, opts);
    const messages = all.slice(start, end).map((m, i) => ({ ...m, index: start + i }));
    return { messages, total, ...describeSlice(total, { start, end }) };
  }

  /** 进行中的流式草稿（刷新/重连后恢复半截回复；进程重启残留附 stale 标记） */
  getLiveDraft(sessionId: string): LiveDraft | null {
    return this.liveDraft.snapshot(sessionId);
  }

  /** 获取会话权限模式（供 GET /api/session/:id 与 /api/tasks/:id 刷新恢复前端徽章） */
  getPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.sessions.get(sessionId)?.permissionMode;
  }

  /** 获取会话当前激活的 skill 模式（供路由刷新恢复 Badge；内容运行时从注册表解析） */
  getActiveSkill(sessionId: string): ActiveSkill | undefined {
    return this.sessions.get(sessionId)?.activeSkill;
  }

  /** context 引擎会话桥：获取会话（Session 结构兼容 ContextSessionLike） */
  getSessionForContext(sessionId: string): Session | null {
    return this.sessions.get(sessionId);
  }

  /** context 引擎会话桥：持久化会话（压缩标记/摘要消息/压缩历史写入后调用） */
  persistSessionForContext(session: import('../context/types').ContextSessionLike): void {
    this.sessions.persistSession(session as Session);
  }

  /** 获取会话最近一次 run 统计（供 GET /api/session/:id 刷新恢复前端指标栏） */
  getLastRunStats(sessionId: string): RunStats | undefined {
    return this.sessions.get(sessionId)?.lastRunStats;
  }

  // ========================================================================
  // 消息撤回（截断）与恢复（redo）
  // ========================================================================

  previewTruncate(sessionId: string, messageTimestamp: string, content: string): TruncatePreview | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // 预览只读：不做任何物理清除（旧版在此 purge 软删除会破坏既有恢复窗口）
    const idx = this.sessions.locateUserMessage(session, messageTimestamp, content);
    if (idx === -1) return null;

    const messagesToRemove = session.messages.slice(idx)
      .filter(m => !m.deletedAt)
      .map((m, i) => ({
        index: idx + i,
        role: m.role,
        content: m.content.length > 120 ? `${m.content.slice(0, 120)}…` : m.content,
        ...(m.timestamp ? { timestamp: m.timestamp } : {}),
      }));

    // 文件回滚区间：目标消息 timestamp → 最后一条消息 timestamp（旧消息无 timestamp 时跳过回滚）
    const from = session.messages[idx]?.timestamp;
    let to: string | undefined;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].timestamp && !session.messages[i].deletedAt) {
        to = session.messages[i].timestamp;
        break;
      }
    }
    const fileChanges: TruncatePreview['fileChanges'] = [];
    // 跳过原因显式化（诚实降级）：file-history 不可用 / 旧消息无 timestamp 时
    // 不再静默跳过文件回滚，原因随结果返回供前端如实提示
    let rollbackSkippedReason: TruncatePreview['rollbackSkippedReason'];
    if (from && to) {
      const fh = this.resolveFileHistory();
      if (fh) {
        const fromMs = Date.parse(from);
        const toMs = Date.parse(to);
        for (const e of fh.listHistory(sessionId)) {
          // 跳过 R 条目与已回滚条目（已回滚的不会再被本次撤回影响）
          if (e.toolName === 'rollback' || e.rolledBackAt) continue;
          const ts = Date.parse(e.timestamp);
          if (Number.isNaN(ts) || ts < fromMs || ts > toMs) continue;
          fileChanges.push({ absPath: e.absPath, operation: e.operation, toolName: e.toolName, timestamp: e.timestamp });
        }
      } else {
        rollbackSkippedReason = 'no-file-history';
      }
    } else {
      rollbackSkippedReason = 'no-timestamp';
    }
    return { messagesToRemove, fileChanges, ...(rollbackSkippedReason ? { rollbackSkippedReason } : {}) };
  }

  async truncateFrom(
    sessionId: string,
    messageTimestamp: string,
    content: string,
    options?: { rollbackFiles?: boolean },
  ): Promise<TruncateResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // 栈式恢复窗口：不物理清除旧软删除（嵌套撤回语义——旧窗口保持可恢复），
    // 内层窗口已回滚的文件条目由 rollbackRange 的 rolledBackAt 过滤天然跳过。
    const idx = this.sessions.locateUserMessage(session, messageTimestamp, content);
    if (idx === -1) return null;
    const targetMsg = session.messages[idx];
    const truncatedBeforeTimestamp = targetMsg.timestamp ?? messageTimestamp;

    // 先做文件回滚（基于截断前完整区间），再做消息软删除
    const rollbackFailed: TruncateResult['rollbackFailed'] = [];
    let rollbackEntryIds: string[] = [];
    let fileRollbackPerformed = false;
    const from = targetMsg.timestamp;
    let to: string | undefined;
    for (let i = session.messages.length - 1; i >= idx; i--) {
      if (session.messages[i].timestamp) {
        to = session.messages[i].timestamp;
        break;
      }
    }
    // 跳过原因显式化（诚实降级）：不再静默跳过文件回滚
    let rollbackSkippedReason: TruncateResult['rollbackSkippedReason'];
    // rollbackFiles === false 时跳过文件回滚（仅软删除消息）。
    // 供「重新生成」使用：重跑该 user 消息不应把此前工具产生的文件变更回滚掉。
    const rollbackFiles = options?.rollbackFiles !== false;
    if (!rollbackFiles) {
      rollbackSkippedReason = 'skipped-by-caller';
    } else if (from && to) {
      const fh = this.resolveFileHistory();
      if (fh) {
        fileRollbackPerformed = true;
        try {
          const rb = await fh.rollbackRange(sessionId, from, to);
          rollbackEntryIds = rb.rollbackIds;
          rollbackFailed.push(...rb.failed);
        } catch (err) {
          rollbackFailed.push({
            absPath: '',
            error: `rollbackRange threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else {
        rollbackSkippedReason = 'no-file-history';
      }
    } else {
      rollbackSkippedReason = 'no-timestamp';
    }

    // 消息软删除
    const removedCount = this.sessions.truncateFrom(session, idx);

    // 记录撤回窗口（push 栈；redo 用）
    if (!session.lastTruncations) session.lastTruncations = [];
    session.lastTruncations.push({
      truncatedBeforeTimestamp,
      rollbackEntryIds,
    });
    // 直接落盘（saveSession 是私有方法，通过再次触发软删除持久化路径覆盖）
    this.sessions.persistSession(session);

    // 通知前端
    const server = this.services.tryResolve<{ sendToSession: (sid: string, msg: unknown) => void }>(ServiceNames.SERVER_INSTANCE);
    server?.sendToSession(sessionId, {
      type: 'session-truncated',
      sessionId,
      payload: {
        messageTimestamp: truncatedBeforeTimestamp,
        removedCount,
      },
    });

    this.logger.info('agent: session truncated', {
      sessionId,
      removedCount,
      rollbackEntries: rollbackEntryIds.length,
      rollbackFailed: rollbackFailed.length,
    });

    return {
      removedCount,
      rolledBackFiles: Math.max(rollbackEntryIds.length - rollbackFailed.length, 0),
      rollbackFailed,
      truncatedBeforeTimestamp,
      fileRollbackPerformed,
      ...(rollbackSkippedReason ? { rollbackSkippedReason } : {}),
    };
  }

  async restoreTruncate(sessionId: string): Promise<TruncateRestoreResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // 栈顶窗口（最近一次撤回）；无窗口表示无可恢复
    const info = session.lastTruncations?.[session.lastTruncations.length - 1];
    if (!info) return null;

    // 先恢复文件（redo rollback），再恢复消息
    const restoreFailed: TruncateRestoreResult['restoreFailed'] = [];
    let restoredFiles = 0;
    if (info.rollbackEntryIds.length > 0) {
      const fh = this.resolveFileHistory();
      if (fh) {
        try {
          const rr = await fh.redoRollback(sessionId, info.rollbackEntryIds);
          restoreFailed.push(...rr.failed);
          restoredFiles = info.rollbackEntryIds.length - rr.failed.length;
        } catch (err) {
          restoreFailed.push({
            absPath: '',
            error: `redoRollback threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    // pop 窗口 + 仅恢复该窗口区间内的消息（更早窗口保持撤回状态）
    session.lastTruncations!.pop();
    const restoredCount = this.sessions.restoreTruncatedWindow(session, info.truncatedBeforeTimestamp);

    const server = this.services.tryResolve<{ sendToSession: (sid: string, msg: unknown) => void }>(ServiceNames.SERVER_INSTANCE);
    server?.sendToSession(sessionId, {
      type: 'session-restored',
      sessionId,
      payload: { restoredCount, restoredFiles },
    });

    this.logger.info('agent: session truncation restored', { sessionId, restoredCount, restoredFiles });

    return { restoredCount, restoredFiles, restoreFailed };
  }

  private resolveFileHistory(): FileHistoryService | null {
    return this.services.tryResolve<FileHistoryService>(ServiceNames.FILE_HISTORY);
  }

  /** 获取会话上下文文件轨迹（阶段5.1：供 session-context 路由回填；出口附加 missing 存在性标记） */
  getContextFiles(sessionId: string): ContextFile[] {
    const files = this.sessions.getContextFiles(sessionId);
    const base = this.sessions.get(sessionId)?.lastCwd ?? process.cwd();
    return files.map(f => ({ ...f, missing: !fileExistsAsFile(f.path, base) }));
  }

  /** 估算会话上下文文件累计 token 数（阶段5.1：供 session-context 路由回填） */
  estimateContextTokens(sessionId: string): number {
    return this.sessions.estimateContextTokens(sessionId);
  }

  /** 删除会话 */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // ========================================================================
  // 任务管理（供 Server 路由调用）
  // ========================================================================

  listTasks(): TaskItem[] {
    return this.tasks.listTasks();
  }

  getTask(id: string): TaskItem | null {
    return this.tasks.getTask(id);
  }

  createTask(title: string, groupId?: string, id?: string): TaskItem {
    return this.tasks.createTask(title, groupId, id);
  }

  updateTask(id: string, patch: { title?: string; groupId?: string }): TaskItem | null {
    return this.tasks.updateTask(id, patch);
  }

  deleteTask(id: string): boolean {
    return this.tasks.deleteTask(id);
  }

  /** 按给定 id 顺序重排任务 order（分组内排序持久化） */
  reorderTasks(taskIds: string[]): boolean {
    return this.tasks.reorderTasks(taskIds);
  }

  listTaskGroups(): TaskGroup[] {
    return this.tasks.listGroups();
  }

  createTaskGroup(
    name: string,
    source?: 'folder' | 'manual',
    opts?: { id?: string; dir?: string; hidden?: boolean },
  ): TaskGroup {
    return this.tasks.createGroup(name, source, opts);
  }

  updateTaskGroup(id: string, patch: { name?: string }): TaskGroup | null {
    return this.tasks.updateGroup(id, patch);
  }

  deleteTaskGroup(id: string, opts?: { moveTasksTo?: string; deleteTasks?: boolean }): boolean {
    // 连任务一起删：先逐个删除 session 文件（文件路径依赖任务总管 index 定位，
    // 必须先于 deleteGroup 清索引执行），再删除分组定义与整组目录
    if (opts?.deleteTasks) {
      for (const tk of this.tasks.listTasks().filter(item => item.groupId === id)) {
        this.deleteSession(tk.id);
      }
    }
    return this.tasks.deleteGroup(id, opts);
  }

  /** 搜索任务标题 + 会话消息内容 */
  searchAll(query: string): {
    tasks: TaskItem[];
    messages: Array<{ sessionId: string; messageId: string; text: string }>;
  } {
    const tasks = this.tasks.searchTasks(query);
    const q = query.toLowerCase();
    const messages: Array<{ sessionId: string; messageId: string; text: string }> = [];
    for (const session of this.sessions.list()) {
      for (const msg of session.messages) {
        if (msg.deletedAt) continue;
        if (msg.role === 'user' || msg.role === 'assistant') {
          if (msg.content.toLowerCase().includes(q)) {
            messages.push({
              sessionId: session.id,
              messageId: `${session.id}-${session.messages.indexOf(msg)}`,
              text: msg.content.slice(0, 200),
            });
          }
        }
      }
    }
    return { tasks, messages };
  }

  // ========================================================================

  private async executeToolCall(
    tc: NonNullable<AgentMessage['toolCalls']>[number],
    ctx: {
      sessionId: string;
      cwd: string;
      toolCallId: string;
      onEvent: (event: AgentEvent) => void;
      signal?: AbortSignal;
      permissionMode: PermissionMode;
    },
  ): Promise<void> {
    const { sessionId, cwd, toolCallId, onEvent, signal } = ctx;

    // 工具执行前再次检查 abort（防止在工具队列等待期间被 abort）
    if (signal?.aborted) {
      this.sessions.addToolMessage(
        this.sessions.get(sessionId)!,
        toolCallId,
        'Error: aborted by user',
        tc.name,
        { isError: true },
      );
      return;
    }

    onEvent({
      type: 'tool-call-executing',
      sessionId,
      toolName: tc.name,
      toolCallId,
    });

    // 参数解析 + 自愈（context 引擎：JSON 修复/工具名纠正/schema 修正）
    // 服务不可用时回退旧行为（静默 {}）；修复失败回传结构化错误让模型自纠
    let args: unknown = {};
    let healedName = tc.name;
    let healLogText = '';
    const contextEngine = this.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
    if (contextEngine) {
      const heal = contextEngine.healToolCall(tc.name, tc.arguments || '');
      healedName = heal.toolName;
      args = heal.args;
      if (!heal.executable) {
        // 修复失败：结构化错误回传（含修复尝试与正确用法），模型下轮自纠
        const errorText = heal.errorText ?? `Error: tool call "${tc.name}" could not be repaired`;
        this.sessions.addToolMessage(
          this.sessions.get(sessionId)!,
          toolCallId,
          errorText,
          healedName,
          { isError: true },
        );
        onEvent({
          type: 'tool-call-end',
          sessionId,
          toolName: healedName,
          toolCallId,
          result: { content: [{ type: 'text', text: errorText }], isError: true },
        });
        this.notifyHealed(sessionId, toolCallId, heal.healLog);
        return;
      }
      if (heal.healLog.length > 0) {
        healLogText = `\n\n[自愈] ${heal.healLog.map(h => h.detail).join('; ')}`;
        this.notifyHealed(sessionId, toolCallId, heal.healLog);
      }
    } else {
      try {
        args = JSON.parse(tc.arguments || '{}');
      } catch {
        args = {};
      }
    }

    // ===== 钩子事件：PreToolUse（自愈后、执行前；deny → 补错误 tool 消息并中止此工具） =====
    const hooksEngine = this.services.tryResolve<HooksEngineServiceImpl>(ServiceNames.HOOKS_ENGINE);
    if (hooksEngine) {
      try {
        const pre = await hooksEngine.dispatch('PreToolUse', {
          sessionId,
          cwd,
          toolName: healedName,
          toolInput:
            args && typeof args === 'object'
              ? (args as Record<string, unknown>)
              : {},
        });
        if (pre.decision === 'deny') {
          const blockText = `Blocked by hook: ${pre.reason ?? 'tool call denied'}`;
          this.logger.info('agent: tool call blocked by hook', {
            sessionId,
            toolName: healedName,
            reason: pre.reason,
          });
          this.sessions.addToolMessage(
            this.sessions.get(sessionId)!,
            toolCallId,
            blockText,
            healedName,
            { isError: true },
          );
          onEvent({
            type: 'tool-call-end',
            sessionId,
            toolName: healedName,
            toolCallId,
            result: { content: [{ type: 'text', text: blockText }], isError: true },
          });
          return;
        }
      } catch (err) {
        this.logger.warn('agent: PreToolUse hook failed (fail-open)', {
          sessionId,
          toolName: healedName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 判断是否是 MCP 工具（mcp__server__tool 前缀；用自愈纠正后的名字）
    const mcpMatch = healedName.match(/^mcp__([^_]+)__(.+)$/);
    let result: ToolResult;
    try {
      if (mcpMatch) {
        result = await this.executeMcpTool(mcpMatch[1], mcpMatch[2], args, ctx);
      } else {
        result = await this.executeBuiltinTool(healedName, args, ctx);
      }
    } catch (err) {
      // 工具执行抛异常时，补一个错误 ToolResult，确保 addToolMessage 一定执行
      // 否则 assistant 消息已带 tool_calls 但缺少对应 tool 结果，session 复用时会触发 HTTP 400
      result = {
        content: [{ type: 'text', text: `Error executing tool ${healedName}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }

    // 记录工具结果到会话
    // resultText 计算包进 try/catch：运行时 content 数据异常（如 source 缺失）不应
    // 阻止 addToolMessage 执行，否则 assistant 的 tool_use 会缺少对应 tool_result，
    // session 复用时会触发 HTTP 400。
    let resultText: string;
    // 收集工具结果中的图片路径（仅落库路径，base64 不持久化；发送时由 view-builder 读盘编码）
    const imagePaths: string[] = [];
    try {
      resultText = result.content
        .map(c => {
          if (c.type === 'text') return c.text;
          if (c.path) imagePaths.push(c.path);
          return `[image: ${c.source?.mimeType ?? 'unknown'}]`;
        })
        .join('\n');
    } catch (err) {
      resultText = `Error: failed to serialize tool result: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.sessions.addToolMessage(
      this.sessions.get(sessionId)!,
      toolCallId,
      resultText + healLogText,
      healedName,
      {
        isError: result.isError,
        metadata: result.metadata,
        ...(imagePaths.length > 0 ? { images: imagePaths } : {}),
      },
    );

    onEvent({
      type: 'tool-call-end',
      sessionId,
      toolName: healedName,
      toolCallId,
      result: this.stripImagesForWs(result),
    });

    // 阶段5.1：工具执行副作用 WS 推送（todo-updated / context-updated / file-*）
    this.notifyToolSideEffects(healedName, args, sessionId, toolCallId);

    // ===== 钩子事件：PostToolUse（通知型 fire-and-forget；失败仅日志） =====
    if (hooksEngine) {
      void hooksEngine
        .dispatch('PostToolUse', {
          sessionId,
          cwd,
          toolName: healedName,
          toolInput:
            args && typeof args === 'object'
              ? (args as Record<string, unknown>)
              : {},
        })
        .catch(err => {
          this.logger.warn('agent: PostToolUse hook failed (fail-open)', {
            sessionId,
            toolName: healedName,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // ===== 规则引擎：文件访问登记（read/write/edit/glob/grep 成功后触发 paths 规则注入） =====
    if (FILE_ACCESS_TOOLS.has(healedName)) {
      try {
        const rulesEngine = this.services.tryResolve<RulesEngineServiceImpl>(ServiceNames.RULES_ENGINE);
        if (rulesEngine) {
          const paths = extractToolPaths(healedName, args);
          const session = this.sessions.get(sessionId);
          if (paths.length > 0 && session && rulesEngine.recordFileAccess(session, paths, cwd)) {
            this.sessions.persistSession(session);
          }
        }
      } catch (err) {
        this.logger.warn('agent: rules recordFileAccess failed', {
          sessionId,
          toolName: healedName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * WS 推送前剥离工具结果中的图片 base64：前端不渲染图片内容，避免大包经 WebSocket 传输。
   * 不影响会话落库的图片路径（发送给 LLM 时由 view-builder 按路径重新读盘编码）。
   */
  private stripImagesForWs(result: ToolResult): ToolResult {
    if (!result.content?.some(c => c.type === 'image')) return result;
    return {
      ...result,
      content: result.content.map(c =>
        c.type === 'image'
          ? {
              type: 'text' as const,
              text: `[image: ${c.source?.mimeType ?? 'unknown'}${c.path ? `, path=${c.path}` : ''}]`,
            }
          : c,
      ),
    };
  }

  /** 工具调用自愈 WS 通知（context-healed：修复明细推前端） */
  private notifyHealed(
    sessionId: string,
    toolCallId: string,
    healLog: Array<{ kind: string; detail: string }>,
  ): void {
    if (healLog.length === 0) return;
    const server = this.services.tryResolve<{
      sendToSession: (sid: string, msg: unknown) => void;
    }>(ServiceNames.SERVER_INSTANCE);
    try {
      server?.sendToSession(sessionId, {
        type: 'context-healed',
        sessionId,
        payload: { sessionId, toolCallId, healLog },
      });
    } catch {
      // WS 不可用：静默
    }
  }

  /**
   * 工具执行后的副作用 WS 推送（阶段5.1）：
   * - todo 工具：推送 todo-updated（会话级存储，读该 session 的文件）
   * - read/grep/glob：更新 contextFiles 轨迹并推送 context-updated（只读访问，非变更）
   * - write/edit/delete/move/copy 的 file-* 事件与 contextFiles 由 filesys 变更事件总线驱动
   *   （onFilesysChange，避免双发且天然覆盖 delete/move 等旧版无通知的工具）
   * server 模块未加载时静默跳过，不阻断工具执行。
   */
  private notifyToolSideEffects(toolName: string, args: unknown, sessionId: string, toolCallId: string): void {
    const server = this.services.tryResolve<{
      sendToSession: (sid: string, msg: unknown) => void;
    }>(ServiceNames.SERVER_INSTANCE);
    if (!server) return;

    try {
      switch (toolName) {
        case 'todo': {
          // 会话级存储：直接读该 session 的文件（天然隔离）
          const store = readSessionTodoStore(getSessionTodoPath(this.env, sessionId));
          const todos = store.items;
          // 持久化快照到 assistant 消息（刷新后可恢复）
          const session = this.sessions.get(sessionId);
          if (session) this.sessions.attachTodoSnapshot(session, toolCallId, todos);
          server.sendToSession(sessionId, {
            type: 'todo-updated',
            sessionId,
            payload: { todos, toolCallId },
          });
          break;
        }
        case 'read':
        case 'grep':
        case 'glob': {
          // 只读访问：仅更新 contextFiles 轨迹（file-* 事件由 filesys 变更事件总线驱动，见 onFilesysChange）
          const path = (args as { path?: string } | null)?.path;
          if (!path) break;
          const file: ContextFile = { path, reason: toolName as ContextFile['reason'] };
          this.sessions.addContextFile(sessionId, file);
          const files = this.getContextFiles(sessionId);
          const totalTokens = this.sessions.estimateContextTokens(sessionId);
          const maxTokens = this.config.getAppConfig().agent.maxTokens * 4;
          server.sendToSession(sessionId, {
            type: 'context-updated',
            sessionId,
            payload: { files, totalTokens, maxTokens },
          });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.logger.warn(t('agent.notifySideEffectsFailed'), {
        toolName,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async executeBuiltinTool(
    name: string,
    args: unknown,
    ctx: {
      sessionId: string;
      cwd: string;
      toolCallId: string;
      onEvent: (event: AgentEvent) => void;
      signal?: AbortSignal;
      permissionMode: PermissionMode;
    },
  ): Promise<ToolResult> {
    const toolRegistry = this.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
    if (!toolRegistry) {
      return {
        content: [{ type: 'text', text: 'Error: tool registry not available' }],
        isError: true,
      };
    }

    // 统一权限决策（safety 模块）：所有 builtin 工具的唯一权限入口。
    // ALLOW/ASK(用户同意后)→ctx 带 permissionDecision（registry 跳过内部 requireConfirmation，避免二次弹窗）；
    // ASK→confirm 卡片（带规则建议）用户同意后执行；DENY→结构化错误（模型可感知原因）。
    const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
    let permissionDecision: 'allowed' | undefined;
    if (safety) {
      const tool = toolRegistry.get(name);
      const decision = safety.evaluate({
        toolName: name,
        params: args,
        annotations: tool?.annotations,
        mode: ctx.permissionMode,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        enabled: toolRegistry.isEnabled(name),
      });
      if (decision.action === 'deny') {
        await this.eventBus.emit('tool:after', {
          name, args, sessionId: ctx.sessionId,
          result: { content: [{ type: 'text', text: 'denied' }], isError: true },
        });
        return { content: [{ type: 'text', text: this.formatDenyReason(name, decision.reason) }], isError: true };
      }
      if (decision.action === 'ask') {
        const ruleSuggestion = safety.generateRuleSuggestion(name, args);
        const ok = await this.requestConfirm(ctx, name, args, ruleSuggestion);
        if (!ok) {
          return {
            content: [{ type: 'text', text: `Tool "${name}" canceled (user declined the permission prompt)` }],
            isError: true,
          };
        }
        // 用户已在 safety 弹窗确认，标记放行（registry 跳过自建 requireConfirmation，避免二次弹窗）
        permissionDecision = 'allowed';
      } else {
        permissionDecision = 'allowed';
      }
    }

    // tool:before hook
    await this.eventBus.emit('tool:before', { name, args, sessionId: ctx.sessionId });

    const result = await toolRegistry.execute(name, args, {
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      toolCallId: ctx.toolCallId,
      emit: (event) => {
        // 工具进度事件通过 AgentEvent 转发
        if (event.type === 'progress') {
          ctx.onEvent({
            type: 'tool-call-start',
            sessionId: ctx.sessionId,
            toolName: name,
            toolCallId: ctx.toolCallId,
            args: event.message,
          });
        } else if (event.type === 'confirm-required') {
          ctx.onEvent({
            type: 'confirm-required',
            sessionId: ctx.sessionId,
            toolCallId: ctx.toolCallId,
            toolName: name,
            question: event.message,
            details: event.details,
          });
        }
      },
      logger: this.logger,
      services: this.services,
      signal: ctx.signal,
      askUser: (payload: AskPayload) => {
        return new Promise<AskOutcome>((resolve, reject) => {
          // 超时从 config.tools.ask.timeoutMinutes 读取（0/缺省 = 永不超时），兜底上限 24h
          let timeoutMs = 0;
          try {
            const askCfg = (this.config.getAppConfig().tools as Record<string, Record<string, unknown>>)?.['ask'];
            const raw = askCfg?.timeoutMinutes;
            if (typeof raw === 'number' && raw > 0) timeoutMs = raw * 60 * 1000;
          } catch {
            // config 不可用：永不超时
          }
          const timer = timeoutMs > 0 ? setTimeout(() => {
            if (this.pendingAsks.delete(ctx.toolCallId)) {
              reject(new Error(`ask timeout after ${Math.round(timeoutMs / 60000)}min`));
              // 通知前端移除残留卡片
              ctx.onEvent({ type: 'ask-timeout', sessionId: ctx.sessionId, toolCallId: ctx.toolCallId });
            }
          }, Math.min(timeoutMs, ASK_TIMEOUT_CEILING_MS)) : null;
          this.pendingAsks.set(ctx.toolCallId, {
            resolve,
            reject,
            timer,
            sessionId: ctx.sessionId,
            payload,
          });
          // 中断时立即 reject
          if (ctx.signal) {
            ctx.signal.addEventListener(
              'abort',
              () => {
                const pending = this.pendingAsks.get(ctx.toolCallId);
                if (pending) {
                  if (pending.timer) clearTimeout(pending.timer);
                  this.pendingAsks.delete(ctx.toolCallId);
                  reject(new Error('aborted'));
                }
              },
              { once: true },
            );
          }
          ctx.onEvent({
            type: 'ask',
            sessionId: ctx.sessionId,
            toolCallId: ctx.toolCallId,
            question: payload.question,
            answerType: payload.answerType,
            options: payload.options,
            defaultAnswer: payload.defaultAnswer,
          });
        });
      },
      confirm: (question: string) => this.requestConfirm(ctx, name, args, undefined, question),
      permissionDecision,
    });

    // tool:after hook
    await this.eventBus.broadcast('tool:after', {
      name,
      args,
      sessionId: ctx.sessionId,
      result,
    });

    return result;
  }

  /** 前端回复 ask 提问（accept/cancel）。匹配到 pending 则 resolve 并返回 true。 */
  resolveAsk(toolCallId: string, outcome: AskOutcome): boolean {
    const pending = this.pendingAsks.get(toolCallId);
    if (!pending) return false;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingAsks.delete(toolCallId);
    pending.resolve(outcome);
    return true;
  }

  /** 列出某 session 的待答 ask（供 WS 重连恢复 pending asks，携带完整提问载荷）。 */
  getPendingAsks(sessionId: string): Array<{ toolCallId: string; sessionId: string; payload: AskPayload }> {
    const out: Array<{ toolCallId: string; sessionId: string; payload: AskPayload }> = [];
    for (const [toolCallId, pending] of this.pendingAsks) {
      if (pending.sessionId === sessionId) {
        out.push({ toolCallId, sessionId: pending.sessionId, payload: pending.payload });
      }
    }
    return out;
  }

  /**
   * 前端回复 confirm 确认。匹配到 pending 则 resolve 并返回 true。
   * @param remember 「始终允许」级别：session=写入会话规则（内存）；global=写入 config.safety.rules（持久+广播）
   */
  resolveConfirm(toolCallId: string, ok: boolean, remember?: 'session' | 'global'): boolean {
    const pending = this.pendingConfirms.get(toolCallId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingConfirms.delete(toolCallId);
    // 用户选择「始终允许」：按建议规则写入对应层级的 allow 列表
    if (ok && remember && pending.ruleSuggestion) {
      const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
      if (safety) {
        if (remember === 'session') {
          safety.addSessionRule(pending.sessionId, 'allow', pending.ruleSuggestion);
        } else {
          void safety.addGlobalRule('allow', pending.ruleSuggestion);
        }
      }
    }
    pending.resolve(ok);
    return true;
  }

  /** 列出某 session 的待确认 confirm（供 WS 重连恢复 pending confirms）。 */
  getPendingConfirms(sessionId: string): Array<{ toolCallId: string; sessionId: string; question: string; ruleSuggestion?: string }> {
    const out: Array<{ toolCallId: string; sessionId: string; question: string; ruleSuggestion?: string }> = [];
    for (const [toolCallId, pending] of this.pendingConfirms) {
      if (pending.sessionId === sessionId) {
        out.push({ toolCallId, sessionId: pending.sessionId, question: pending.question, ruleSuggestion: pending.ruleSuggestion });
      }
    }
    return out;
  }

  /**
   * 统一确认请求：注册 pendingConfirms + 推送 confirm-required 事件（带规则建议）+
   * 超时从 config.safety.confirmTimeoutMinutes 读取（0=永不，默认 5 分钟）。
   */
  private requestConfirm(
    ctx: {
      sessionId: string;
      toolCallId: string;
      onEvent: (event: AgentEvent) => void;
      signal?: AbortSignal;
    },
    toolName: string,
    details?: unknown,
    ruleSuggestion?: string,
    customQuestion?: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let timeoutMs = 5 * 60 * 1000;
      try {
        const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
        if (safety) {
          const minutes = safety.getConfirmTimeoutMinutes();
          timeoutMs = minutes === 0 ? 0 : Math.min(minutes * 60 * 1000, ASK_TIMEOUT_CEILING_MS);
        }
      } catch {
        // config 不可用：默认 5 分钟
      }
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(ctx.toolCallId);
        resolve(false);
      }, timeoutMs);
      const question = customQuestion ?? `Tool "${toolName}" requires confirmation (permission mode)`;
      this.pendingConfirms.set(ctx.toolCallId, {
        resolve,
        reject,
        timer,
        sessionId: ctx.sessionId,
        question,
        ruleSuggestion,
      });
      if (ctx.signal) {
        ctx.signal.addEventListener(
          'abort',
          () => {
            if (this.pendingConfirms.has(ctx.toolCallId)) {
              clearTimeout(timer);
              this.pendingConfirms.delete(ctx.toolCallId);
              reject(new Error('aborted'));
            }
          },
          { once: true },
        );
      }
      ctx.onEvent({
        type: 'confirm-required',
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        toolName,
        question,
        details,
        ruleSuggestion,
      });
    });
  }

  /** safety DENY 原因 → 模型可读文案（结构化原因，让模型感知为何被拒并调整策略） */
  private formatDenyReason(
    toolName: string,
    reason: { type: string; rule?: string; pattern?: string; mode?: string },
  ): string {
    switch (reason.type) {
      case 'disabled':
        return `Error: [safety] tool "${toolName}" is disabled`;
      case 'rule':
        return `Error: [safety] tool "${toolName}" blocked by deny rule: ${reason.rule}`;
      case 'dangerousCommand':
        return `Error: [safety] command blocked (dangerous operation: ${reason.pattern}). If truly needed, ask the user to run it manually.`;
      case 'cautionCommand':
        return `Error: [safety] command blocked (caution: ${reason.pattern}, policy=deny). If truly needed, ask the user to run it manually.`;
      case 'protectedPath':
        return `Error: [safety] target path is protected: ${reason.pattern}. Writes to this location are not allowed.`;
      case 'mossAccess':
        return `Error: [safety] access to ~/.moss is restricted: ${reason.pattern}. Only the agent/, mcps/, skills/ subdirectories are accessible; use the dedicated tools instead.`;
      default:
        return `Error: [safety] tool "${toolName}" denied (${reason.type})`;
    }
  }

  /** 清理所有未完成的 pending ask 与 confirm（run 结束时兜底）。 */
  private cleanupPendingAsks(): void {
    for (const [, pending] of this.pendingAsks) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('session ended'));
    }
    this.pendingAsks.clear();
    for (const [, pending] of this.pendingConfirms) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingConfirms.clear();
  }

  /** 从 skill 注册表解析当前 prompt 全文（skill 被删/禁用时返回 null，注入自然为空） */
  private resolveSkillPrompt(name: string): string | null {
    const registry = this.services.tryResolve<SkillRegistry>(ServiceNames.SKILL_REGISTRY);
    const skill = registry?.get(name);
    if (!registry || !skill || !registry.isEnabled(name)) return null;
    return skill.prompt;
  }

  /**
   * 降级 fallback：context 引擎服务不可用/异常时的最小拼接逻辑。
   * 复用 context/compiler 纯函数（静态提示 + 视图构建），不含压缩/遥测——
   * 保证主循环永不因基础设施故障而中断。
   */
  private buildFallbackMessages(
    session: Session,
    cwd: string,
    model: string,
    modelDisplayName: string,
  ): UnifiedMessage[] {
    const skillName =
      session.activeSkill?.mode === 'system' ? session.activeSkill.name : undefined;
    const skillPrompt = skillName ? this.resolveSkillPrompt(skillName) : null;
    const systemContent = buildStaticSystemPrompt(this.env, skillPrompt);
    const view = buildRequestView(session, systemContent, {
      toolPruning: DEFAULT_TOOL_PRUNING_CONFIG,
      resolveSkillPrompt: name => this.resolveSkillPrompt(name),
    });
    return view.messages;
  }

  /**
   * MCP 工具执行（mcp__server__tool 前缀路径）。
   * 与 executeBuiltinTool 对齐的权限链：
   *   1. server 启用检查（disabled / 未定义 → 拒绝）
   *   2. MCP 工具 annotations 透传：destructiveHint → 用户确认（pendingConfirms）
   *   3. tool:before / tool:after hook
   *   4. 超时保护（config.mcp.callTimeoutMs，默认 120s）
   *   5. elicitation 桥：MCP 服务器向用户请求输入 → ask 机制（answerType=form）
   * structured output 与 resource 完整数据放 metadata（前端可渲染）。
   */
  private async executeMcpTool(
    serverName: string,
    toolName: string,
    args: unknown,
    ctx: {
      sessionId: string;
      cwd: string;
      toolCallId: string;
      onEvent: (event: AgentEvent) => void;
      signal?: AbortSignal;
      permissionMode: PermissionMode;
    },
  ): Promise<ToolResult> {
    const mcpManager = this.services.tryResolve<MCPManager>(ServiceNames.MCP_MANAGER);
    if (!mcpManager) {
      return {
        content: [{ type: 'text', text: 'Error: MCP manager not available' }],
        isError: true,
      };
    }

    // 1. server 启用检查（null=未定义，false=禁用）
    if (mcpManager.isServerEnabled(serverName) !== true) {
      return {
        content: [{ type: 'text', text: `Error: MCP server "${serverName}" is disabled or not found` }],
        isError: true,
      };
    }

    const fullToolName = `mcp__${serverName}__${toolName}`;

    // 2. 统一权限决策（safety 模块）：MCP 工具与 builtin 同一决策管线（模式/规则/风险分级）
    const annotations = mcpManager.getToolAnnotations(serverName, toolName);
    const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
    if (safety) {
      const decision = safety.evaluate({
        toolName: fullToolName,
        params: args,
        mcpAnnotations: annotations ?? undefined,
        mode: ctx.permissionMode,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        enabled: true,
      });
      if (decision.action === 'deny') {
        return {
          content: [{ type: 'text', text: this.formatDenyReason(fullToolName, decision.reason) }],
          isError: true,
          metadata: { server: serverName, tool: toolName, denied: true },
        };
      }
      if (decision.action === 'ask') {
        const ok = await this.requestConfirm(
          ctx,
          fullToolName,
          args,
          fullToolName,
          t('agent.mcpDestructiveConfirm', { server: serverName, tool: toolName }),
        );
        if (!ok) {
          return {
            content: [{ type: 'text', text: 'Canceled: user declined the MCP tool call' }],
            isError: true,
            metadata: { server: serverName, tool: toolName, canceled: true },
          };
        }
      }
    } else if (annotations?.destructiveHint === true) {
      // safety 服务不可用时兜底（保守）：destructiveHint 仍需确认
      const ok = await this.requestConfirm(
        ctx,
        fullToolName,
        args,
        undefined,
        t('agent.mcpDestructiveConfirm', { server: serverName, tool: toolName }),
      );
      if (!ok) {
        return {
          content: [{ type: 'text', text: 'Canceled: user declined the destructive MCP tool call' }],
          isError: true,
          metadata: { server: serverName, tool: toolName, canceled: true },
        };
      }
    }

    // 3. tool:before hook
    await this.eventBus.emit('tool:before', {
      name: fullToolName,
      args,
      sessionId: ctx.sessionId,
    });

    // 4. elicitation 桥：MCP 服务器向用户请求输入 → ask 事件（answerType=form + JSON Schema）→ 前端 ElicitationCard
    const elicit = (req: { message: string; requestedSchema?: Record<string, unknown> }) => {
      const question = `[MCP:${serverName}] ${req.message}`;
      const formSchema =
        req.requestedSchema ??
        ({
          type: 'object',
          properties: { message: { type: 'string', description: req.message } },
          required: ['message'],
        } as Record<string, unknown>);
      return new Promise<{ action: 'accept'; content: Record<string, string | number | boolean> } | { action: 'decline' }>(
        (resolve, reject) => {
          // 超时与 ask 工具一致（config.tools.ask.timeoutMinutes；0=永不，兜底 24h ceiling）
          let askTimeoutMs = 0;
          try {
            const askCfg = (this.config.getAppConfig().tools as Record<string, Record<string, unknown>>)?.['ask'];
            const raw = askCfg?.timeoutMinutes;
            if (typeof raw === 'number' && raw > 0) askTimeoutMs = raw * 60 * 1000;
          } catch {
            // config 不可用：永不超时
          }
          const timer = askTimeoutMs > 0 ? setTimeout(() => {
            if (this.pendingAsks.delete(ctx.toolCallId)) {
              resolve({ action: 'decline' });
              ctx.onEvent({ type: 'ask-timeout', sessionId: ctx.sessionId, toolCallId: ctx.toolCallId });
            }
          }, Math.min(askTimeoutMs, ASK_TIMEOUT_CEILING_MS)) : null;
          this.pendingAsks.set(ctx.toolCallId, {
            resolve: outcome => {
              if (outcome.action === 'accept' && outcome.answer?.form) {
                resolve({ action: 'accept', content: outcome.answer.form });
              } else {
                resolve({ action: 'decline' });
              }
            },
            reject,
            timer,
            sessionId: ctx.sessionId,
            payload: { question, answerType: 'form', formSchema },
          });
          if (ctx.signal) {
            ctx.signal.addEventListener(
              'abort',
              () => {
                if (this.pendingAsks.has(ctx.toolCallId)) {
                  if (timer) clearTimeout(timer);
                  this.pendingAsks.delete(ctx.toolCallId);
                  reject(new Error('aborted'));
                }
              },
              { once: true },
            );
          }
          ctx.onEvent({
            type: 'ask',
            sessionId: ctx.sessionId,
            toolCallId: ctx.toolCallId,
            question,
            answerType: 'form',
            formSchema,
          });
        },
      );
    };

    // 5. 调用（超时保护：config.mcp.callTimeoutMs，默认 120s）
    const timeoutMs = this.config.getAppConfig().mcp?.callTimeoutMs ?? 120000;
    let result: Awaited<ReturnType<MCPManager['callTool']>>;
    try {
      result = await mcpManager.callTool(serverName, toolName, args, {
        timeoutMs,
        signal: ctx.signal,
        elicit,
      });
    } catch (err) {
      const errorResult: ToolResult = {
        content: [
          {
            type: 'text',
            text: `Error calling MCP tool ${serverName}/${toolName}: ${err instanceof Error ? err.message : err}`,
          },
        ],
        isError: true,
        metadata: { server: serverName, tool: toolName },
      };
      await this.eventBus.broadcast('tool:after', {
        name: fullToolName,
        args,
        sessionId: ctx.sessionId,
        result: errorResult,
      });
      return errorResult;
    }

    // resource 完整数据收集（metadata 供前端渲染引用卡片）
    const resources = result.content
      .filter((c): c is Extract<typeof c, { type: 'resource' }> => c.type === 'resource')
      .map(c => ({ uri: c.uri, mimeType: c.mimeType, text: c.text, blob: c.blob }));

    const toolResult: ToolResult = {
      content: result.content.map(c => {
        if (c.type === 'text') return { type: 'text' as const, text: c.text };
        if (c.type === 'image') {
          return { type: 'image' as const, source: { data: c.data, mimeType: c.mimeType } };
        }
        // resource：正文给可读摘要（优先 text 内容），完整数据在 metadata.resources
        const resText = c.text ?? `[resource: ${c.uri} (${c.mimeType ?? 'unknown'})]`;
        return { type: 'text' as const, text: resText };
      }),
      isError: result.isError,
      metadata: {
        server: serverName,
        tool: toolName,
        ...(result.structured !== undefined ? { structured: result.structured } : {}),
        ...(resources.length > 0 ? { resources } : {}),
      },
    };

    // tool:after hook
    await this.eventBus.broadcast('tool:after', {
      name: fullToolName,
      args,
      sessionId: ctx.sessionId,
      result: toolResult,
    });

    return toolResult;
  }
}

/**
 * 从 providers 扁平视图反查 model 的显示名（cfg.name）。
 * 先按 id 精确匹配，再按 model 字段（API 模型名）兜底；找不到返回 model 本身。
 */
function resolveModelDisplayName(apiConfig: ApiConfig, model: string): string {
  const models = flattenModels(apiConfig);
  const byId = models.find(m => m.id === model);
  if (byId) return byId.name;
  const byModel = models.find(m => m.model === model);
  if (byModel) return byModel.name;
  return model;
}

/**
 * 解析本次请求的 max_tokens：模型输出窗口（outputTokens，设置中可配）优先，
 * 缺省回退全局 agent.maxTokens 兜底。非法值（<=0 / 非有限数）一律回退，
 * 避免把 NaN/0 传给 API。
 *
 * 为什么模型优先：outputTokens 是模型维度、用户可在「模型编辑」中配置的真实输出能力，
 * 其类型注释即定义为「请求 max_tokens 默认值」；agent.maxTokens 是隐藏且前端无入口的全局值，
 * 应仅作兜底。否则推理模型的思考与回复会共用过小的全局预算而被截断。
 */
export function resolveRequestMaxTokens(
  apiConfig: ApiConfig,
  model: string,
  fallbackMaxTokens: number,
): number {
  const models = flattenModels(apiConfig);
  const cfg = models.find(m => m.id === model) ?? models.find(m => m.model === model);
  const out = cfg?.outputTokens;
  if (typeof out === 'number' && Number.isFinite(out) && out > 0) return out;
  return fallbackMaxTokens;
}
