// src/modules/server/ws-handler.ts
// WebSocket 消息分发：处理前端 WS 消息，转发 Agent 事件到客户端。

import { t } from '../../core/i18n';
import { release } from 'node:os';
import type { Environment, Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { WSMessage, WSMessageHandler, WSConnection } from './types';
import type { AgentEngine, AgentEvent, GuidanceMessage, TerminalService, InterpreterKind } from '../contracts';
import type { AutomationService } from '../automation';
import { ErrorCode } from '../../core/error-codes';
import { VoiceSessionHost } from './voice-session-host';
import { runInsightDiagnose, type InsightEvent, type InsightKind } from './insight-diagnose';

/** 从语音指令 payload 读取可选 modelId（缺省用服务端默认模型） */
function readVoiceModelId(msg: WSMessage): string | undefined {
  const payload = (msg as { payload?: { modelId?: unknown } }).payload;
  return typeof payload?.modelId === 'string' && payload.modelId ? payload.modelId : undefined;
}

interface ConnectionState {
  conn: WSConnection;
  /** 最近一次订阅/操作的 session（兼容展示语义；事件投递以下方 subscribedSessions 为准） */
  sessionId?: string;
  /** 该连接订阅的全部 session：agent 事件按 sessionId 路由到所有订阅连接 */
  subscribedSessions: Set<string>;
}

/**
 * 高频流式事件合帧器：assistant-text / assistant-thinking / tool-call-delta
 * 按 key 拼接缓冲，30ms 定时冲刷（消息量从每 token 一条降到每秒 ~33 条）。
 * 保序：任何非缓冲事件发送前先 flush（见 WsHandler.sendEvent）；
 * 前端 useWebSocket 对这些类型为字符串累加语义，合帧天然兼容。
 */
const BATCH_INTERVAL_MS = 30;
/** 单 key 拼接上限：超过立即 flush（防极端大文本滞留缓冲） */
const BATCH_MAX_CHARS = 256 * 1024;

interface BatchedEvent {
  type: 'assistant-text' | 'assistant-thinking' | 'tool-call-delta';
  sessionId: string;
  runId?: string;
  /** 本轮流式消息 id：合帧只能在「同一轮」内进行（跨轮 offset 空间重置，禁止合并） */
  messageId?: string;
  /** 合帧后首个分片的起始偏移（保持 offset 语义：合并块 = content[offset, total)） */
  offset?: number;
  /** 合帧后最后分片的累计长度 */
  total?: number;
  /** assistant-text / assistant-thinking 拼接文本 */
  text?: string;
  /** tool-call-delta 专属 */
  toolCallId?: string;
  argumentsDelta?: string;
}

class EventBatcher {
  private readonly buffer = new Map<string, BatchedEvent>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushOut: (msg: Record<string, unknown>) => void;

  constructor(flushOut: (msg: Record<string, unknown>) => void) {
    this.flushOut = flushOut;
  }

  isBatchable(type: string): boolean {
    return type === 'assistant-text' || type === 'assistant-thinking' || type === 'tool-call-delta';
  }

  /** 缓冲一条高频事件（同 key 且同轮拼接 text / argumentsDelta，保留首尾 offset） */
  push(msg: { type: string; sessionId: string; payload: Record<string, unknown> }): void {
    const p = msg.payload;
    const runId = typeof p.runId === 'string' ? p.runId : undefined;
    const messageId = typeof p.messageId === 'string' ? p.messageId : undefined;
    const offset = typeof p.offset === 'number' ? p.offset : undefined;
    const total = typeof p.total === 'number' ? p.total : undefined;
    if (msg.type === 'tool-call-delta') {
      const toolCallId = String(p.toolCallId ?? '');
      const key = `${msg.sessionId}|d|${toolCallId}`;
      const delta = String(p.argumentsDelta ?? '');
      const existing = this.buffer.get(key);
      if (existing && existing.runId === runId && existing.messageId === messageId) {
        existing.argumentsDelta = (existing.argumentsDelta ?? '') + delta;
        if (total !== undefined) existing.total = total;
      } else {
        // 同 key 但轮次/run 不同（打断竞态 / 跨轮 30ms 窗口）：
        // 先冲刷旧条目再缓冲新条目——直接 set 覆盖会把旧分片**静默丢弃**，
        // 前端出现缺口后所有后续分片被按重复丢弃（回复终止的传输侧根因）。
        if (existing) this.flush();
        this.buffer.set(key, {
          type: 'tool-call-delta', sessionId: msg.sessionId, runId, messageId, offset, total,
          toolCallId, argumentsDelta: delta,
        });
      }
    } else {
      // 't' = text, 'k' = thinking（同轮 text 与 thinking 交替时不互相污染）
      const kind = msg.type === 'assistant-text' ? 't' : 'k';
      const key = `${msg.sessionId}|${kind}`;
      const text = String(p.text ?? '');
      const existing = this.buffer.get(key);
      // 合并条件必须含 messageId：同一 run 内跨轮（新一轮 offset 从 0 开始）不可合并，
      // 否则前端会把它当成同一轮的延续，造成文本错位。
      if (existing && existing.runId === runId && existing.messageId === messageId) {
        existing.text = (existing.text ?? '') + text;
        if (total !== undefined) existing.total = total;
      } else {
        // 同 key 但轮次/run 不同：先冲刷旧条目再缓冲，绝不覆盖丢片（理由同上）
        if (existing) this.flush();
        this.buffer.set(key, {
          type: msg.type as BatchedEvent['type'], sessionId: msg.sessionId, runId, messageId, offset, total, text,
        });
      }
    }

    // 超限立即冲刷
    for (const e of this.buffer.values()) {
      if ((e.text ?? e.argumentsDelta ?? '').length > BATCH_MAX_CHARS) {
        this.flush();
        break;
      }
    }

    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, BATCH_INTERVAL_MS);
    }
  }

  /** 冲刷全部缓冲（保序：按插入顺序发送） */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.size === 0) return;
    const events = Array.from(this.buffer.values());
    this.buffer.clear();
    for (const e of events) {
      if (e.type === 'tool-call-delta') {
        const delta = e.argumentsDelta ?? '';
        this.flushOut({
          type: 'tool-call-delta',
          sessionId: e.sessionId,
          payload: {
            type: 'tool-call-delta',
            sessionId: e.sessionId,
            toolCallId: e.toolCallId,
            argumentsDelta: delta,
            runId: e.runId,
            messageId: e.messageId,
            offset: e.offset,
            total: e.total ?? (e.offset !== undefined ? e.offset + delta.length : undefined),
          },
        });
      } else {
        const text = e.text ?? '';
        this.flushOut({
          type: e.type,
          sessionId: e.sessionId,
          payload: {
            type: e.type,
            sessionId: e.sessionId,
            text,
            runId: e.runId,
            messageId: e.messageId,
            offset: e.offset,
            total: e.total ?? (e.offset !== undefined ? e.offset + text.length : undefined),
          },
        });
      }
    }
  }
}

