// src/modules/agent/engine.ts
// Agent ReAct 循环引擎。

import { t } from '../../core/i18n';
import { flattenModels } from '../../core/provider-utils';
import { statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { totalmem } from 'node:os';
import { Semaphore } from '../../utils/semaphore';
import { buildTools } from './context';
import { SessionStore, type ContextFile, type Session, type ActiveSkill } from './session';
import { TaskStore, type TaskItem, type TaskGroup } from './task-store';
import { LiveDraftStore, type LiveDraft } from './live-draft';
import { computeHistorySlice, describeSlice } from './history-page';
import { searchHistoryDocs, type HistorySearchDoc } from './history-search';
import { LLMError, type UnifiedRequest, type UnifiedMessage } from '../llm/types';
import type {
  AgentMessage,
  AgentEngine,
  AgentEvent,
  AgentProfileLike,
  AgentRegistryLike,
  AgentRunInput,
  AgentRunResult,
  ConfirmSource,
  ContextEngine,
  HistorySearchInput,
  HistorySearchResult,
  RunStats,
  TruncatePreview,
  TruncateResult,
  TruncateRestoreResult,
} from '../contracts';
import type { AgentBus } from '../agent-bus/types';
import type { LLMRouter, ToolRegistry, MCPManager, FileHistoryService, FilesysService } from '../contracts';
import type { SafetyService } from '../contracts';
import type { PermissionMode, RiskClass, SafetyDecision } from '../safety/types';
import { classifyRisk } from '../safety/policy';
import { SafetyReviewer, type SafetyReviewResult } from '../safety/reviewer';
import type { FileChangeEvent } from '../filesys/types';
import type { ConfigService, EventBus, Logger, ServiceRegistry, Environment, ApiConfig } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AskOutcome, AskPayload, AskQuestion, ToolResult } from '../tools/types';
import { lightenToolResultForEvent } from '../server/routes/history-light';
import type { SkillRegistry } from '../tools/shared/skill-registry';
import { readSessionTodoStore, getSessionTodoPath } from '../tools/todo/shared/store';
import { buildStaticSystemPrompt, buildRequestView, MAX_TURNS_NOTICE_MSG_NAME } from '../context/compiler';
import type { PromptExtraSection } from '../context/compiler';
import { buildCodeModePromptExtras } from '../tools/run_code/sdk';
import { isPtcForbiddenTool } from '../tools/run_code/forbidden';
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

/** 子代理默认工具白名单（模板未显式声明 tools 时生效，防止子代理默认获得写权限） */
const SUBAGENT_READONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'todo',
  'ask',
  'skill',
  'memory',
  'context',
  'web',
  'browser',
  'computer',
  'agent',
  'agent_status',
  'agent_message',
];

/** 同一轮并发执行 subagent 工具调用的上限（防止一次性开过多 LLM 流造成资源压力） */
const MAX_CONCURRENT_SUBAGENT_RUNS = 4;

/** 是否为 agent 工具调用（一次性子代理委派） */
function isSubagentToolCall(tc: { name: string; arguments: string }): boolean {
  return tc.name === 'agent';
}

/** 工具调用上下文（预检与执行共用） */
interface ToolCallContext {
  sessionId: string;
  cwd: string;
  toolCallId: string;
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
  permissionMode: PermissionMode;
  /** 当前会话模型 id（自动审查继承主模型时使用） */
  model: string;
  /** 子代理的父会话 id（审查/确认事件的来源归属） */
  parentSessionId?: string;
}

/** 确认元信息（预检阶段收集，本轮统一注册，前端合并分页） */
interface ConfirmMetaInfo {
  toolName: string;
  details: unknown;
  ruleSuggestion?: string;
  question?: string;
}

/** 单工具预检结果 */
interface PreparedToolCall {
  tc: NonNullable<AgentMessage['toolCalls']>[number];
  healedName: string;
  args: unknown;
  healLogText: string;
  mcpMatch: RegExpMatchArray | null;
  outcome:
    | { kind: 'ready' }
    | { kind: 'denied'; text: string }
    | { kind: 'confirm'; meta: ConfirmMetaInfo; promise?: Promise<boolean> };
}