export class WsHandler {
  private readonly states = new Map<string, ConnectionState>();
  private readonly messageHandlers: WSMessageHandler[] = [];
  private readonly logger: Logger;
  private readonly services: ServiceRegistry;
  private readonly env: Environment;
  /**
   * 运行中任务：sessionId → AbortController（handler 级，与连接解耦）。
   * WS 断连不再中止任务（弱网闪断/心跳重连曾直接杀死后台任务且前端无从感知——
   * 长程任务「回复/思考/工具调用卡死」的根因）；仅 task.abort 显式中断。
   */
  private readonly activeRuns = new Map<string, AbortController>();
  /** 运行中的 runId（sessionId → runId）：session.subscribe 快照回复用（前端事件隔离对齐） */
  private readonly activeRunIds = new Map<string, string>();
  /** 引导消息数组（可变引用，传给 engine.run；handleTaskGuide 在运行期间向其 push 消息） */
  private readonly guideMessageArrays = new Map<string, GuidanceMessage[]>();
  /** 引导消息对应的 runId 队列（前端为每条引导消息生成 runId，用于新 run 的事件隔离） */
  private readonly guideRunIds = new Map<string, string[]>();
  private readonly batcher: EventBatcher;
  /** 语音会话宿主（每条连接一个流式识别会话） */
  private readonly voiceHost: VoiceSessionHost;
  /** AI 诊断运行中的请求：requestId → AbortController（前端关闭弹窗可取消） */
  private readonly insightRuns = new Map<string, AbortController>();

  constructor(services: ServiceRegistry, logger: Logger, env: Environment) {
    this.services = services;
    this.logger = logger;
    this.env = env;
    this.batcher = new EventBatcher((msg) => {
      this.sendToSubscribers(String(msg.sessionId), msg);
    });
    this.voiceHost = new VoiceSessionHost(services, logger);
  }

  onWSMessage(handler: WSMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /** 注册新连接 */
  registerConnection(conn: WSConnection): void {
    this.states.set(conn.id, { conn, subscribedSessions: new Set() });
    this.logger.debug(t('server.wsConnected', { id: conn.id }));
  }

  /** 移除连接：只清订阅，不中止任务（任务与连接解耦，断连后继续跑，重连可恢复） */
  unregisterConnection(id: string): void {
    this.voiceHost.dispose(id);
    this.states.delete(id);
    this.logger.debug(t('server.wsDisconnected', { id }));
  }

  /** 处理来自客户端的消息（string = JSON 指令；Buffer = 语音二进制音频帧） */
  async handleMessage(connId: string, raw: string | Buffer): Promise<void> {
    const state = this.states.get(connId);
    if (!state) return;

    // 二进制帧：语音音频流（PCM int16 LE @16kHz）
    if (typeof raw !== 'string') {
      this.voiceHost.acceptBinary(connId, raw);
      return;
    }

    let msg: WSMessage;
    try {
      msg = JSON.parse(raw) as WSMessage;
    } catch {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_INVALID_JSON } });
      return;
    }

    // 1. 通知注册的 handler
    for (const h of this.messageHandlers) {
      try {
        await h(msg);
      } catch (err) {
        this.logger.error(t('server.wsHandlerFailed'), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. 内置消息处理
    switch (msg.type) {
      case 'task.stream':
        return this.handleTaskStream(state, msg);
      case 'task.guide':
        return this.handleTaskGuide(state, msg);
      case 'task.abort':
        return this.handleTaskAbort(state, msg);
      case 'session.subscribe':
        return this.handleSessionSubscribe(state, msg);
      case 'tool.ask.reply':
        return this.handleAskReply(state, msg);
      case 'tool.confirm.reply':
        return this.handleConfirmReply(state, msg);
      case 'task.create':
        return this.handleTaskCreate(state, msg);
      case 'task.switch':
        return this.handleTaskSwitch(state, msg);
      case 'automation.run':
        return this.handleAutomationRun(state, msg);
      case 'voice.start':
        return this.voiceHost.start(connId, (m) => state.conn.send(m), readVoiceModelId(msg));
      case 'voice.stop':
        return this.voiceHost.stop(connId);
      case 'terminal.list':
        return this.handleTerminalList(state, msg);
      case 'terminal.create':
        return this.handleTerminalCreate(state, msg);
      case 'terminal.subscribe':
        return this.handleTerminalSubscribe(state, msg);
      case 'terminal.input':
        return this.handleTerminalInput(state, msg);
      case 'terminal.resize':
        return this.handleTerminalResize(state, msg);
      case 'terminal.close':
        return this.handleTerminalClose(state, msg);
      case 'terminal.interrupt':
        return this.handleTerminalInterrupt(state, msg);
      case 'ping':
        // 前端心跳探活，回 pong 确认连接存活
        state.conn.send({ type: 'pong' });
        return;
      case 'insight.diagnose':
        return this.handleInsightDiagnose(state, msg);
      case 'insight.diagnose.cancel':
        return this.handleInsightDiagnoseCancel(msg);
      default:
        return;
    }
  }

  /** 广播消息到所有连接 */
  broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const state of this.states.values()) {
      state.conn.send(text);
    }
  }

  /** 发送消息到指定 session 的全部订阅连接 */
  sendToSession(sessionId: string, message: unknown): void {
    this.sendToSubscribers(sessionId, message);
  }

  /**
   * 外部发起的 run（MCP 派发 / 自动化）转发 agent 事件到 session 订阅者。
   * 与 handleTaskStream 的 sendEvent 同构：高频流式类型（assistant-text /
   * assistant-thinking / tool-call-delta）自动进合帧缓冲，其余先冲刷再发（保序）。
   * payload 形状与 task.stream 一致（{ ...event, runId }），前端 stream-buffer 可直接消费。
   */
  sendAgentEvent(sessionId: string, event: AgentEvent): void {
    this.sendEvent(sessionId, {
      type: event.type,
      sessionId,
      payload: { ...event, ...(event.runId ? { runId: event.runId } : {}) },
    });
  }

  /** 注册外部发起的活跃 run（automation 等不经 task.stream 的运行）：
   *  session.subscribe/task.switch 的 running 判定包含该 session；task.abort 可中断。
   *  若该 session 已有活跃 run，语义与 task.stream 的「打断发送」一致：旧 run 被 abort 后自行收尾 */
  registerExternalRun(sessionId: string, controller: AbortController): void {
    const prevController = this.activeRuns.get(sessionId);
    const wasRunning = prevController !== undefined;
    this.activeRuns.set(sessionId, controller);
    if (prevController && prevController !== controller) {
      prevController.abort();
    }
    // 运行态变化 → 广播（侧边栏实时转圈，刷新后也不丢）
    if (!wasRunning) this.broadcastTaskRunning(sessionId, true);
  }

  /** 注销外部活跃 run（仅当注册的 controller 仍是当前活跃 run 时移除，防误删用户新 run） */
  unregisterExternalRun(sessionId: string, controller: AbortController): void {
    if (this.activeRuns.get(sessionId) === controller) {
      this.activeRuns.delete(sessionId);
      this.activeRunIds.delete(sessionId);
      this.broadcastTaskRunning(sessionId, false);
    }
  }

  /** 该会话是否仍有任务在跑（权威运行态：含 task.stream 与外部注册的 run） */
  isSessionRunning(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  /**
   * 广播任务运行态变化（task.updated）。
   * 所有客户端（含新开的标签页）据此实时更新侧边栏转圈 / 空闲态，无需轮询或刷新。
   * task 元信息由 agent 引擎补齐；隐藏会话（subagent 等）取不到时仅发 taskId + running。
   */
  private broadcastTaskRunning(sessionId: string, running: boolean): void {
    try {
      const agent = this.services.tryResolve<AgentEngine & { getTask?: (id: string) => unknown }>(
        ServiceNames.AGENT_ENGINE,
      );
      const task = agent?.getTask?.(sessionId) ?? null;
      this.broadcast({
        type: 'task.updated',
        payload: { taskId: sessionId, running, ...(task ? { task } : {}) },
      });
    } catch {
      // 广播失败不影响任务
    }
  }

  /** 发送消息到订阅该 session 的所有活跃连接（无订阅者时静默丢弃） */
  private sendToSubscribers(sessionId: string, message: unknown): void {
    const text = JSON.stringify(message);
    for (const state of this.states.values()) {
      if (state.subscribedSessions.has(sessionId)) {
        state.conn.send(text);
      }
    }
  }

  /**
   * 发送 agent 事件：高频流式类型进合帧缓冲，其余类型先冲刷缓冲再发（保序）。
   */
  private sendEvent(sessionId: string, msg: { type: string; sessionId: string; payload: Record<string, unknown> }): void {
    if (this.batcher.isBatchable(msg.type)) {
      this.batcher.push(msg);
    } else {
      this.batcher.flush();
      this.sendToSubscribers(sessionId, msg);
    }
  }

  // ========================================================================
  // 内置消息处理
  // ========================================================================

  private async handleTaskStream(state: ConnectionState, msg: WSMessage): Promise<void> {
    const agent = this.services.tryResolve<AgentEngine>('agent.engine');
    if (!agent) {
      state.conn.send({ type: 'error', sessionId: msg.sessionId, payload: { message: ErrorCode.WS_AGENT_ENGINE_UNAVAILABLE } });
      return;
    }

    const payload = (msg.payload ?? {}) as {
      message?: string;
      /** 本轮附件绝对路径（纯路径引用；随用户消息持久化，供前端渲染卡片） */
      attachments?: string[];
      model?: string;
      cwd?: string;
      runId?: string;
      agentId?: string;
      /** 权限模式（前端 PermissionModeSelector 会话级传递）：ask/auto/skip；缺省=会话记忆/全局默认 */
      permissionMode?: 'ask' | 'auto' | 'skip';
      /** 前端为这条消息生成的稳定 id（随用户消息持久化；前端据此与本地乐观副本对齐去重） */
      clientMessageId?: string;
    };

    if (!payload.message) {
      state.conn.send({ type: 'error', sessionId: msg.sessionId, payload: { message: ErrorCode.WS_MESSAGE_REQUIRED } });
      return;
    }

    const sessionId = msg.sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    state.sessionId = sessionId;
    // 发起连接自动订阅该 session（事件按 session 路由；断连后任务继续，重连可恢复接收）
    state.subscribedSessions.add(sessionId);

    // 引导消息：可变数组引用，传给 engine.run()；handleTaskGuide 在运行期间向其 push 消息。
    // engine 在工具调用完成后检查此数组，若有内容则返回 guideInterrupt。
    let currentMessage = payload.message;
    let currentAttachments = payload.attachments;
    let currentRunId = payload.runId;
    // 本 run 对应的前端消息 id（引导续跑时由引导消息自带，保证每次 run 都写入正确身份）
    let currentClientMessageId = payload.clientMessageId;
    let currentGuideMessages: GuidanceMessage[] = [];
    this.guideMessageArrays.set(sessionId, currentGuideMessages);

    while (true) {
      // 中断控制（handler 级，与连接解耦）。同 session 发起新 run 时中止旧 run：
      // 「打断发送」语义——旧 run 的残余事件由前端 runId 过滤丢弃
      const abortController = new AbortController();
      const prevController = this.activeRuns.get(sessionId);
      const wasRunning = prevController !== undefined;
      this.activeRuns.set(sessionId, abortController);
      if (currentRunId) this.activeRunIds.set(sessionId, currentRunId);
      if (prevController) {
        prevController.abort();
      }
      // 首次进入运行态 → 广播（侧边栏实时转圈；引导续跑不重复广播）
      if (!wasRunning) this.broadcastTaskRunning(sessionId, true);

      const onEvent = (event: AgentEvent) => {
        this.sendEvent(sessionId, {
          type: event.type,
          sessionId: event.sessionId,
          payload: { ...event, runId: currentRunId },
        });
      };

      try {
        const result = await agent.run({
          sessionId,
          userMessage: currentMessage,
          attachments: currentAttachments,
          model: payload.model,
          agentId: payload.agentId,
          cwd: payload.cwd || process.cwd(),
          onEvent,
          signal: abortController.signal,
          runId: currentRunId,
          // 前端消息 id：随用户消息持久化，供前端与本地乐观副本按身份去重
          clientMessageId: currentClientMessageId,
          // 权限模式透传（会话级；缺省时 engine 回退会话记忆/全局默认）
          permissionMode: payload.permissionMode,
          // 引导消息数组（可变引用，运行期间 handleTaskGuide 可向其 push）
          guideMessages: currentGuideMessages,
        });

        // 引导中断：engine 在工具调用完成后检测到引导消息，主动中止并返回
        if (result.guideInterrupt && result.guideMessage) {
          // 移除已被 engine 消费的消息（engine 取 guideMessages[0]）——先取出其身份
          const consumedGuide = currentGuideMessages[0];
          if (currentGuideMessages.length > 0) {
            currentGuideMessages.shift();
          }
          // 发送旧 run 的 task.done，前端据此结束旧 run 的流式状态
          this.sendEvent(sessionId, {
            type: 'task.done',
            sessionId: result.sessionId,
            payload: { finishReason: 'aborted', finalText: result.finalText, runId: currentRunId },
          });
          // 取前端为引导消息生成的 runId（若无则随机）
          const runIdArr = this.guideRunIds.get(sessionId);
          currentRunId = runIdArr?.shift() ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          if (runIdArr && runIdArr.length === 0) {
            this.guideRunIds.delete(sessionId);
          }
          currentMessage = result.guideMessage;
          currentAttachments = result.guideAttachments;
          // 新 run 的消息身份：取被消费的那条引导消息自带的 id（避免沿用上一条消息的 id）
          currentClientMessageId = consumedGuide?.clientMessageId;
          // 复用同一 guideMessages 数组，剩余引导消息在新 run 中继续被检测
          continue;
        }

        // 正常完成：检查是否有迟到的引导消息（engine 最后一轮未检测到）
        if (!abortController.signal.aborted && currentGuideMessages.length > 0) {
          const guideMsg = currentGuideMessages.shift()!;
          this.sendEvent(sessionId, {
            type: 'task.done',
            sessionId: result.sessionId,
            payload: { finishReason: result.finishReason, finalText: result.finalText, runId: currentRunId },
          });
          const runIdArr = this.guideRunIds.get(sessionId);
          currentRunId = runIdArr?.shift() ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          if (runIdArr && runIdArr.length === 0) {
            this.guideRunIds.delete(sessionId);
          }
          currentMessage = guideMsg.message;
          currentAttachments = guideMsg.attachments;
          currentClientMessageId = guideMsg.clientMessageId;
          continue;
        }

        if (abortController.signal.aborted) {
          this.sendEvent(sessionId, { type: 'task.aborted', sessionId: result.sessionId, payload: { runId: currentRunId } });
        } else {
          this.sendEvent(sessionId, {
            type: 'task.done',
            sessionId: result.sessionId,
            payload: {
              finishReason: result.finishReason,
              finalText: result.finalText,
              runId: currentRunId,
            },
          });
        }
        break;
      } catch (err) {
        if (abortController.signal.aborted) {
          this.sendEvent(sessionId, { type: 'task.aborted', sessionId, payload: { runId: currentRunId } });
        } else {
          this.sendEvent(sessionId, {
            type: 'error',
            sessionId,
            payload: { message: err instanceof Error ? err.message : String(err), runId: currentRunId },
          });
        }
        break;
      } finally {
        // 仅当当前记录的仍是自己时才清除，避免误清新流的 controller
        if (this.activeRuns.get(sessionId) === abortController) {
          this.activeRuns.delete(sessionId);
          // 同步清 runId：否则 run 正常结束后 sessionSnapshot 仍向重连客户端
          // 返回已结束的旧 runId（前端事件隔离对齐被污染）
          this.activeRunIds.delete(sessionId);
        }
        // 冲净残余缓冲（保序收尾）
        this.batcher.flush();
      }
    }

    // while 结束 = 本次运行收尾；若期间没有新 run 顶替则广播空闲态
    // （放在循环外：引导续跑会 continue，避免每次续跑都抖动一次运行态广播）
    this.broadcastTaskRunning(sessionId, this.activeRuns.has(sessionId));

    // 清理引导消息相关状态
    this.guideMessageArrays.delete(sessionId);
    this.guideRunIds.delete(sessionId);
  }

  /**
   * 处理引导模式消息：将消息推入当前 run 的 guideMessages 数组。
   * engine 在工具调用完成后检查此数组，若有内容则中止当前 run 并返回 guideInterrupt，
   * 随后 handleTaskStream 的 while 循环自动用引导消息启动新 run。
   */
  private handleTaskGuide(_state: ConnectionState, msg: WSMessage): void {
    const sessionId = msg.sessionId;
    if (!sessionId) return;

    const payload = (msg.payload ?? {}) as {
      message?: string;
      runId?: string;
      attachments?: string[];
      /** 前端为这条引导消息生成的稳定 id（续跑的 run 持久化时写入） */
      clientMessageId?: string;
    };
    if (!payload.message) return;

    const guideArr = this.guideMessageArrays.get(sessionId);
    if (guideArr !== undefined) {
      guideArr.push({
        message: payload.message,
        attachments: payload.attachments,
        ...(payload.clientMessageId ? { clientMessageId: payload.clientMessageId } : {}),
      });
      if (payload.runId) {
        const runIds = this.guideRunIds.get(sessionId) ?? [];
        runIds.push(payload.runId);
        this.guideRunIds.set(sessionId, runIds);
      }
    } else {
      this.logger.warn(`Guide message received but no active run for session ${sessionId}`);
    }
  }

  private handleTaskAbort(_state: ConnectionState, msg: WSMessage): void {
    const controller = this.activeRuns.get(msg.sessionId ?? '');
    if (controller) {
      controller.abort();
      this.logger.info(t('server.taskAborted', { sessionId: msg.sessionId ?? '' }));
    }
  }

  /**
   * AI 诊断（链路式流式）：不落会话消息，事件仅回本连接。
   * 前端按 requestId 订阅 insight.diagnose.event；kind=cause/harness/resource 各为一次独立生成。
   */
  private handleInsightDiagnose(state: ConnectionState, msg: WSMessage): void {
    const payload = (msg.payload ?? {}) as {
      requestId?: string;
      kind?: InsightKind;
      sessionId?: string;
      providerError?: string;
    };
    const requestId = payload.requestId;
    const kind = payload.kind;
    if (!requestId || (kind !== 'cause' && kind !== 'harness' && kind !== 'resource')) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_MESSAGE_REQUIRED } });
      return;
    }
    // 同一 requestId 重复发起：中止旧流
    this.insightRuns.get(requestId)?.abort();
    const controller = new AbortController();
    this.insightRuns.set(requestId, controller);

    const emit = (e: InsightEvent): void => {
      state.conn.send({ type: 'insight.diagnose.event', payload: e });
    };

    void runInsightDiagnose(
      { services: this.services, env: this.env, logger: this.logger },
      {
        requestId,
        kind,
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        ...(payload.providerError ? { providerError: payload.providerError } : {}),
      },
      emit,
      controller.signal,
    ).finally(() => {
      // 仅当仍为本次请求时清理（避免被同 id 新请求覆盖后误删）
      if (this.insightRuns.get(requestId) === controller) {
        this.insightRuns.delete(requestId);
      }
    });
  }

  /** 取消 AI 诊断（前端关闭弹窗） */
  private handleInsightDiagnoseCancel(msg: WSMessage): void {
    const requestId = ((msg.payload ?? {}) as { requestId?: string }).requestId;
    if (!requestId) return;
    const controller = this.insightRuns.get(requestId);
    if (controller) {
      controller.abort();
      this.insightRuns.delete(requestId);
    }
  }

  /**
   * 会话状态快照：订阅 / task.switch 的回复载荷（与 GET /api/session/:id/state 同构）。
   * - running：权威运行态（含外部注册的 run：automation / MCP）
   * - runId：当前 run（前端事件隔离对齐）
   * - totalMessages / newestIndex：消息总数与最新游标（前端判断是否需要尾部补齐）
   * - liveDraft：进行中的流式草稿（含 messageId + 内容长度，前端据此续接 offset）
   */
  private sessionSnapshot(sessionId: string): Record<string, unknown> {
    const agent = this.services.tryResolve<
      AgentEngine & {
        getHistoryPage?: (id: string, opts?: { limit?: number }) => { total: number; newestIndex: number } | undefined;
        getLiveDraft?: (id: string) => unknown;
      }
    >(ServiceNames.AGENT_ENGINE);
    let total = 0;
    let newestIndex = -1;
    try {
      const page = agent?.getHistoryPage?.(sessionId, { limit: 1 });
      total = page?.total ?? 0;
      newestIndex = page?.newestIndex ?? -1;
    } catch {
      // 会话不存在 / 引擎异常：返回空态
    }
    let liveDraft: unknown = null;
    try {
      liveDraft = agent?.getLiveDraft?.(sessionId) ?? null;
    } catch {
      liveDraft = null;
    }
    const runId = this.activeRunIds.get(sessionId);
    return {
      running: this.activeRuns.has(sessionId),
      ...(runId ? { runId } : {}),
      totalMessages: total,
      newestIndex,
      ...(liveDraft ? { liveDraft } : {}),
    };
  }

  private handleSessionSubscribe(state: ConnectionState, msg: WSMessage): void {
    if (msg.sessionId) {
      state.sessionId = msg.sessionId;
      state.subscribedSessions.add(msg.sessionId);
      // 状态快照先行（同步发送，先于后续任何合帧冲刷）：
      // running 权威运行态 + 最新 index 游标 + 进行中的流式草稿。
      // 前端据此恢复「运行中」标记与半截回复，并按 offset 无缝续接后续分片。
      state.conn.send({
        type: 'session.subscribed',
        sessionId: msg.sessionId,
        payload: this.sessionSnapshot(msg.sessionId),
      });

      // WS 重连恢复 pending asks：查询该 session 的待答列表，逐条发送 ask 事件（携带完整提问载荷），
      // 前端 useWebSocket 的 ask 处理器会将其加入 store.pendingAsks。
      const agent = this.services.tryResolve<AgentEngine & {
        getPendingAsks?: (sessionId: string) => Array<{
          toolCallId: string;
          sessionId: string;
          payload: { questions: Array<{ id: string; question: string; answerType?: string; options?: Array<{ value: string; label: string; description?: string }>; defaultAnswer?: string; formSchema?: Record<string, unknown>; attachments?: string[] }> };
        }>;
        getPendingConfirms?: (sessionId: string) => Array<{
          toolCallId: string;
          sessionId: string;
          question: string;
          ruleSuggestion?: string;
        }>;
      }>('agent.engine');
      const asks = agent?.getPendingAsks?.(msg.sessionId) ?? [];
      for (const ask of asks) {
        state.conn.send({
          type: 'ask',
          sessionId: ask.sessionId,
          payload: {
            type: 'ask',
            sessionId: ask.sessionId,
            toolCallId: ask.toolCallId,
            questions: ask.payload.questions,
          },
        });
      }
      // WS 重连恢复 pending confirms：查询该 session 的待确认列表，逐条发送 confirm-required 事件（含规则建议）
      const confirms = agent?.getPendingConfirms?.(msg.sessionId) ?? [];
      for (const cf of confirms) {
        state.conn.send({
          type: 'confirm-required',
          sessionId: cf.sessionId,
          payload: {
            type: 'confirm-required',
            sessionId: cf.sessionId,
            toolCallId: cf.toolCallId,
            toolName: '',
            question: cf.question,
            ruleSuggestion: cf.ruleSuggestion,
          },
        });
      }
    }
  }

  /** 处理前端对 ask 工具的回复（accept=结构化回答 / cancel=取消提问） */
  private handleAskReply(state: ConnectionState, msg: WSMessage): void {
    const agent = this.services.tryResolve<AgentEngine>('agent.engine');
    if (!agent) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_AGENT_ENGINE_UNAVAILABLE } });
      return;
    }
    const payload = (msg.payload ?? {}) as {
      toolCallId?: string;
      action?: 'accept' | 'cancel';
      /** 逐题回答（answers[i] 与 toolCall 的 questions[i] 按下标对齐） */
      answers?: Array<{
        selectedValues?: string[];
        selectedLabels?: string[];
        editedLabels?: Record<string, string>;
        otherText?: string;
        text?: string;
        form?: Record<string, string | number | boolean>;
        attachments?: string[];
      }>;
      /** @deprecated 单题兼容：旧前端只回传 answer */
      answer?: {
        selectedValues?: string[];
        selectedLabels?: string[];
        editedLabels?: Record<string, string>;
        otherText?: string;
        text?: string;
        form?: Record<string, string | number | boolean>;
        attachments?: string[];
      };
    };
    if (!payload.toolCallId || (payload.action !== 'accept' && payload.action !== 'cancel')) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_TOOLCALLID_ANSWER_REQUIRED } });
      return;
    }
    // 兼容旧前端：仅回传 answer → 归一化为 answers[0]
    const answers = payload.answers ?? (payload.answer ? [payload.answer] : undefined);
    if (payload.action === 'accept' && (!answers || answers.length === 0)) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_TOOLCALLID_ANSWER_REQUIRED } });
      return;
    }
    // 会话 ID 必填：pending ask 以 session+toolCallId 为键，缺失时不匹配任何会话
    const ok = msg.sessionId
      ? agent.resolveAsk(msg.sessionId, payload.toolCallId, {
          action: payload.action,
          ...(payload.action === 'accept' && answers ? { answers } : {}),
        })
      : false;
    if (!ok) {
      state.conn.send({
        type: 'error',
        payload: { message: ErrorCode.WS_NO_PENDING_ASK },
      });
      return;
    }
    state.conn.send({ type: 'tool.ask.accepted', sessionId: msg.sessionId, toolCallId: payload.toolCallId });
  }

  /** 处理前端对 confirm 确认的回复 */
  private handleConfirmReply(state: ConnectionState, msg: WSMessage): void {
    const agent = this.services.tryResolve<AgentEngine>('agent.engine');
    if (!agent) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_AGENT_ENGINE_UNAVAILABLE } });
      return;
    }
    const payload = (msg.payload ?? {}) as { toolCallId?: string; ok?: boolean; remember?: 'session' | 'global' };
    if (!payload.toolCallId || typeof payload.ok !== 'boolean') {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_TOOLCALLID_ANSWER_REQUIRED } });
      return;
    }
    const ok = msg.sessionId
      ? agent.resolveConfirm(msg.sessionId, payload.toolCallId, payload.ok, payload.remember)
      : false;
    if (!ok) {
      state.conn.send({
        type: 'error',
        payload: { message: ErrorCode.WS_NO_PENDING_ASK },
      });
      return;
    }
    state.conn.send({ type: 'tool.confirm.accepted', sessionId: msg.sessionId, toolCallId: payload.toolCallId });
  }

  /**
   * 阶段5.2：处理 task.create 入站消息。
   * 调 agent.createTask 创建任务，返回 task.created。
   * TaskItem.id 即 sessionId（计划假设3），前端可直接用该 id 订阅 session。
   */
  private handleTaskCreate(state: ConnectionState, msg: WSMessage): void {
    const agent = this.services.tryResolve<AgentEngine & {
      createTask?: (title: string, groupId?: string, id?: string) => unknown;
    }>(ServiceNames.AGENT_ENGINE);
    if (!agent?.createTask) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_CREATE_TASK_UNAVAILABLE } });
      return;
    }
    const payload = (msg.payload ?? {}) as { title?: string; groupId?: string; id?: string };
    if (!payload.title || typeof payload.title !== 'string') {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_TITLE_REQUIRED } });
      return;
    }
    try {
      const task = agent.createTask(payload.title, payload.groupId, payload.id);
      state.conn.send({ type: 'task.created', payload: { task } });
      this.logger.info(t('server.taskCreatedViaWs', { id: (task as { id?: string }).id ?? '' }));
    } catch (err) {
      state.conn.send({
        type: 'error',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * 阶段5.2：处理 task.switch 入站消息。
   * 设置 state.sessionId 为 task 对应 sessionId，返回 session.subscribed。
   * TaskItem.id 即 sessionId（计划假设3）。
   */
  private handleTaskSwitch(state: ConnectionState, msg: WSMessage): void {
    const payload = (msg.payload ?? {}) as { taskId?: string };
    const taskId = payload.taskId ?? msg.sessionId;
    if (!taskId) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_TASK_ID_REQUIRED } });
      return;
    }
    state.sessionId = taskId;
    state.subscribedSessions.add(taskId);
    state.conn.send({
      type: 'session.subscribed',
      sessionId: taskId,
      payload: this.sessionSnapshot(taskId),
    });
    this.logger.debug(t('server.wsTaskSwitched', { id: taskId }));
  }

  /**
   * 阶段5.2：处理 automation.run 入站消息。
   * 调 automation.trigger(id)，返回 automation.started。
   * automation 模块未加载时返回 error。
   */
  private handleAutomationRun(state: ConnectionState, msg: WSMessage): void {
    const automation = this.services.tryResolve<AutomationService>(ServiceNames.AUTOMATION_SERVICE);
    if (!automation) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_AUTOMATION_SERVICE_UNAVAILABLE } });
      return;
    }
    const payload = (msg.payload ?? {}) as { automationId?: string };
    if (!payload.automationId) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_AUTOMATION_ID_REQUIRED } });
      return;
    }
    try {
      const { runId } = automation.trigger(payload.automationId);
      state.conn.send({
        type: 'automation.started',
        payload: { automationId: payload.automationId, runId },
      });
      this.logger.info(t('server.automationTriggeredWs', { id: payload.automationId, runId }));
    } catch (err) {
      state.conn.send({
        type: 'error',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // ========================================================================
  // 终端（持久 PTY）：人类交互入口；输出经 TerminalService 的 emitter 按会话广播
  // ========================================================================

  private terminalService(): TerminalService | null {
    return this.services.tryResolve<TerminalService>(ServiceNames.TERMINAL);
  }

  /**
   * Windows ConPTY 兼容信息：xterm 的 `windowsPty` 启发式仅在提供 buildNumber 时生效
   * （缺 buildNumber 会静默退回「reflow 启用」的错误默认，正是终端回显错乱/重复的根因）。
   * 非 Windows 或解析失败 → 不下发（保持原行为）。
   */
  private ptyBackendInfo(): { backend: 'conpty'; buildNumber: number } | undefined {
    if (!this.env.isWindows) return undefined;
    const build = Number(release().split('.')[2]);
    return Number.isFinite(build) ? { backend: 'conpty', buildNumber: build } : undefined;
  }

  /** 列出会话终端（连接先订阅该会话，保证后续 terminal.data 可达） */
  private handleTerminalList(state: ConnectionState, msg: WSMessage): void {
    const sessionId = msg.sessionId ?? state.sessionId ?? '';
    if (sessionId) state.subscribedSessions.add(sessionId);
    const svc = this.terminalService();
    const terminals = svc ? svc.list(sessionId) : [];
    const ptyBackend = this.ptyBackendInfo();
    state.conn.send({
      type: 'terminal.list',
      sessionId,
      // ptyBackend 与终端列表同帧到达 → 前端创建 xterm 前即可拿到 windowsPty 参数
      payload: { sessionId, terminals, ...(ptyBackend ? { ptyBackend } : {}) },
    });
  }

  private async handleTerminalCreate(state: ConnectionState, msg: WSMessage): Promise<void> {
    const svc = this.terminalService();
    if (!svc) {
      state.conn.send({ type: 'error', sessionId: msg.sessionId, payload: { message: t('terminal.moduleInitialized') } });
      return;
    }
    const payload = (msg.payload ?? {}) as {
      sessionId?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
      title?: string;
      interpreter?: InterpreterKind;
      creator?: 'user' | 'ai';
    };
    const sessionId = payload.sessionId ?? msg.sessionId ?? state.sessionId ?? '';
    if (!sessionId) {
      state.conn.send({ type: 'error', payload: { message: ErrorCode.WS_TASK_ID_REQUIRED } });
      return;
    }
    // 先订阅该会话：terminal.created / terminal.data 才能路由到本连接
    state.subscribedSessions.add(sessionId);
    try {
      await svc.create({
        sessionId,
        cwd: payload.cwd,
        cols: payload.cols,
        rows: payload.rows,
        title: payload.title,
        interpreter: payload.interpreter,
        // 前端创建一律视为人类来源（AI 经 terminal 工具创建，自带 creator='ai'）
        creator: payload.creator === 'ai' ? 'ai' : 'user',
      });
      // terminal.created 由 TerminalService 的 emitter 广播（本连接已订阅）
    } catch (err) {
      state.conn.send({
        type: 'error',
        sessionId,
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** 订阅单个终端：先按客户端当前网格校正 PTY/镜像尺寸，再回送快照（避免前端按旧尺寸 reflow） */
  private async handleTerminalSubscribe(state: ConnectionState, msg: WSMessage): Promise<void> {
    const payload = (msg.payload ?? {}) as { terminalId?: string; cols?: number; rows?: number };
    const terminalId = payload.terminalId;
    const svc = this.terminalService();
    if (!svc || !terminalId) return;
    const { cols, rows } = payload;
    // 客户端带上当前 xterm 网格：先 resize 再序列化 → 快照与前端屏幕同尺寸，reset+write 不再触发重排
    if (
      typeof cols === 'number' &&
      typeof rows === 'number' &&
      Number.isFinite(cols) &&
      Number.isFinite(rows) &&
      cols > 0 &&
      rows > 0
    ) {
      svc.resize(terminalId, cols, rows);
    }
    const data = await svc.snapshotAsync(terminalId);
    if (data !== undefined) {
      state.conn.send({ type: 'terminal.snapshot', payload: { terminalId, data } });
    }
  }

  private handleTerminalInput(state: ConnectionState, msg: WSMessage): void {
    const payload = (msg.payload ?? {}) as { terminalId?: string; data?: string };
    if (!payload.terminalId || typeof payload.data !== 'string') return;
    this.terminalService()?.write(payload.terminalId, payload.data);
  }

  private handleTerminalResize(_state: ConnectionState, msg: WSMessage): void {
    const payload = (msg.payload ?? {}) as { terminalId?: string; cols?: number; rows?: number };
    const { terminalId, cols, rows } = payload;
    if (!terminalId || typeof cols !== 'number' || typeof rows !== 'number') return;
    // 边界校验：NaN/Infinity/非正数会被 clamp 原样带进 PTY（NaN 会让 pty.resize 传 NaN）
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    this.terminalService()?.resize(terminalId, cols, rows);
  }

  private handleTerminalClose(_state: ConnectionState, msg: WSMessage): void {
    const payload = (msg.payload ?? {}) as { terminalId?: string };
    if (!payload.terminalId) return;
    this.terminalService()?.close(payload.terminalId);
  }

  /** 停止单条命令：按 toolCallId 找到登记终端并发送 Ctrl+C */
  private handleTerminalInterrupt(_state: ConnectionState, msg: WSMessage): void {
    const payload = (msg.payload ?? {}) as { toolCallId?: string };
    if (!payload.toolCallId) return;
    this.terminalService()?.interruptRun(payload.toolCallId);
  }
}