/** 并发执行（上限 limit），保持每个任务的错误隔离由调用方 runOne 负责 */
async function runWithLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

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
  /** 会话/任务磁盘索引就绪 promise（惰性启动；路由与 warmup 共用） */
  private readiness: Promise<void> | null = null;
  private readonly services: ServiceRegistry;
  private readonly config: ConfigService;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly env: Environment;
  /** filesys 事件订阅取消函数（destroy 时调用） */
  private unsubFilesys: (() => void) | null = null;
  /** pending ask 调用：复合键 sessionId+toolCallId -> { resolve, reject, timer?, sessionId, toolCallId, payload } */
  private readonly pendingAsks = new Map<string, {
    resolve: (outcome: AskOutcome) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
    sessionId: string;
    /** 原始 toolCallId（复合键后缀；对外恢复/回包必须用它，不能暴露复合键） */
    toolCallId: string;
    payload: AskPayload;
  }>();

  /** pending confirm 调用：复合键 sessionId+toolCallId -> { resolve, reject, timer, sessionId, toolCallId, question, ruleSuggestion } */
  private readonly pendingConfirms = new Map<string, {
    resolve: (ok: boolean) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    sessionId: string;
    /** 原始 toolCallId（复合键后缀；对外恢复/回包必须用它，不能暴露复合键） */
    toolCallId: string;
    question: string;
    /** 「始终允许」规则建议（confirm-required 事件携带，前端卡片展示） */
    ruleSuggestion?: string;
    /** 发起确认的工作目录（「始终允许(本项目)」写入 {cwd}/.moss/permissions.json） */
    cwd: string;
    /** 权限来源（主会话 / 子代理），前端中控岛据此区分同时发起的申请 */
    source: ConfirmSource;
  }>();

  /** 自动审查执行器（懒加载：首次需要 review 时解析 LLM 路由并构造） */
  private safetyReviewer: SafetyReviewer | null = null;

  /**
   * headless 会话集合（子代理 / 团队成员等无独立界面的会话）：
   * 权限确认会汇总到主会话中控岛（带来源）由用户应答；该标记主要用于拒绝文案与运行态判断。
   */
  private readonly headlessSessions = new Set<string>();

  /** 代码模式嵌套调用的本地序号（仅用于生成稳定、可读的嵌套 toolCallId） */
  private nestedCodeCallSeq = 0;

  /** 同时运行的 agent run 上限（低内存机器自适应，避免多会话并发把 1G 内存打爆） */
  private readonly runLimiter: Semaphore;

  /** 标记/取消 headless（子代理与团队成员由 orchestrator 在启动时标记） */
  markSessionHeadless(sessionId: string, headless: boolean): void {
    if (!sessionId) return;
    if (headless) this.headlessSessions.add(sessionId);
    else this.headlessSessions.delete(sessionId);
  }

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
    // 并发闸门：缺省按物理内存自适应（<2GB → 2；否则 4），并允许配置覆盖。
    // 1 核低内存机器上并行是时间切片，限制并发可避免多会话同时持有大上下文导致 OOM。
    {
      const agentCfg = deps.config.getAppConfig().agent;
      const memMb = totalmem() / (1024 * 1024);
      const autoLimit = memMb < 2048 ? 2 : 4;
      const configured = agentCfg.maxConcurrentRuns;
      const limit = typeof configured === 'number' && Number.isFinite(configured)
        ? Math.max(1, Math.min(8, Math.floor(configured)))
        : autoLimit;
      this.runLimiter = new Semaphore(limit);
    }
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

  /**
   * 等待会话/任务磁盘索引就绪。
   * 索引扫描在后台异步执行，不参与启动关键路径；列表类路由与 warmup 调用本方法。
   */
  whenReady(): Promise<void> {
    if (!this.readiness) {
      this.readiness = Promise.all([this.tasks.whenReady(), this.sessions.whenIndexed()]).then(() => undefined);
    }
    return this.readiness;
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
    // 全局并发闸门：超限的 run 排队等待（不阻塞事件循环），避免低配机器被并发会话拖垮
    const release = await this.runLimiter.acquire();
    const bus = this.services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS);
    try {
      const result = await this.runUnlocked(input);
      bus?.update(input.sessionId, {
        status:
          result.finishReason === 'aborted'
            ? 'aborted'
            : result.finishReason === 'error'
              ? 'failed'
              : 'completed',
        finishedAt: new Date().toISOString(),
        finishReason: result.finishReason,
      });
      return result;
    } catch (err) {
      bus?.update(input.sessionId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      release();
    }
  }

  /** run 的实际实现（由 run() 包一层并发闸门；内部逻辑保持原样） */
  private async runUnlocked(input: AgentRunInput): Promise<AgentRunResult> {
    const { sessionId, userMessage, cwd, onEvent, signal } = input;

    // 实时文件监控：run 期间（包括后台任务）注册工作目录，让外部/终端变更进入 file-history。
    // 前端打开任务时也会注册，同一 cwd 仅更新会话绑定（最近活动优先）。
    if (cwd) {
      const filesysSvc = this.services.tryResolve<FilesysService>(ServiceNames.FILESYS);
      if (filesysSvc) {
        void filesysSvc.watchDirectory(cwd, sessionId).catch((err) => {
          this.logger.warn('agent: watch directory failed', {
            cwd,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    const appCfg = this.config.getAppConfig();
    const cfg = appCfg.agent;
    // 思考回传（OpenAI 兼容 provider 消费；默认 false，按 DeepSeek 规范不回传 reasoning_content）
    const replayThinking = appCfg.context?.thinking?.replayOpenAICompat ?? false;
    // Agent 模板配置：子代理/自定义 Agent 的 systemPrompt / tools / model / maxTurns / maxTokens
    const agentRegistry = this.services.tryResolve<AgentRegistryLike>(ServiceNames.AGENT_REGISTRY);
    const agentProfile: AgentProfileLike | null = input.agentId
      ? agentRegistry?.get(input.agentId) ?? null
      : null;
    const model = input.model ?? agentProfile?.model ?? cfg.defaultModel;

    this.logger.info(t('agent.runStart'), {
      sessionId,
      model,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });

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
        case 'run-code-progress': {
          // 执行中即时透传；不写草稿（嵌套调用由最终 result.metadata 权威落库）
          const d = this.liveDraft.get(event.sessionId);
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
    const maxOutputTokens = resolveRequestMaxTokens(
      apiCfg,
      model,
      agentProfile?.maxTokens ?? cfg.maxTokens,
    );
    const session = this.sessions.getOrCreate(sessionId);
    // 多智能体总线：主代理/子代理统一注册（子代理由 runner 预注册并传 bus meta，upsert 保号）
    const bus = this.services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS);
    if (bus) {
      bus.register({
        sessionId,
        kind: input.bus?.kind ?? 'main',
        template: input.bus?.template ?? input.agentId,
        name: input.bus?.name ?? agentProfile?.name ?? '主智能体',
        task: input.bus?.taskSummary ?? userMessage,
        cwd,
        parentSessionId: input.bus?.parentSessionId,
        parentToolCallId: input.bus?.parentToolCallId,
        depth: input.bus?.depth ?? 0,
      });
    }
    // clientMessageId 随消息持久化：前端本地乐观副本与历史副本据此同身份去重。
    // IM / MCP / 自动化等外部 run 没有前端参与、不会传该字段 → 由引擎生成稳定身份，
    // 保证「实时 user-message 事件」与「刷新后的历史副本」按 id 原位归并（不重复渲染）。
    const userClientMessageId =
      input.clientMessageId && input.clientMessageId.trim()
        ? input.clientMessageId
        : `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessions.addUserMessage(session, userMessage, input.attachments, userClientMessageId);
    // 用户消息实时通道：与 assistant 事件同一条 onEvent 链路（WebUI / IM / MCP / 自动化共用）。
    // 必须在 addUserMessage 之后发出：时间戳与持久化副本一致；钩子 deny 在上方提前返回、不会误发。
    const persistedUserMessage = session.messages[session.messages.length - 1];
    emit({
      type: 'user-message',
      sessionId,
      content: userMessage,
      timestamp: persistedUserMessage?.timestamp ?? new Date().toISOString(),
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      clientMessageId: userClientMessageId,
      ...(input.runId ? { runId: input.runId } : {}),
    });
    // messageId 由会话级单调序号生成（`<sessionId>#<msgSeq>`，每 turn 消耗一个，持久化在
    // session.msgSeq）—— 严格递增且不受 messages.length 波动（压缩折叠 / 撤回恢复 /
    // healDanglingToolCalls 都会中部 splice 使 length 回落，用 length 派生 id 会与历史已落盘的
    // id 相撞 → 前端流式分片 attach 到旧消息 / 原位覆盖 = 「新消息替换旧消息」错位）。
    // 取号在下方 turn 循环内逐轮进行（见 turnMessageId），保证 run 内与跨 run 均唯一。
    // 记录本次 run 的工作目录（上下文文件相对路径的存在性校验/归一化匹配基准）
    this.sessions.setLastCwd(session, cwd);
    // 活跃置顶：task.id 即 sessionId；无对应任务时静默返回 null
    this.tasks.touchTask(sessionId);
    // 排队期间收到的智能体消息：在用户消息之后、首次 LLM 请求之前注入
    if (bus) this.drainAgentInbox(session, bus, sessionId);

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
    // 代码模式 wire：开启 = 原生工具 + run_code 混合；关闭 = 排除 run_code。
    // Agent 模板 tools 白名单：非空时只暴露白名单工具（agent_status/agent_message 永远并集，
    // 保证任何子代理都能被发现与对话）。
    // 子代理且模板未显式声明 tools 时收窄为只读默认集（需要写权限必须在模板里显式声明）；
    // 主会话空/缺省 = 全部工具。
    const codeMode = cfg.codeMode;
    // 运行级白名单覆盖（agent 工具派发时传入）优先于模板配置
    const profileTools = (input.toolAllowlist ?? agentProfile?.tools ?? []).filter(
      (name): name is string => typeof name === 'string' && name.trim() !== '',
    );
    // 嵌套深度：主会话 depth=0；子代理由 runner 注入 depth。达到上限后不再暴露 agent 工具。
    const maxSubagentDepth = Math.min(5, Math.max(1, cfg.maxSubagentDepth ?? 2));
    const currentDepth = input.bus?.kind === 'subagent' ? input.bus.depth ?? 1 : 0;
    const allowNestedAgent = currentDepth < maxSubagentDepth;
    const isCustomAgent = Boolean(agentProfile && agentProfile.builtIn !== true);
    // 工具白名单语义：
    // - 显式 tools 非空 → 只用白名单 + 协作工具；
    // - 内置模板/子代理未声明 tools → 只读默认集；
    // - 自定义 Agent 未声明 tools → 全部工具（与 templates.ts 的「空=全部」语义一致）。
    let includeOnly: Set<string> | undefined;
    if (profileTools.length > 0) {
      includeOnly = new Set<string>([...profileTools, 'agent_status', 'agent_message']);
    } else if (input.bus?.kind === 'subagent' && !isCustomAgent) {
      includeOnly = new Set<string>(SUBAGENT_READONLY_TOOLS);
    }
    // 子代理必须能发现/联系同伴；主代理无需额外并集
    if (includeOnly && input.bus?.kind === 'subagent') {
      includeOnly.add('agent_status');
      includeOnly.add('agent_message');
    }
    if (!allowNestedAgent) {
      includeOnly?.delete('agent');
    }
    const exclude = new Set<string>();
    if (!codeMode.enabled) exclude.add('run_code');
    if (input.bus?.kind === 'subagent') {
      // 子代理不允许运行时创建持久 Agent；达到深度上限时不允许继续嵌套
      exclude.add('agent_manage');
      if (!allowNestedAgent) exclude.add('agent');
    }
    const wireOptions: {
      includeOnly?: ReadonlySet<string>;
      exclude?: ReadonlySet<string>;
    } = {
      ...(exclude.size > 0 ? { exclude } : {}),
      ...(includeOnly ? { includeOnly } : {}),
    };
    const tools = buildTools(toolRegistry, mcpTools, wireOptions);

    // 系统提示 SDK 附加段：工具/配置不变时字节稳定（前缀缓存友好）。
    const promptExtras: PromptExtraSection[] = [];
    // Agent 模板角色提示词：叠加在主提示词之后（保留 MOSS 通用纪律）
    if (agentProfile?.systemPrompt?.trim()) {
      promptExtras.push({
        id: 'agent-profile',
        title: `Agent 模板：${agentProfile.name}`,
        content:
          `# 子代理角色（${agentProfile.name}）\n\n${agentProfile.systemPrompt.trim()}\n\n---\n` +
          '你在本次运行中扮演上述角色；MOSS 主提示词的通用纪律仍然适用。',
      });
    }
    // 主代理：动态列出注册表中可派发的子代理（含用户自定义 Agent），
    // 让模型无需猜测 id，也避免新增自定义 Agent 后工具描述过期。
    if (input.bus?.kind !== 'subagent' && agentRegistry?.list) {
      try {
        const available = agentRegistry
          .list()
          .filter((item) => !item.default && item.id !== 'agent');
        if (available.length > 0) {
          const lines = available.map(
            (item) =>
              `- ${item.id}：${item.name}${item.description ? ` — ${item.description}` : ''}${item.builtIn ? '（内置）' : '（自定义）'}`,
          );
          promptExtras.push({
            id: 'available-agents',
            title: '可用子代理',
            content:
              `# 可用子代理（agent 工具 template 参数）\n${lines.join('\n')}\n` +
              `嵌套受设置中的最大层级限制（当前 ${maxSubagentDepth} 层）；自定义 Agent 可通过 agent_manage 创建/修改。`,
          });
        }
      } catch {
        // 注册表不可用：跳过该提示段，不影响主流程
      }
    }
    if (codeMode.enabled) {
      const sdkTools = [
        ...(toolRegistry?.listSchemas() ?? [])
          .filter((t) => t.name !== 'run_code')
          .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        ...mcpTools.map((t) => ({
          name: `mcp__${t.server}__${t.name}`,
          description: `[MCP:${t.server}] ${t.description ?? t.name}`,
          inputSchema: t.inputSchema,
        })),
      ];
      const section = buildCodeModePromptExtras({
        uiEnabled: codeMode.uiEnabled,
        tools: sdkTools,
      });
      if (section) promptExtras.push(section);
    }

    // ReAct 循环（maxTurns=0 表示不限制 → Infinity；while 条件与触顶判断天然兼容）
    // 运行级覆盖（agent 工具派发时传入）优先于模板配置
    let turn = 0;
    const effectiveMaxTurns = input.maxTurns ?? agentProfile?.maxTurns ?? cfg.maxTurns;
    const maxTurns = effectiveMaxTurns === 0 ? Infinity : effectiveMaxTurns;
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
            ...(promptExtras.length > 0 ? { promptExtras } : {}),
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
          messages = this.buildFallbackMessages(session, cwd, model, modelDisplayName, promptExtras);
        }
      } else {
        messages = this.buildFallbackMessages(session, cwd, model, modelDisplayName, promptExtras);
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
        ...(replayThinking ? { replayThinking: true } : {}),
      };

      // 流式调用 LLM
      let assistantText = '';
      let assistantThinking = '';
      /** 思考签名累积（Anthropic signature_delta；回传工具轮次时必须携带） */
      let assistantThinkingSignature = '';
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
            case 'thinking_signature':
              // 思考签名（Anthropic）：累积落库，供后续轮次原样回传
              assistantThinkingSignature += delta.signature;
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
        // 请求失败/中断 → 放弃本轮图片「已发送」标记：下次请求仍会重新发送该图，
        // 避免"模型从未见过这张图、后续却只看到占位符"的功能性丢失。
        contextEngine?.discardImagesSent(sessionId);
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
              assistantThinkingSignature || undefined,
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
            assistantThinkingSignature || undefined,
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

      // 本轮请求成功送达 → 确认图片「已发送」：图像只在首次进入请求的那一轮内联 base64，
      // 之后轮次降级为占位符（附原始路径，可 read 重看）→ 阻止历史图片 base64 重发撑爆请求体（413）。
      contextEngine?.confirmImagesSent(sessionId);

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
        assistantThinkingSignature || undefined,
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

      // ===== 权限预检（同一轮全部工具并行）=====
      // 一次列出本轮所有待审批项（前端合并分页）；执行阶段「允许一项执行一项」。
      // 预检完成自愈 / PreToolUse hook / safety.evaluate / 自动审查；执行阶段不再重复。
      const prepared = await Promise.all(
        toolCalls.map(async (tc): Promise<PreparedToolCall> => {
          try {
            return await this.prepareToolCall(tc, {
              sessionId,
              cwd,
              toolCallId: tc.id,
              onEvent: emit,
              signal,
              permissionMode,
              model,
              ...(input.bus?.parentSessionId ? { parentSessionId: input.bus.parentSessionId } : {}),
            });
          } catch (err) {
            // 预检异常隔离：单个工具失败不拖垮整轮
            return {
              tc,
              healedName: tc.name,
              args: {},
              healLogText: '',
              mcpMatch: null,
              outcome: {
                kind: 'denied',
                text: `Error preparing tool call "${tc.name}": ${err instanceof Error ? err.message : String(err)}`,
              },
            };
          }
        }),
      );
      // 需要确认的项统一注册：所有 confirm-required 在同一同步批次发出，前端合并为一张分页卡
      for (const p of prepared) {
        if (p.outcome.kind === 'confirm') {
          // catch → false：批量注册后若上层 abort 导致部分 Promise 提前 reject，
          // 不能让尚未 await 的 Promise 触发 unhandledRejection；执行阶段按「拒绝」处理。
          p.outcome.promise = this.requestConfirm(
            { sessionId, cwd, toolCallId: p.tc.id, onEvent: emit, signal },
            p.outcome.meta.toolName,
            p.outcome.meta.details,
            p.outcome.meta.ruleSuggestion,
            p.outcome.meta.question,
          ).catch(() => false);
        }
      }

      // 执行单个工具调用（含 abort 兜底、失败隔离、配对、统计）。
      // abortedInTools：本轮工具执行期间是否发生中断（闭包内赋值，供循环底部判定；
      // 直接用 finishReason=== 判定会被 TS 流分析窄化，故用显式标志）
      let abortedInTools = false;
      const runOne = async (p: PreparedToolCall): Promise<void> => {
        const tc = p.tc;
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
          abortedInTools = true;
          return;
        }
        // 单工具失败隔离：executePreparedToolCall 抛错时兜底补错误 tool_result，
        // 避免中断后续 tc 导致多个 tool_use 失去 tool_result（触发 HTTP 400）。
        const toolStart = performance.now();
        try {
          await this.executePreparedToolCall(p, {
            sessionId,
            cwd,
            toolCallId: tc.id,
            // 统一走 emit：工具生命周期事件同步草稿状态（刷新后工具卡片状态保真）
            onEvent: emit,
            signal,
            permissionMode,
            model,
            ...(input.bus?.parentSessionId ? { parentSessionId: input.bus.parentSessionId } : {}),
          });
          // 工具执行完毕后检查 abort：这里**不能** break，
          // 否则尚未执行的 tc 会缺失 tool 结果，assistant.tool_calls 悬挂 → HTTP 400。
          // 改为标记 aborted，让其余 tc 在 runOne 顶部统一补错误 tool 结果。
          if (signal?.aborted) {
            finishReason = 'aborted';
            abortedInTools = true;
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
      };

      // 并发语义：
      // - `ask`：同一轮 ≥2 个 → 并发挂起，前端合并为多问题卡片；
      // - `agent`（一次性子代理）：同一轮 ≥2 个 → 真并发（上限 agent.maxConcurrentSubagents，缺省 4）；
      // - 只读工具（tool.json 声明 parallelSafe：read/grep/glob/web）：
      //   连续段并行（上限 agent.maxParallelTools，缺省 4；1 = 串行），
      //   段结束后按 toolCalls 顺序重排工具结果，保证会话里的 tool_result 顺序稳定。
      // - 其余（写工具/terminal/run_code 等）严格串行且保持调用顺序。
      const askCalls = prepared.filter((p) => p.tc.name === 'ask');
      const subagentCalls = prepared.filter((p) => isSubagentToolCall(p.tc));
      const parallelAsks = askCalls.length >= 2;
      const parallelSubagents = subagentCalls.length >= 2;
      const configuredParallel = cfg.maxParallelTools;
      const maxParallelTools =
        typeof configuredParallel === 'number' && Number.isFinite(configuredParallel)
          ? Math.max(1, Math.min(8, Math.floor(configuredParallel)))
          : 4;
      const configuredSubagentParallel = cfg.maxConcurrentSubagents;
      const maxConcurrentSubagents =
        typeof configuredSubagentParallel === 'number' && Number.isFinite(configuredSubagentParallel)
          ? Math.max(1, Math.min(8, Math.floor(configuredSubagentParallel)))
          : MAX_CONCURRENT_SUBAGENT_RUNS;
      const isParallelSafeCall = (p: PreparedToolCall): boolean => {
        if (p.tc.name === 'ask' || isSubagentToolCall(p.tc)) return false;
        return toolRegistry?.isParallelSafe?.(p.tc.name) === true;
      };
      let asksLaunched = false;
      let subagentsLaunched = false;
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        if (parallelAsks && p.tc.name === 'ask') {
          if (!asksLaunched) {
            asksLaunched = true;
            await Promise.all(askCalls.map((a) => runOne(a)));
          }
          continue;
        }
        if (parallelSubagents && isSubagentToolCall(p.tc)) {
          if (!subagentsLaunched) {
            subagentsLaunched = true;
            await runWithLimit(subagentCalls, maxConcurrentSubagents, runOne);
          }
          continue;
        }
        if (maxParallelTools > 1 && isParallelSafeCall(p)) {
          const segment: PreparedToolCall[] = [];
          while (i < prepared.length && isParallelSafeCall(prepared[i])) {
            segment.push(prepared[i]);
            i++;
          }
          i--;
          if (segment.length > 1) {
            await runWithLimit(segment, maxParallelTools, runOne);
            // 并行完成顺序 ≠ 调用顺序；按 toolCalls 顺序重排结果，模型看到稳定的配对序列
            this.reorderToolMessages(sessionId, segment.map((s) => s.tc));
          } else if (segment.length === 1) {
            await runOne(segment[0]);
          }
          continue;
        }
        await runOne(p);
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

      // 多智能体总线：每轮工具完成后注入收件箱消息（下一轮 LLM 可见）
      this.drainAgentInbox(session, bus, sessionId);

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
        contextEngine?.confirmImagesSent(sessionId);
        contextEngine?.markIdle(sessionId);
        this.cleanupPendingAsks(sessionId);
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

      if (abortedInTools) break;

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

    // 兜底清理本会话未完成的 ask（正常流程下应已被 resolve/reject）
    this.cleanupPendingAsks(sessionId);

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
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    // 可见消息缓存：避免每次分页请求都对全量消息 filter 一遍
    return this.sessions.getVisibleMessages(session);
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

  /**
   * 对话节点列表（右侧导航刻度用）：全部用户提问，不受分页影响。
   * id 与 WebUI `adaptAgentMessages` 完全同口径（clientMessageId ?? `h<index>`），
   * 保证懒加载/分页后节点仍能对应到虚拟列表的 itemKey。
   */
  getUserNodes(sessionId: string): Array<{ id: string; index: number; label: string }> {
    const all = this.getHistory(sessionId);
    const nodes: Array<{ id: string; index: number; label: string }> = [];
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      if (m.role !== 'user') continue;
      // 只保留真实用户消息：内部锚定/注入消息（env-context / active-rules / memory-l1 /
      // agent-message / max-turns-notice / compaction-summary 等）一律带 name，
      // 它们在模型视图可见，但不应出现在「对话节点」导航中。
      if (m.name) continue;
      const id =
        typeof m.clientMessageId === 'string' && m.clientMessageId
          ? m.clientMessageId
          : `h${i}`;
      nodes.push({
        id,
        index: i,
        label: typeof m.content === 'string' ? m.content.slice(0, 400) : '',
      });
    }
    return nodes;
  }

  /**
   * 按 toolCallId 取完整工具结果（WebUI 展开折叠卡片时按需加载）。
   * 分页历史只返回轻量投影；完整 content/metadata（含 IntelligentUI spec、嵌套调用）由本方法提供。
   */
  getToolResult(
    sessionId: string,
    toolCallId: string,
  ): { content: string; isError?: boolean; metadata?: Record<string, unknown> } | null {
    const messages = this.sessions.get(sessionId)?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'tool' || m.toolCallId !== toolCallId) continue;
      return {
        content: m.content,
        ...(m.isError ? { isError: true } : {}),
        ...(m.metadata ? { metadata: m.metadata } : {}),
      };
    }
    return null;
  }

  /** 进行中的流式草稿（刷新/重连后恢复半截回复；进程重启残留附 stale 标记） */
  getLiveDraft(sessionId: string): LiveDraft | null {
    return this.liveDraft.snapshot(sessionId);
  }

  /** 获取会话权限模式（供 GET /api/session/:id 与 /api/tasks/:id 刷新恢复前端徽章） */
  getPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.sessions.get(sessionId)?.permissionMode;
  }

  /**
   * 切换会话权限模式（set 工具 kind=mode 调用）。
   * 权限决策在每次工具调用前读取 session 的实时模式，因此同一 run 内立即生效；
   * 同时广播 task.updated，让前端权限徽章不需要刷新即可更新。
   */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.setPermissionMode(session, mode);
    try {
      const task = this.tasks.getTask(sessionId);
      const server = this.services.tryResolve<{ broadcastWS?: (message: unknown) => void }>(
        ServiceNames.SERVER_INSTANCE,
      );
      server?.broadcastWS?.({
        type: 'task.updated',
        payload: { taskId: sessionId, permissionMode: mode, ...(task ? { task } : {}) },
      });
    } catch {
      // 广播失败不影响模式切换本身
    }
    return true;
  }

  /** 权限决策读取实时会话模式：避免 run 启动时复制的 ctx.permissionMode 让 set 切换失效 */
  private sessionPermissionMode(sessionId: string, fallback: PermissionMode): PermissionMode {
    return this.sessions.get(sessionId)?.permissionMode ?? fallback;
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
    // 会话删除：先终止该任务树下全部运行中的子代理（含 async 后台代理），避免孤儿继续跑
    this.services
      .tryResolve<{ cancelTree: (rootSessionId: string) => number }>(ServiceNames.SUBAGENT_RUNNER)
      ?.cancelTree(sessionId);
    this.sessions.delete(sessionId);
  }

  // ========================================================================
  // 任务管理（供 Server 路由调用）
  // ========================================================================

  listTasks(): TaskItem[] {
    return this.tasks.listTasks();
  }

  /** 列出某分组内任务（组内排序，可分页）；供侧边栏按分组按需加载 */
  listTasksInGroup(
    groupId: string,
    opts?: { limit?: number; offset?: number },
  ): { tasks: TaskItem[]; total: number } {
    return this.tasks.listGroupTasks(groupId, opts);
  }

  getTask(id: string): TaskItem | null {
    return this.tasks.getTask(id);
  }

  createTask(title: string, groupId?: string, id?: string): TaskItem {
    const task = this.tasks.createTask(title, groupId, id);
    // 运行期归位：若该 session 文件已存在于别的分组目录（并发创建/索引缺失期写入），
    // 立即搬回正确目录——不再等下一次进程重启才自愈。
    this.sessions.relocate(task.id);
    return task;
  }

  /**
   * 批量导入会话（数据迁移：外部 Agent 转换结果 / MOSS 备份恢复）。
   * 已存在同 id 会话一律跳过（合并策略：不覆盖目标机现有数据）。
   * 写入路径：任务记录 → 会话内存 → 立即落盘（与 getOrCreate 的防抖刷盘不同，
   * 导入是低频操作，同步落盘保证导入完成后刷新页面即可见）。
   */
  importSessions(items: Array<{ id: string; title: string; groupId: string; session: Session }>): {
    imported: number;
    skipped: string[];
  } {
    let imported = 0;
    const skipped: string[] = [];
    for (const item of items) {
      if (this.sessions.get(item.id)) {
        skipped.push(item.id);
        continue;
      }
      this.tasks.createTask(item.title, item.groupId, item.id);
      const session = this.sessions.getOrCreate(item.id);
      session.messages = item.session.messages;
      session.createdAt = item.session.createdAt;
      session.updatedAt = item.session.updatedAt;
      session.totalTokens = item.session.totalTokens;
      session.contextFiles = item.session.contextFiles;
      if (item.session.lastCwd) session.lastCwd = item.session.lastCwd;
      this.sessions.persistSession(session);
      imported++;
    }
    return { imported, skipped };
  }

  updateTask(id: string, patch: { title?: string; groupId?: string }): TaskItem | null {
    const task = this.tasks.updateTask(id, patch);
    if (task) this.sessions.relocate(id);
    return task;
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

  updateTaskGroup(id: string, patch: { name?: string; expanded?: boolean }): TaskGroup | null {
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

  /**
   * 历史智能检索（BM25）：检索「本对话原始上下文」或「跨 session 全量历史」。
   * 原始消息始终保存在 session JSON 中；压缩折叠只是从发送视图移除，检索仍可命中
   * （includeCompacted 默认 true）。供 context 工具 action=search 调用。
   */
  searchMessages(input: HistorySearchInput): HistorySearchResult[] {
    const topK = Math.max(1, Math.min(50, input.topK ?? 10));
    const includeCompacted = input.includeCompacted !== false;
    const includeTool = input.includeTool === true;

    const sessions: Session[] =
      input.scope === 'current'
        ? (() => {
            const s = input.sessionId ? this.sessions.get(input.sessionId) : null;
            return s ? [s] : [];
          })()
        : this.sessions.list();

    const docs: HistorySearchDoc[] = [];
    for (const session of sessions) {
      const msgs = session.messages;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.deletedAt) continue;
        if (m.compacted && !includeCompacted) continue;
        if (m.role === 'system') continue;
        if (m.role === 'tool' && !includeTool) continue;
        if (!m.content) continue;
        docs.push({
          sessionId: session.id,
          index: i,
          role: m.role,
          text: m.content,
          compacted: m.compacted === true,
          ...(m.timestamp ? { timestamp: m.timestamp } : {}),
        });
      }
    }
    return searchHistoryDocs(input.query, docs, topK);
  }

  // ========================================================================

  /**
   * 并行只读工具结束后，把本轮落入会话的 tool 结果按原始 toolCalls 顺序重排。
   * 并行完成顺序与调用顺序不同；模型/历史回放需要稳定的 tool_result 序列
   * （assistant.tool_calls 与 tool 消息一一对应，顺序一致最利于复用与排错）。
   */
  private reorderToolMessages(
    sessionId: string,
    orderedCalls: ReadonlyArray<{ id: string }>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const messages = session.messages;
    const ids = new Set(orderedCalls.map((c) => c.id));
    let anchor = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'assistant' || !m.toolCalls) continue;
      if (m.toolCalls.some((tc) => ids.has(tc.id))) {
        anchor = i;
        break;
      }
    }
    if (anchor < 0) return;
    const toolMessages: AgentMessage[] = [];
    let end = anchor + 1;
    while (end < messages.length && messages[end].role === 'tool') {
      toolMessages.push(messages[end]);
      end++;
    }
    if (toolMessages.length <= 1) return;
    const order = new Map(orderedCalls.map((c, index) => [c.id, index]));
    const sorted = [...toolMessages].sort((a, b) => {
      const oa = order.get(a.toolCallId ?? '') ?? Number.MAX_SAFE_INTEGER;
      const ob = order.get(b.toolCallId ?? '') ?? Number.MAX_SAFE_INTEGER;
      return oa - ob;
    });
    if (sorted.every((m, index) => m === toolMessages[index])) return;
    messages.splice(anchor + 1, toolMessages.length, ...sorted);
    this.logger.debug('agent: reordered parallel tool results', {
      sessionId,
      count: toolMessages.length,
    });
  }

  /** 把总线收件箱中的消息注入会话（role=user + name=agent-message，模型视图可见） */
  private drainAgentInbox(session: Session, bus: AgentBus | null, sessionId: string): void {
    if (!bus) return;
    const notices = bus.drainInbox(sessionId);
    if (notices.length === 0) return;
    for (const notice of notices) {
      this.sessions.addAgentMessage(
        session,
        `[智能体消息] 来自 ${notice.fromName}(${notice.fromAgentId})${
          notice.kind === 'result' ? ' 的执行结果' : ''
        }：\n${notice.content}`,
        'agent-message',
      );
    }
  }

  /**
   * 预检：参数自愈 → PreToolUse hook → 权限决策（含自动审查）。
   * 同一轮所有工具先并行预检，需要确认的项由调用方统一注册（前端合并分页、允许一项执行一项）。
   */
  private async prepareToolCall(
    tc: NonNullable<AgentMessage['toolCalls']>[number],
    ctx: ToolCallContext,
  ): Promise<PreparedToolCall> {
    const { sessionId, cwd, signal } = ctx;
    let args: unknown = {};
    let healedName = tc.name;
    let healLogText = '';

    // 参数解析 + 自愈（context 引擎：JSON 修复/工具名纠正/schema 修正）
    const contextEngine = this.services.tryResolve<ContextEngine>(ServiceNames.CONTEXT_ENGINE);
    if (contextEngine) {
      const heal = contextEngine.healToolCall(tc.name, tc.arguments || '');
      healedName = heal.toolName;
      args = heal.args;
      this.notifyHealed(sessionId, ctx.toolCallId, heal.healLog);
      if (!heal.executable) {
        const errorText = heal.errorText ?? `Error: tool call "${tc.name}" could not be repaired`;
        return {
          tc, healedName, args, healLogText, mcpMatch: null,
          outcome: { kind: 'denied', text: errorText },
        };
      }
      if (heal.healLog.length > 0) {
        healLogText = `\n\n[自愈] ${heal.healLog.map(h => h.detail).join('; ')}`;
      }
    } else {
      try {
        args = JSON.parse(tc.arguments || '{}');
      } catch {
        args = {};
      }
    }

    // 判断是否是 MCP 工具（mcp__server__tool 前缀；用自愈纠正后的名字）
    const mcpMatch = healedName.match(/^mcp__([^_]+)__(.+)$/);

    // ===== 钩子事件：PreToolUse（自愈后、执行前；deny → 直接给出错误结果） =====
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
          this.logger.info('agent: tool call blocked by hook', {
            sessionId,
            toolName: healedName,
            reason: pre.reason,
          });
          return {
            tc, healedName, args, healLogText, mcpMatch,
            outcome: { kind: 'denied', text: `Blocked by hook: ${pre.reason ?? 'tool call denied'}` },
          };
        }
      } catch (err) {
        this.logger.warn('agent: PreToolUse hook failed (fail-open)', {
          sessionId,
          toolName: healedName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (signal?.aborted) {
      return {
        tc, healedName, args, healLogText, mcpMatch,
        outcome: { kind: 'denied', text: 'Error: aborted by user' },
      };
    }

    // ===== 统一权限决策（safety 模块）：本预检取代工具内部权限检查 =====
    const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
    if (!safety) {
      return { tc, healedName, args, healLogText, mcpMatch, outcome: { kind: 'ready' } };
    }

    let decision: SafetyDecision;
    let confirmMeta: ConfirmMetaInfo;
    if (mcpMatch) {
      const serverName = mcpMatch[1];
      const toolName = mcpMatch[2];
      const fullToolName = `mcp__${serverName}__${toolName}`;
      const mcpManager = this.services.tryResolve<MCPManager>(ServiceNames.MCP_MANAGER);
      if (!mcpManager) {
        return {
          tc, healedName, args, healLogText, mcpMatch,
          outcome: { kind: 'denied', text: 'Error: MCP manager not available' },
        };
      }
      if (mcpManager.isServerEnabled(serverName) !== true) {
        return {
          tc, healedName, args, healLogText, mcpMatch,
          outcome: { kind: 'denied', text: `Error: MCP server "${serverName}" is disabled or not found` },
        };
      }
      const annotations = mcpManager.getToolAnnotations(serverName, toolName);
      decision = safety.evaluate({
        toolName: fullToolName,
        params: args,
        mcpAnnotations: annotations ?? undefined,
        mode: this.sessionPermissionMode(ctx.sessionId, ctx.permissionMode),
        sessionId,
        cwd,
        enabled: true,
      });
      confirmMeta = {
        toolName: fullToolName,
        details: args,
        ruleSuggestion: fullToolName,
        question: t('agent.mcpDestructiveConfirm', { server: serverName, tool: toolName }),
      };
    } else {
      const toolRegistry = this.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
      if (!toolRegistry) {
        return {
          tc, healedName, args, healLogText, mcpMatch,
          outcome: { kind: 'denied', text: 'Error: tool registry not available' },
        };
      }
      const tool = toolRegistry.get(healedName);
      decision = safety.evaluate({
        toolName: healedName,
        params: args,
        annotations: tool?.annotations,
        mode: this.sessionPermissionMode(ctx.sessionId, ctx.permissionMode),
        sessionId,
        cwd,
        enabled: toolRegistry.isEnabled(healedName),
      });
      confirmMeta = {
        toolName: healedName,
        details: args,
        ruleSuggestion: safety.generateRuleSuggestion(healedName, args),
      };
    }

    if (decision.action === 'deny') {
      return {
        tc, healedName, args, healLogText, mcpMatch,
        outcome: { kind: 'denied', text: this.formatDenyReason(confirmMeta.toolName, decision.reason) },
      };
    }
    if (decision.action === 'allow') {
      return { tc, healedName, args, healLogText, mcpMatch, outcome: { kind: 'ready' } };
    }

    // ask / review
    if (decision.action === 'review') {
      const verdict = await this.reviewToolCall(healedName, args, ctx);
      if (verdict.decision === 'allow') {
        return { tc, healedName, args, healLogText, mcpMatch, outcome: { kind: 'ready' } };
      }
      if (safety.getReviewConfig().onReviewFailure === 'deny') {
        return {
          tc, healedName, args, healLogText, mcpMatch,
          outcome: { kind: 'denied', text: `Error: [safety][auto-review] ${verdict.reason}` },
        };
      }
      // 转人工：确认卡片附带审查意见，由用户最终决策
      confirmMeta.question = `${confirmMeta.question ? `${confirmMeta.question}\n\n` : ''}AI 审查：${verdict.reason}\n是否允许执行该操作？`;
    }

    return {
      tc, healedName, args, healLogText, mcpMatch,
      outcome: { kind: 'confirm', meta: confirmMeta },
    };
  }

  /** 懒加载审查器（LLM 路由未就绪时返回 null，调用方按失败关闭处理） */
  private getSafetyReviewer(): SafetyReviewer | null {
    if (this.safetyReviewer) return this.safetyReviewer;
    const llm = this.services.tryResolve<LLMRouter>(ServiceNames.LLM_ROUTER);
    if (!llm) return null;
    this.safetyReviewer = new SafetyReviewer({ config: this.config, logger: this.logger, llm });
    return this.safetyReviewer;
  }

  /**
   * 自动审查一次工具调用：推送 review-start / review-end，返回结构化裁决。
   * 证据仅包含待审动作与当前会话最后一条真实用户消息。
   */
  private async reviewToolCall(
    toolName: string,
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<SafetyReviewResult> {
    const { sessionId, toolCallId, onEvent, signal, parentSessionId } = ctx;
    const base = { sessionId, toolCallId, toolName, ...(parentSessionId ? { parentSessionId } : {}) };
    onEvent({ type: 'review-start', ...base });

    const reviewer = this.getSafetyReviewer();
    if (!reviewer) {
      const result: SafetyReviewResult = {
        decision: 'uncertain',
        riskLevel: 'unknown',
        reason: '审查器不可用（LLM 路由未就绪）',
        source: 'fallback',
      };
      onEvent({
        type: 'review-end',
        ...base,
        decision: result.decision,
        reason: result.reason,
        riskLevel: result.riskLevel,
      });
      return result;
    }

    // 用户意图：最后一条真实用户消息（排除 env-context / 记忆等内部锚定消息）
    let userIntent = '';
    try {
      const messages = this.sessions.get(sessionId)?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && !m.name) {
          userIntent = m.content;
          break;
        }
      }
    } catch {
      // 会话不可用：空证据（审查器仍可基于动作本身判断）
    }

    const risk: RiskClass = classifyRisk({ toolName, params: args });
    const result = await reviewer.review({
      toolName,
      params: args,
      cwd: ctx.cwd,
      risk,
      userIntent,
      contextDigest: this.buildReviewDigest(sessionId),
      model: ctx.model,
      signal,
    });
    onEvent({
      type: 'review-end',
      ...base,
      decision: result.decision,
      reason: result.reason,
      riskLevel: result.riskLevel,
    });
    return result;
  }

  /**
   * 审查用「精华上下文」（非全量）：
   * 任务目标 + 最新压缩摘要 + 上一条助手回复 + 最近 5 条工具调用。
   * 预算 4000 字符；不发送工具结果全文，避免把审查请求撑爆或引入不可信内容。
   */
  private buildReviewDigest(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return '';
    const MAX_CHARS = 4000;
    const clip = (text: string, limit: number): string =>
      text.length > limit ? `${text.slice(0, limit)}…` : text;
    const parts: string[] = [];

    const task = this.tasks.getTask(sessionId);
    if (task?.title?.trim()) parts.push(`任务目标：${clip(task.title.trim(), 200)}`);

    const summary = session.compactions?.at(-1)?.summary?.trim();
    if (summary) parts.push(`历史摘要：${clip(summary, 1600)}`);

    const messages = session.messages.filter((m) => !m.deletedAt && !m.compacted && !m.name);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.content.trim()) {
        parts.push(`上一条回复：${clip(m.content.trim(), 800)}`);
        break;
      }
    }

    const actions: string[] = [];
    for (let i = messages.length - 1; i >= 0 && actions.length < 5; i--) {
      const m = messages[i];
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
      for (let j = m.toolCalls.length - 1; j >= 0 && actions.length < 5; j--) {
        const tc = m.toolCalls[j];
        actions.unshift(`${tc.name}(${clip(tc.arguments ?? '', 160)})`);
      }
    }
    if (actions.length > 0) parts.push(`最近工具调用：\n${actions.join('\n')}`);

    return clip(parts.join('\n\n'), MAX_CHARS);
  }

  /**
   * 执行已预检的工具调用：等待自身确认（允许一项执行一项）→ 执行 → 落库 → 事后钩子/通知。
   */
  private async executePreparedToolCall(
    prepared: PreparedToolCall,
    ctx: ToolCallContext,
  ): Promise<void> {
    const { sessionId, cwd, toolCallId, onEvent, signal } = ctx;
    const { tc, healedName, args, healLogText, mcpMatch } = prepared;
    const hooksEngine = this.services.tryResolve<HooksEngineServiceImpl>(ServiceNames.HOOKS_ENGINE);

    // 工具执行前再次检查 abort（防止在确认等待期间被 abort）
    if (signal?.aborted) {
      this.sessions.addToolMessage(
        this.sessions.get(sessionId)!,
        toolCallId,
        'Error: aborted by user',
        healedName,
        { isError: true },
      );
      return;
    }

    // 预检拒绝（hook / safety deny / 自愈失败）：补错误结果，不执行
    if (prepared.outcome.kind === 'denied') {
      const text = prepared.outcome.text;
      this.sessions.addToolMessage(
        this.sessions.get(sessionId)!,
        toolCallId,
        text + healLogText,
        healedName,
        { isError: true },
      );
      onEvent({
        type: 'tool-call-end',
        sessionId,
        toolName: healedName,
        toolCallId,
        result: { content: [{ type: 'text', text }], isError: true },
      });
      return;
    }

    // 需要确认：只等待自己的 Promise（同轮其他项并行等待用户决策）
    if (prepared.outcome.kind === 'confirm') {
      const ok = prepared.outcome.promise ? await prepared.outcome.promise : false;
      if (!ok) {
        const reason = this.headlessSessions.has(sessionId)
          ? `Tool "${healedName}" canceled: permission prompt unavailable in a headless subagent session (timed out)`
          : `Tool "${healedName}" canceled (user declined the permission prompt)`;
        this.sessions.addToolMessage(
          this.sessions.get(sessionId)!,
          toolCallId,
          reason + healLogText,
          healedName,
          { isError: true },
        );
        onEvent({
          type: 'tool-call-end',
          sessionId,
          toolName: healedName,
          toolCallId,
          result: { content: [{ type: 'text', text: reason }], isError: true },
        });
        return;
      }
    }

    onEvent({
      type: 'tool-call-executing',
      sessionId,
      toolName: healedName,
      toolCallId,
    });

    let result: ToolResult;
    try {
      if (mcpMatch) {
        result = await this.executeMcpTool(mcpMatch[1], mcpMatch[2], args, { ...ctx, prechecked: true });
      } else {
        result = await this.executeBuiltinTool(healedName, args, { ...ctx, prechecked: true });
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
    // 空结果必须显式化：模型看不到任何观察时容易反复调用或直接放弃。
    if (!resultText.trim()) {
      resultText = result.isError ? 'Error: 工具执行失败（无错误详情）' : '（工具执行成功，无文本输出）';
    }
    if (result.isError) {
      this.logger.warn('agent: tool call failed', {
        sessionId,
        toolName: healedName,
        toolCallId,
        error: resultText.slice(0, 500),
      });
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
      // UI 帧预算：超限时轻量化（前端展开时懒加载完整结果），避免数 MB 单帧卡住 WebUI
      result: lightenToolResultForEvent(this.stripImagesForWs(result), 512 * 1024),
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

          // 子代理会话：todo 属于子代理自己（数据按 sessionId 隔离落盘）。
          // 隐藏会话没有前端订阅 → 通过独立事件 subagent.todo 定向通知 root 页面；
          // 前端只写入 payload.agentSessionId 对应的子代理会话，绝不触碰主会话 todos。
          const bus = this.services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS);
          const member = bus?.get(sessionId);
          if (member?.kind === 'subagent') {
            // 1) 子代理完整任务页（订阅的是子会话）：走原事件，保持自洽
            server.sendToSession(sessionId, {
              type: 'todo-updated',
              sessionId,
              payload: { todos, toolCallId },
            });
            // 2) 主会话页（订阅的是 root）：独立事件，携带子代理归属
            if (member.rootSessionId && member.rootSessionId !== sessionId) {
              server.sendToSession(member.rootSessionId, {
                type: 'subagent.todo',
                sessionId: member.rootSessionId,
                payload: { agentSessionId: sessionId, todos, toolCallId },
              });
            }
            break;
          }

          // 主会话：行为与现状完全一致
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
      /** 已由本轮预检完成权限决策（跳过内部重复评估） */
      prechecked?: boolean;
      /** 当前会话模型 id（嵌套调用审查时继承） */
      model?: string;
      /** 子代理父会话 id（审查/确认来源归属） */
      parentSessionId?: string;
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
    // 预检已完成（prechecked）时直接放行；嵌套调用（run_code 内部）仍走完整权限链。
    const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
    let permissionDecision: 'allowed' | undefined;
    if (ctx.prechecked) {
      permissionDecision = 'allowed';
    } else if (safety) {
      const tool = toolRegistry.get(name);
      const decision = safety.evaluate({
        toolName: name,
        params: args,
        annotations: tool?.annotations,
        mode: this.sessionPermissionMode(ctx.sessionId, ctx.permissionMode),
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
      if (decision.action === 'review') {
        const verdict = await this.reviewToolCall(name, args, {
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          toolCallId: ctx.toolCallId,
          onEvent: ctx.onEvent,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          permissionMode: this.sessionPermissionMode(ctx.sessionId, ctx.permissionMode),
          model: ctx.model ?? '',
          ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
        });
        if (verdict.decision === 'allow') {
          permissionDecision = 'allowed';
        } else if (safety.getReviewConfig().onReviewFailure === 'deny') {
          return {
            content: [{ type: 'text', text: `Error: [safety][auto-review] ${verdict.reason}` }],
            isError: true,
          };
        } else {
          const ok = await this.requestConfirm(
            ctx,
            name,
            args,
            safety.generateRuleSuggestion(name, args),
            `AI 审查：${verdict.reason}\n是否允许执行该操作？`,
          );
          if (!ok) {
            return {
              content: [{ type: 'text', text: `Tool "${name}" canceled (user declined the permission prompt)` }],
              isError: true,
            };
          }
          permissionDecision = 'allowed';
        }
      } else if (decision.action === 'ask') {
        const ruleSuggestion = safety.generateRuleSuggestion(name, args);
        const ok = await this.requestConfirm(ctx, name, args, ruleSuggestion);
        if (!ok) {
          // headless 会话没有可应答的 UI：明确告知模型"不是用户拒绝，而是无人应答"，
          // 便于它改用低风险工具或直接向父会话求援，而不是反复重试同一 L3 工具。
          const reason = this.headlessSessions.has(ctx.sessionId)
            ? `Tool "${name}" canceled: permission prompt unavailable in a headless subagent session (timed out)`
            : `Tool "${name}" canceled (user declined the permission prompt)`;
          return {
            content: [{ type: 'text', text: reason }],
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
        // 通用 progress 只记日志：旧实现错误地转发成 tool-call-start，
        // 会在工具执行中把卡片状态重置回 generating（闪烁/假状态）。
        // PTC 的实时进度走独立的 run-code-progress 通道。
        if (event.type === 'progress') {
          this.logger.debug('tool: progress', {
            sessionId: ctx.sessionId,
            toolName: name,
            message: event.message,
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
          const pendingKey = this.pendingKey(ctx.sessionId, ctx.toolCallId);
          const timer = timeoutMs > 0 ? setTimeout(() => {
            if (this.pendingAsks.delete(pendingKey)) {
              reject(new Error(`ask timeout after ${Math.round(timeoutMs / 60000)}min`));
              // 通知前端移除残留卡片
              ctx.onEvent({ type: 'ask-timeout', sessionId: ctx.sessionId, toolCallId: ctx.toolCallId });
            }
          }, Math.min(timeoutMs, ASK_TIMEOUT_CEILING_MS)) : null;
          this.pendingAsks.set(pendingKey, {
            resolve,
            reject,
            timer,
            sessionId: ctx.sessionId,
            toolCallId: ctx.toolCallId,
            payload,
          });
          // 中断时立即 reject
          if (ctx.signal) {
            ctx.signal.addEventListener(
              'abort',
              () => {
                const pending = this.pendingAsks.get(pendingKey);
                if (pending) {
                  if (pending.timer) clearTimeout(pending.timer);
                  this.pendingAsks.delete(pendingKey);
                  ctx.onEvent({ type: 'ask-timeout', sessionId: ctx.sessionId, toolCallId: ctx.toolCallId });
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
            questions: payload.questions,
          });
        });
      },
      confirm: (question: string) => this.requestConfirm(ctx, name, args, undefined, question),
      invokeTool: (nestedName, nestedArgs, opts) =>
        this.invokeToolFromCode(
          nestedName,
          nestedArgs,
          {
            sessionId: ctx.sessionId,
            cwd: ctx.cwd,
            parentToolCallId: ctx.toolCallId,
            onEvent: ctx.onEvent,
            signal: opts?.signal ?? ctx.signal,
            permissionMode: this.sessionPermissionMode(ctx.sessionId, ctx.permissionMode),
            model: ctx.model ?? '',
            ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
          },
          opts?.callId,
        ),
      onRunCodeProgress: (progress) => {
        ctx.onEvent({
          type: 'run-code-progress',
          sessionId: ctx.sessionId,
          toolCallId: ctx.toolCallId,
          payload: progress,
        });
      },
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

  /**
   * 代码模式嵌套调用（run_code 子进程 → 宿主）。
   *
   * 与 native executeToolCall 的差异：
   *   - 不写 tool 消息、不发 tool-call-start/end（中间结果不回上下文）；
   *   - 仍完整走 safety（executeBuiltinTool/executeMcpTool 内部）、Pre/PostToolUse 钩子、
   *     文件访问规则登记与 todo/context 副作用；
   *   - confirm 事件使用嵌套 toolCallId，前端现有 pending 卡片可直接应答；
   *   - 禁止递归 run_code，且禁止 ask / agent / todo（程序内硬限制）。
   */
  private async invokeToolFromCode(
    name: string,
    args: unknown,
    ctx: {
      sessionId: string;
      cwd: string;
      parentToolCallId: string;
      onEvent: (event: AgentEvent) => void;
      signal?: AbortSignal;
      permissionMode: PermissionMode;
      /** 当前会话模型 id（嵌套审查继承） */
      model?: string;
      /** 子代理父会话 id（审查/确认来源归属） */
      parentSessionId?: string;
    },
    requestedCallId?: string,
  ): Promise<ToolResult> {
    if (isPtcForbiddenTool(name)) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: PTC 程序内禁止调用 ${name} 工具。请直接在主流程调用原生工具，不要写进 run_code 程序。`,
          },
        ],
        isError: true,
      };
    }
    if (name === 'run_code') {
      return {
        content: [{ type: 'text', text: 'Error: nested run_code is forbidden (recursion depth is fixed at 1)' }],
        isError: true,
      };
    }

    const toolCallId = requestedCallId
      ? `ptc_${requestedCallId}`
      : `ptc_${Date.now().toString(36)}_${++this.nestedCodeCallSeq}`;

    const hooksEngine = this.services.tryResolve<HooksEngineServiceImpl>(ServiceNames.HOOKS_ENGINE);
    if (hooksEngine) {
      try {
        const pre = await hooksEngine.dispatch('PreToolUse', {
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          toolName: name,
          toolInput: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
        });
        if (pre.decision === 'deny') {
          return {
            content: [{ type: 'text', text: `Blocked by hook: ${pre.reason ?? 'tool call denied'}` }],
            isError: true,
          };
        }
      } catch (err) {
        this.logger.warn('agent: nested PreToolUse hook failed (fail-open)', {
          sessionId: ctx.sessionId,
          toolName: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const nestedCtx = {
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      toolCallId,
      // 只把交互事件转发给上层；嵌套工具进度/生命周期事件不进主消息流。
      onEvent: (event: AgentEvent): void => {
        if (
          event.type === 'ask' ||
          event.type === 'ask-timeout' ||
          event.type === 'confirm-required' ||
          event.type === 'confirm-cancel'
        ) {
          ctx.onEvent(event);
        }
      },
      signal: ctx.signal,
      permissionMode: this.sessionPermissionMode(ctx.sessionId, ctx.permissionMode),
      model: ctx.model ?? '',
      ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
    };

    const mcpMatch = name.match(/^mcp__([^_]+)__(.+)$/);
    let result: ToolResult;
    try {
      if (mcpMatch) {
        result = await this.executeMcpTool(mcpMatch[1], mcpMatch[2], args, nestedCtx);
      } else {
        const registry = this.services.tryResolve<ToolRegistry>(ServiceNames.TOOL_REGISTRY);
        if (!registry?.get(name)) {
          return { content: [{ type: 'text', text: `Error: tool "${name}" not found` }], isError: true };
        }
        result = await this.executeBuiltinTool(name, args, nestedCtx);
      }
    } catch (err) {
      result = {
        content: [{ type: 'text', text: `Error executing tool "${name}": ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }

    // PostToolUse：通知型 fire-and-forget
    if (hooksEngine) {
      void hooksEngine
        .dispatch('PostToolUse', {
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          toolName: name,
          toolInput: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
        })
        .catch((err: unknown) => {
          this.logger.warn('agent: nested PostToolUse hook failed (fail-open)', {
            sessionId: ctx.sessionId,
            toolName: name,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // 规则引擎：文件访问登记（与主路径同口径）
    if (FILE_ACCESS_TOOLS.has(name)) {
      try {
        const rulesEngine = this.services.tryResolve<RulesEngineServiceImpl>(ServiceNames.RULES_ENGINE);
        if (rulesEngine) {
          const paths = extractToolPaths(name, args);
          const session = this.sessions.get(ctx.sessionId);
          if (paths.length > 0 && session && rulesEngine.recordFileAccess(session, paths, ctx.cwd)) {
            this.sessions.persistSession(session);
          }
        }
      } catch (err) {
        this.logger.warn('agent: nested rules recordFileAccess failed', {
          sessionId: ctx.sessionId,
          toolName: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 副作用：嵌套 todo 快照挂到外层 run_code 的 toolCallId；read/grep/glob 更新 contextFiles。
    this.notifyToolSideEffects(name, args, ctx.sessionId, ctx.parentToolCallId);

    return result;
  }

  /**
   * pending ask/confirm 的进程级唯一键。
   * toolCallId 由模型服务商生成，跨会话可能重复（部分兼容实现形如 `call_0`）；
   * 只用 toolCallId 会在并发会话间覆盖/串话，因此必须拼上 sessionId。
   */
  private pendingKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}\u0000${toolCallId}`;
  }

  /** 前端回复 ask 提问（accept/cancel）。匹配到本会话的 pending 则 resolve 并返回 true。 */
  resolveAsk(sessionId: string, toolCallId: string, outcome: AskOutcome): boolean {
    const key = this.pendingKey(sessionId, toolCallId);
    const pending = this.pendingAsks.get(key);
    if (!pending) return false;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingAsks.delete(key);
    pending.resolve(outcome);
    // 跨端同步：无论回答来自 WebUI 还是 IM，都通知该会话全部订阅者移除提问卡片
    this.notifyResolution(sessionId, 'tool.ask.accepted', toolCallId);
    return true;
  }

  /** 列出某 session 的待答 ask（供 WS 重连恢复 pending asks，携带完整提问载荷）。 */
  getPendingAsks(sessionId: string): Array<{ toolCallId: string; sessionId: string; payload: AskPayload }> {
    const out: Array<{ toolCallId: string; sessionId: string; payload: AskPayload }> = [];
    for (const [, pending] of this.pendingAsks) {
      if (pending.sessionId === sessionId) {
        out.push({ toolCallId: pending.toolCallId, sessionId: pending.sessionId, payload: pending.payload });
      }
    }
    return out;
  }

  /**
   * 前端回复 confirm 确认。匹配到本会话的 pending 则 resolve 并返回 true。
   * @param remember 「始终允许」级别：session=会话规则（内存）；project=项目规则（{cwd}/.moss/permissions.json）；global=全局规则（持久+广播）
   */
  resolveConfirm(sessionId: string, toolCallId: string, ok: boolean, remember?: 'session' | 'project' | 'global'): boolean {
    const key = this.pendingKey(sessionId, toolCallId);
    const pending = this.pendingConfirms.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingConfirms.delete(key);
    // 用户选择「始终允许」：按建议规则写入对应层级的 allow 列表
    if (ok && remember && pending.ruleSuggestion) {
      const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
      if (safety) {
        if (remember === 'session') {
          safety.addSessionRule(pending.sessionId, 'allow', pending.ruleSuggestion);
        } else if (remember === 'project') {
          void safety.addProjectRule(pending.cwd, 'allow', pending.ruleSuggestion);
        } else {
          void safety.addGlobalRule('allow', pending.ruleSuggestion);
        }
      }
    }
    pending.resolve(ok);
    // 跨端同步：IM 回复「允许/拒绝」后，WebUI 的确认卡片立即消失
    this.notifyResolution(sessionId, 'tool.confirm.accepted', toolCallId);
    return true;
  }

  /**
   * 广播「交互已解决」给该会话的全部 WS 订阅者。
   * 前端 tool.ask.accepted / tool.confirm.accepted 分支据此移除残留卡片；
   * 事件形状与 ws-handler 既有发送保持一致（sessionId/toolCallId 放顶层）。
   */
  private notifyResolution(
    sessionId: string,
    type: 'tool.ask.accepted' | 'tool.confirm.accepted',
    toolCallId: string,
  ): void {
    const server = this.services.tryResolve<{
      sendToSession: (sid: string, msg: unknown) => void;
    }>(ServiceNames.SERVER_INSTANCE);
    try {
      server?.sendToSession(sessionId, {
        type,
        sessionId,
        toolCallId,
        payload: { sessionId, toolCallId },
      });
    } catch {
      // WS 不可用：静默（不阻断交互 resolve）
    }
  }

  /** 列出某 session 的待确认 confirm（供 WS 重连恢复 pending confirms）。 */
  getPendingConfirms(sessionId: string): Array<{
    toolCallId: string;
    sessionId: string;
    question: string;
    ruleSuggestion?: string;
    details?: unknown;
    source?: ConfirmSource;
  }> {
    const out: Array<{
      toolCallId: string;
      sessionId: string;
      question: string;
      ruleSuggestion?: string;
      details?: unknown;
      source?: ConfirmSource;
    }> = [];
    for (const [, pending] of this.pendingConfirms) {
      if (pending.sessionId === sessionId) {
        out.push({
          toolCallId: pending.toolCallId,
          sessionId: pending.sessionId,
          question: pending.question,
          ruleSuggestion: pending.ruleSuggestion,
          source: pending.source,
        });
      }
    }
    return out;
  }

  /** 计算确认来源：AgentBus 成员 → 子代理；否则主会话 */
  private resolveConfirmSource(sessionId: string): ConfirmSource {
    const bus = this.services.tryResolve<AgentBus>(ServiceNames.AGENT_BUS);
    const member = bus?.get(sessionId);
    if (member && member.kind === 'subagent') {
      return {
        kind: 'subagent',
        sessionId,
        ...(member.name ? { name: member.name } : {}),
        ...(member.template ? { template: member.template } : {}),
        ...(member.parentSessionId ? { parentSessionId: member.parentSessionId } : {}),
      };
    }
    return { kind: 'main', sessionId };
  }

  /**
   * 统一确认请求：注册 pendingConfirms + 推送 confirm-required 事件（带规则建议/来源）+
   * 超时从 config.safety.confirmTimeoutMinutes 读取（0=永不，默认 5 分钟）。
   */
  private requestConfirm(
    ctx: {
      sessionId: string;
      cwd: string;
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
      // 子代理确认会汇总到主会话中控岛（带权限来源），因此统一使用正常超时；
      // 父会话结束/中断时由 abort 级联取消，run 结束时 cleanupPendingAsks 兜底。
      let timeoutMs = 5 * 60 * 1000;
      try {
        const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
        if (safety) {
          const minutes = safety.getConfirmTimeoutMinutes();
          timeoutMs = minutes === 0 ? 0 : Math.min(minutes * 60 * 1000, ASK_TIMEOUT_CEILING_MS);
        }
      } catch {
        // config 不可用：保留默认超时
      }
      const pendingKey = this.pendingKey(ctx.sessionId, ctx.toolCallId);
      const source = this.resolveConfirmSource(ctx.sessionId);
      // timeoutMs=0 表示永不超时：不能把 0 传给 setTimeout（会立即触发）
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pendingConfirms.delete(pendingKey);
            // 超时同样要通知前端/IM 移除确认卡片；否则卡片会残留到用户下次回复才暴露
            ctx.onEvent({ type: 'confirm-cancel', sessionId: ctx.sessionId, toolCallId: ctx.toolCallId });
            resolve(false);
          }, timeoutMs)
        : (null as unknown as ReturnType<typeof setTimeout>);
      const question = customQuestion ?? `Tool "${toolName}" requires confirmation (permission mode)`;
      this.pendingConfirms.set(pendingKey, {
        resolve,
        reject,
        timer,
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        question,
        ...(ruleSuggestion ? { ruleSuggestion } : {}),
        cwd: ctx.cwd,
        source,
      });
      if (ctx.signal) {
        ctx.signal.addEventListener(
          'abort',
          () => {
            if (this.pendingConfirms.has(pendingKey)) {
              clearTimeout(timer);
              this.pendingConfirms.delete(pendingKey);
              ctx.onEvent({ type: 'confirm-cancel', sessionId: ctx.sessionId, toolCallId: ctx.toolCallId });
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
        source,
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

  /**
   * 清理本会话未完成的 pending ask 与 confirm（run 结束时兜底）。
   * 必须按 session 隔离：多个会话可并发 run，全局清理会以 'session ended'
   * 误杀其他会话正在等待的提问/确认。
   */
  private cleanupPendingAsks(sessionId: string): void {
    for (const [key, pending] of this.pendingAsks) {
      if (pending.sessionId !== sessionId) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingAsks.delete(key);
      pending.reject(new Error('session ended'));
    }
    for (const [key, pending] of this.pendingConfirms) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pendingConfirms.delete(key);
      pending.resolve(false);
    }
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
    promptExtras?: PromptExtraSection[] | null,
  ): UnifiedMessage[] {
    const skillName =
      session.activeSkill?.mode === 'system' ? session.activeSkill.name : undefined;
    const skillPrompt = skillName ? this.resolveSkillPrompt(skillName) : null;
    const systemContent = buildStaticSystemPrompt(this.env, skillPrompt, null, promptExtras ?? null);
    const view = buildRequestView(session, systemContent, {
      resolveSkillPrompt: name => this.resolveSkillPrompt(name),
      // 降级路径同样保留当前轮工具调用 thinking：DeepSeek 思考模式缺 reasoning_content 会 400
      includeToolCallThinking: true,
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
      /** 已由本轮预检完成权限决策（跳过内部重复评估） */
      prechecked?: boolean;
      /** 当前会话模型 id（嵌套调用审查时继承） */
      model?: string;
      /** 子代理父会话 id（审查/确认来源归属） */
      parentSessionId?: string;
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

    // 2. 统一权限决策（safety 模块）：MCP 工具与 builtin 同一决策管线（模式/规则/风险分级）。
    // 预检已完成（prechecked）时跳过；嵌套调用仍走完整权限链。
    const annotations = mcpManager.getToolAnnotations(serverName, toolName);
    const safety = this.services.tryResolve<SafetyService>(ServiceNames.SAFETY);
    if (ctx.prechecked) {
      // 预检已裁决：直接执行
    } else if (safety) {
      const decision = safety.evaluate({
        toolName: fullToolName,
        params: args,
        mcpAnnotations: annotations ?? undefined,
        mode: this.sessionPermissionMode(ctx.sessionId, ctx.permissionMode),
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
      if (decision.action === 'review') {
        const verdict = await this.reviewToolCall(fullToolName, args, {
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          toolCallId: ctx.toolCallId,
          onEvent: ctx.onEvent,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          permissionMode: this.sessionPermissionMode(ctx.sessionId, ctx.permissionMode),
          model: ctx.model ?? '',
          ...(ctx.parentSessionId ? { parentSessionId: ctx.parentSessionId } : {}),
        });
        if (verdict.decision !== 'allow') {
          if (safety.getReviewConfig().onReviewFailure === 'deny') {
            return {
              content: [{ type: 'text', text: `Error: [safety][auto-review] ${verdict.reason}` }],
              isError: true,
              metadata: { server: serverName, tool: toolName, denied: true },
            };
          }
          const ok = await this.requestConfirm(
            ctx,
            fullToolName,
            args,
            fullToolName,
            `AI 审查：${verdict.reason}\n是否允许执行该操作？`,
          );
          if (!ok) {
            return {
              content: [{ type: 'text', text: 'Canceled: user declined the MCP tool call' }],
              isError: true,
              metadata: { server: serverName, tool: toolName, canceled: true },
            };
          }
        }
      } else if (decision.action === 'ask') {
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
          const pendingKey = this.pendingKey(ctx.sessionId, ctx.toolCallId);
          const timer = askTimeoutMs > 0 ? setTimeout(() => {
            if (this.pendingAsks.delete(pendingKey)) {
              resolve({ action: 'decline' });
              ctx.onEvent({ type: 'ask-timeout', sessionId: ctx.sessionId, toolCallId: ctx.toolCallId });
            }
          }, Math.min(askTimeoutMs, ASK_TIMEOUT_CEILING_MS)) : null;
          const elicitationQuestion: AskQuestion = { id: 'q0', question, answerType: 'form', formSchema };
          this.pendingAsks.set(pendingKey, {
            resolve: outcome => {
              const form = outcome.action === 'accept' ? outcome.answers?.[0]?.form : undefined;
              if (form) {
                resolve({ action: 'accept', content: form });
              } else {
                resolve({ action: 'decline' });
              }
            },
            reject,
            timer,
            sessionId: ctx.sessionId,
            toolCallId: ctx.toolCallId,
            payload: { questions: [elicitationQuestion] },
          });
          if (ctx.signal) {
            ctx.signal.addEventListener(
              'abort',
              () => {
                if (this.pendingAsks.has(pendingKey)) {
                  if (timer) clearTimeout(timer);
                  this.pendingAsks.delete(pendingKey);
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
            questions: [elicitationQuestion],
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
