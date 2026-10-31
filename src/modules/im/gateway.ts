// src/modules/im/gateway.ts
// 入站网关：绑定准入 → 命令 → 待答交互 → 去重 → 一聊天一任务 → agent.run → 回复。
// 交互消息（权限/提问/确认/Todo）以文本 + 数字序号形式往返，适配全部 IM 渠道。

import { t } from '../../core/i18n';
import type { Logger, ServiceRegistry } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine, AgentEvent } from '../contracts';
import { SYSTEM_SCOPE } from '../filesys/roots';
import type { ServerInstance } from '../server/types';
import type { AgentRegistry } from '../subagent/types';
import { getSessionTodoPathFromDir, readSessionTodoStore } from '../tools/todo/shared/store';
import type { AskAnswer } from '../tools/types';
import {
  InteractionManager,
  parseChoice,
  parseFormAnswer,
  renderAskQuestion,
  renderConfirm,
  renderPermissionMenu,
  renderTodoList,
  todoSignature,
  type PendingInteraction,
} from './interaction';
import { formatSubagentProgress, formatToolProgress, parseToolArguments, type SubagentEntry } from './progress';
import type { ImStateStore } from './state';
import type { ImBotOptions, ImInboundMessage, ImReplyTarget, StoredImBot } from './types';
import { prepareOutbound } from './render';
import { buildPromptWithAttachments, stageAttachments } from './attachments';
import { takeMedia } from './segments';

const IM_GROUP_NAME = 'IM 连接';

/** 权限菜单序号 → 权限模式（首次选择后写回 bots.json） */
const PERMISSION_MODES = ['auto', 'skip', 'ask'] as const;

/** 同一批并发子智能体的合并窗口：同一步骤的 executing 事件在同一 tick 内连续发出 */
const SUBAGENT_MERGE_WINDOW_MS = 20;

/**
 * 单个 Agent 运行的过程播报状态（key = botId:conversationKey）。
 * toolCalls 累积流式参数；queue 保证多条播报按序发送。
 */
interface ProgressState {
  cwd: string;
  toolCalls: Map<string, { name: string; argsText: string }>;
  subagents: SubagentEntry[];
  subagentTimer: ReturnType<typeof setTimeout> | null;
  queue: Promise<void>;
}

/** tool-call-start 的 args 可能是空串、对象或 undefined：统一成参数文本 */
function argumentsTextOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

/** 网关闭环依赖（由 controller 注入，避免 gateway ↔ controller 循环引用） */
export interface ImGatewayDeps {
  logger: Logger;
  services: ServiceRegistry;
  state: ImStateStore;
  server: ServerInstance | null;
  /** MOSS 数据目录（附件暂存根：~/.moss/im/inbound） */
  dataDir: string;
  /** 通过指定机器人的适配器发送文本（分段由 gateway 负责） */
  sendText(bot: StoredImBot, target: ImReplyTarget, text: string): Promise<void>;
  /** 切换该会话的「正在输入」状态（失败不影响主流程） */
  setTyping(bot: StoredImBot, target: ImReplyTarget, active: boolean): Promise<void>;
  /** 渠道是否支持 markdown（决定是否做纯文本化） */
  supportsMarkdown(bot: StoredImBot): boolean;
  /** 渠道展示名（用于任务标题） */
  channelLabel(bot: StoredImBot): string;
  /** 读取最新机器人配置（权限写回后即时生效） */
  getBot(botId: string): StoredImBot | null;
  /** 合并机器人运行参数并持久化 */
  updateBotOptions(botId: string, patch: Partial<ImBotOptions>): Promise<unknown>;
}

/** 帮助文案（交互能力随渠道统一） */
function helpText(): string {
  return [
    '可用命令：',
    '/help 显示本帮助',
    '/new 开始新任务（清空当前对话上下文）',
    '/stop 停止当前任务',
    '/bind <6位配对码> 绑定此账号',
    '',
    '直接发送消息，MOSS 就会开始执行任务。',
    '权限选择、Agent 提问、工具确认与 Todo 清单都会以消息发送，回复数字（1/2/3…）即可选择。',
  ].join('\n');
}

export class ImGateway {
  private readonly deps: ImGatewayDeps;
  private readonly running = new Map<string, AbortController>();
  /** 待答交互队列（key = botId:conversationKey） */
  private readonly interactions = new InteractionManager();
  /** 每个聊天最近一次推送的 Todo 签名（避免重复刷屏） */
  private readonly todoSignatures = new Map<string, string>();
  /** 每个聊天的运行代际：异步回调必须持有当前代际才能重新点亮「正在输入」 */
  private readonly runEpochs = new Map<string, number>();
  /** 每个在跑任务的过程播报状态（key = botId:conversationKey） */
  private readonly progressStates = new Map<string, ProgressState>();
  private groupId: string | null = null;

  constructor(deps: ImGatewayDeps) {
    this.deps = deps;
  }

  /** 模块销毁时中断全部在跑的 IM 任务 */
  abortAll(): void {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    for (const key of [...this.progressStates.keys()]) this.discardProgress(key);
  }

  /** 正在输入是表现层能力：失败只记录，不阻塞任务与消息投递 */
  private fireTyping(bot: StoredImBot, target: ImReplyTarget, active: boolean): void {
    void this.deps.setTyping(bot, target, active).catch(error => {
      this.deps.logger.debug('im: 正在输入状态切换失败', {
        botId: bot.botId,
        active,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private beginRunEpoch(key: string): number {
    const next = this.currentRunEpoch(key) + 1;
    this.runEpochs.set(key, next);
    return next;
  }

  private currentRunEpoch(key: string): number {
    return this.runEpochs.get(key) ?? 0;
  }

  private invalidateRunEpoch(key: string): void {
    this.runEpochs.set(key, this.currentRunEpoch(key) + 1);
  }

  /**
   * 重新点亮正在输入后会再校验一次代际：若运行已结束（最终答案/错误/停止），
   * 立即补一次停止，避免 Todo 等异步任务在收尾后把 QQ 三点气泡重新点亮。
   */
  private startTypingGuarded(
    bot: StoredImBot,
    key: string,
    target: ImReplyTarget,
    epoch: number,
  ): void {
    const stale = (): boolean => !this.running.has(key) || this.currentRunEpoch(key) !== epoch;
    if (stale()) return;
    void this.deps.setTyping(bot, target, true)
      .catch(error => {
        this.deps.logger.debug('im: 正在输入状态切换失败', {
          botId: bot.botId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => {
        // 只有会话确实没有活动 run 时才补停止；若新 run 已开始则保持其正在输入
        if (!this.running.has(key)) this.fireTyping(bot, target, false);
      });
  }

  /** 只有该会话仍有未中断的运行任务时才恢复正在输入（提问/确认等待结束后调用） */
  private resumeTyping(bot: StoredImBot, key: string, target: ImReplyTarget): void {
    const controller = this.running.get(key);
    const epoch = this.currentRunEpoch(key);
    if (!controller || controller.signal.aborted || epoch <= 0) return;
    this.startTypingGuarded(bot, key, target, epoch);
  }

  private async replyAndResumeTyping(
    bot: StoredImBot,
    key: string,
    target: ImReplyTarget,
    text: string,
  ): Promise<void> {
    await this.reply(bot, target, text);
    this.resumeTyping(bot, key, target);
  }

  /** 处理一条已归一化的入站消息（去重在此统一完成） */
  handle(bot: StoredImBot, message: ImInboundMessage): void {
    if (!bot.enabled) return;
    if (this.deps.state.hasSeen(bot.botId, message.messageId)) return;
    this.deps.state.markSeen(bot.botId, message.messageId);

    const bound = this.deps.state.isBound(bot.botId, message.senderId);
    const text = message.text.trim();

    // 未绑定：仅私聊允许用配对码完成绑定
    if (!bound) {
      if (message.kind === 'direct' && /^\/bind\s+\d{6}$/i.test(text)) {
        const code = text.replace(/^\/bind\s+/i, '').trim();
        if (code !== bot.pairingCode) {
          void this.reply(bot, message.replyTarget, '配对码不正确，请在 MOSS 设置页「IM 连接」中查看当前配对码。');
          return;
        }
        this.deps.state.bind(bot.botId, {
          id: message.senderId,
          name: message.senderName,
          boundAt: new Date().toISOString(),
        });
        void this.reply(bot, message.replyTarget, '绑定成功。现在可以直接发消息给 MOSS 派活；发送 /help 查看命令。');
        return;
      }
      if (message.kind === 'direct') {
        void this.reply(bot, message.replyTarget, '该账号尚未绑定。请在 MOSS 设置页「IM 连接」查看配对码，然后发送 /bind <配对码>。');
      }
      return;
    }

    // 群聊：默认只处理 @机器人 的消息
    if (message.kind === 'group' && bot.options.groupTrigger === 'mention' && !message.addressed) return;

    if (!text && takeMedia(message.segments).length === 0) {
      void this.reply(bot, message.replyTarget, '目前只支持文字、图片和文件消息。');
      return;
    }

    if (text.startsWith('/')) {
      this.handleCommand(bot, message, text);
      return;
    }

    // 有待答交互时，数字/文本回复优先用于回答，不触发新任务
    if (this.handleInteraction(bot, message, text)) return;

    void this.runTask(bot, message, text);
  }

  // ---------------------------------------------------------------- 命令

  private handleCommand(bot: StoredImBot, message: ImInboundMessage, text: string): void {
    const [command] = text.split(/\s+/);
    const key = `${bot.botId}:${message.conversationKey}`;
    switch (command.toLowerCase()) {
      case '/help':
        void this.reply(bot, message.replyTarget, helpText(), { keepTyping: this.running.has(key) });
        return;
      case '/bind':
        void this.reply(bot, message.replyTarget, '该账号已经绑定，无需重复绑定。', {
          keepTyping: this.running.has(key),
        });
        return;
      case '/new': {
        if (this.running.has(key)) {
          void this.reply(bot, message.replyTarget, '当前任务还在执行，请先 /stop 再开新任务。', {
            keepTyping: true,
          });
          return;
        }
        this.deps.state.clearConversation(key);
        this.interactions.clear(key);
        this.todoSignatures.delete(key);
        this.discardProgress(key);
        void this.reply(bot, message.replyTarget, '已开启新会话。请发送你的问题。');
        return;
      }
      case '/stop': {
        const controller = this.running.get(key);
        if (!controller) {
          void this.reply(bot, message.replyTarget, '当前没有正在执行的任务。');
          return;
        }
        this.interactions.clear(key);
        controller.abort();
        void this.reply(bot, message.replyTarget, '已停止当前任务。');
        return;
      }
      default:
        void this.reply(bot, message.replyTarget, `未知命令：${command}\n\n${helpText()}`, {
          keepTyping: this.running.has(key),
        });
    }
  }

  // ---------------------------------------------------------------- 交互

  private engine(): AgentEngine | null {
    return this.deps.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
  }

  /** 消费待答交互；返回 true 表示本条消息已被交互消费 */
  private handleInteraction(bot: StoredImBot, message: ImInboundMessage, text: string): boolean {
    const key = `${bot.botId}:${message.conversationKey}`;
    const pending = this.interactions.peek(key);
    if (!pending) return false;
    if (pending.kind === 'permission') {
      void this.applyPermissionChoice(bot, message, pending, text);
      return true;
    }
    if (pending.kind === 'confirm') {
      void this.applyConfirmChoice(bot, message, pending, text);
      return true;
    }
    void this.applyAskAnswer(bot, message, pending, text);
    return true;
  }

  /** 首次权限选择：写回 bots.json 后立即执行暂存任务 */
  private async applyPermissionChoice(
    bot: StoredImBot,
    message: ImInboundMessage,
    pending: Extract<PendingInteraction, { kind: 'permission' }>,
    text: string,
  ): Promise<void> {
    const key = `${bot.botId}:${message.conversationKey}`;
    const choice = parseChoice(text, PERMISSION_MODES.length, 'single');
    if (choice === null || choice === 'cancel') {
      await this.reply(bot, message.replyTarget, t('im.interaction.permissionInvalid'));
      return;
    }
    const mode = PERMISSION_MODES[choice[0]! - 1]!;
    this.interactions.shift(key);
    await this.deps.updateBotOptions(bot.botId, { permissionMode: mode });
    const label = t(`im.interaction.permissionLabel.${mode}`);
    await this.reply(bot, message.replyTarget, t('im.interaction.permissionSaved', { label }));
    const latest = this.deps.getBot(bot.botId) ?? bot;
    await this.runTask(latest, pending.task, pending.task.text);
  }

  /** 工具确认：1 允许 / 2 拒绝 / 3 本会话始终允许 */
  private async applyConfirmChoice(
    bot: StoredImBot,
    message: ImInboundMessage,
    pending: Extract<PendingInteraction, { kind: 'confirm' }>,
    text: string,
  ): Promise<void> {
    const key = `${bot.botId}:${message.conversationKey}`;
    const choice = parseChoice(text, 3, 'single');
    if (choice === null) {
      await this.reply(bot, message.replyTarget, t('im.interaction.confirmInvalid'));
      return;
    }
    const engine = this.engine();
    if (!engine) {
      await this.reply(bot, message.replyTarget, t('im.interaction.engineUnavailable'));
      return;
    }
    const index = choice === 'cancel' ? 2 : choice[0]!;
    const ok = index === 1 || index === 3;
    this.interactions.shift(key);
    const resolved = engine.resolveConfirm(pending.sessionId, pending.toolCallId, ok, index === 3 ? 'session' : undefined);
    await this.reply(
      bot,
      message.replyTarget,
      resolved
        ? (ok ? t('im.interaction.confirmAllowed') : t('im.interaction.confirmDenied'))
        : t('im.interaction.confirmExpired'),
    );
    // 请求已失效（超时/其他端处理）时不再点亮「正在输入」
    if (resolved) this.resumeTyping(bot, key, message.replyTarget);
  }

  /** ask 逐题回答：答完一题自动发下一题，全部完成回传引擎 */
  private async applyAskAnswer(
    bot: StoredImBot,
    message: ImInboundMessage,
    pending: Extract<PendingInteraction, { kind: 'ask' }>,
    text: string,
  ): Promise<void> {
    const key = `${bot.botId}:${message.conversationKey}`;
    const question = pending.questions[pending.index];
    if (!question) {
      this.interactions.shift(key);
      return;
    }
    const type = question.answerType ?? 'text';
    let answer: AskAnswer | null = null;

    if (type === 'text') {
      answer = { text: text.trim() };
    } else if (type === 'form') {
      const form = parseFormAnswer(text);
      if (!form) {
        await this.reply(bot, message.replyTarget, t('im.interaction.askFormInvalid'));
        return;
      }
      answer = { form };
    } else {
      const count = type === 'boolean' ? 2 : (question.options?.length ?? 0);
      const choice = parseChoice(text, count, type === 'multi' ? 'multi' : 'single');
      if (choice === null) {
        if (type === 'boolean') {
          await this.reply(bot, message.replyTarget, t('im.interaction.askInvalid'));
          return;
        }
        // 选择题：非序号文本 = 用户直接填写「其他」答案
        const other = text.trim();
        if (!other) {
          await this.reply(bot, message.replyTarget, t('im.interaction.askInvalid'));
          return;
        }
        answer = { otherText: other };
      } else if (choice === 'cancel') {
        this.interactions.shift(key);
        this.engine()?.resolveAsk(pending.sessionId, pending.toolCallId, { action: 'cancel' });
        await this.reply(bot, message.replyTarget, t('im.interaction.askCancelled'));
        this.resumeTyping(bot, key, message.replyTarget);
        return;
      } else if (type === 'boolean') {
        const yes = choice[0] === 1;
        answer = {
          selectedValues: [yes ? 'yes' : 'no'],
          selectedLabels: [yes ? t('im.interaction.yes') : t('im.interaction.no')],
        };
      } else {
        const options = question.options ?? [];
        const picked = choice
          .map(index => options[index - 1])
          .filter((option): option is NonNullable<typeof option> => Boolean(option));
        answer = {
          selectedValues: picked.map(option => option.value),
          selectedLabels: picked.map(option => option.label),
        };
      }
    }

    if (!answer) return;
    pending.answers.push(answer);
    pending.index += 1;

    if (pending.index < pending.questions.length) {
      await this.reply(
        bot,
        message.replyTarget,
        renderAskQuestion(pending.questions[pending.index]!, pending.index, pending.questions.length),
      );
      return;
    }

    this.interactions.shift(key);
    const engine = this.engine();
    if (!engine) {
      await this.reply(bot, message.replyTarget, t('im.interaction.engineUnavailable'));
      return;
    }
    const resolved = engine.resolveAsk(pending.sessionId, pending.toolCallId, { action: 'accept', answers: pending.answers });
    await this.reply(bot, message.replyTarget, resolved ? t('im.interaction.askAccepted') : t('im.interaction.askExpired'));
    // 请求已失效（超时/其他端回答）时不再点亮「正在输入」
    if (resolved) this.resumeTyping(bot, key, message.replyTarget);
  }

  /** Agent 事件 → IM 消息（仅处理主会话；子代理事件忽略） */
  private observeEvent(
    bot: StoredImBot,
    key: string,
    message: ImInboundMessage,
    sessionId: string,
    event: AgentEvent,
  ): void {
    if (event.sessionId !== sessionId) return;
    this.trackProgress(key, bot, message.replyTarget, event);
    switch (event.type) {
      case 'ask': {
        const first = event.questions[0];
        this.interactions.enqueue(key, {
          kind: 'ask',
          sessionId,
          toolCallId: event.toolCallId,
          questions: event.questions,
          index: 0,
          answers: [],
        });
        if (first) void this.reply(bot, message.replyTarget, renderAskQuestion(first, 0, event.questions.length));
        return;
      }
      case 'ask-timeout': {
        this.interactions.removeByToolCall(key, event.toolCallId);
        void this.replyAndResumeTyping(bot, key, message.replyTarget, t('im.interaction.askTimeout'));
        return;
      }
      case 'confirm-required': {
        this.interactions.enqueue(key, { kind: 'confirm', sessionId, toolCallId: event.toolCallId });
        void this.reply(bot, message.replyTarget, renderConfirm(event.toolName, event.question));
        return;
      }
      case 'confirm-cancel': {
        this.interactions.removeByToolCall(key, event.toolCallId);
        void this.replyAndResumeTyping(bot, key, message.replyTarget, t('im.interaction.confirmCancel'));
        return;
      }
      case 'tool-call-end': {
        if (event.toolName !== 'todo') return;
        void this.pushTodo(bot, key, message, sessionId);
        return;
      }
      default:
        return;
    }
  }

  /** Todo 变化时推送清单（签名未变不重复发送） */
  private async pushTodo(
    bot: StoredImBot,
    key: string,
    message: ImInboundMessage,
    sessionId: string,
  ): Promise<void> {
    const epoch = this.currentRunEpoch(key);
    if (!this.running.has(key) || epoch <= 0) return;
    const path = getSessionTodoPathFromDir(this.deps.dataDir, sessionId);
    const items = readSessionTodoStore(path).items;
    if (items.length === 0) return;
    const signature = todoSignature(items);
    if (this.todoSignatures.get(key) === signature) return;
    this.todoSignatures.set(key, signature);
    // 发送工具清单会打断客户端正在输入；发送后重新点亮，但必须属于同一个运行代际
    await this.reply(bot, message.replyTarget, renderTodoList(items), { keepTyping: true });
    if (!this.running.has(key) || this.currentRunEpoch(key) !== epoch) return;
    this.startTypingGuarded(bot, key, message.replyTarget, epoch);
  }

  // ---------------------------------------------------------------- 执行

  private async runTask(bot: StoredImBot, message: ImInboundMessage, text: string): Promise<void> {
    const engine = this.deps.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
    if (!engine) {
      await this.reply(bot, message.replyTarget, 'MOSS agent 引擎尚未就绪，请稍后再试。');
      return;
    }
    const key = `${bot.botId}:${message.conversationKey}`;
    if (this.running.has(key)) {
      await this.reply(bot, message.replyTarget, '上一条消息还在处理中，请稍候；发送 /stop 可中断。', {
        keepTyping: true,
      });
      return;
    }

    const conversation = this.deps.state.getConversation(key);
    if (conversation && this.deps.server?.isSessionRunning(conversation.sessionId)) {
      await this.reply(bot, message.replyTarget, '该任务正在 MOSS 网页端执行，请等它结束后再发送。');
      return;
    }

    // 消息一到就显示「正在输入」；权限菜单/提问等回复会先停止，回答后恢复
    this.fireTyping(bot, message.replyTarget, true);

    // 首次任务：先询问执行权限，选择后写回 bots.json 并立即执行该任务
    const permissionMode = bot.options.permissionMode;
    if (permissionMode === 'unset') {
      this.interactions.enqueue(key, { kind: 'permission', task: message });
      await this.reply(bot, message.replyTarget, renderPermissionMenu());
      return;
    }

    // 操作范围统一默认为本机（__system__）；设置页可指定具体目录
    const cwd = bot.options.cwd || SYSTEM_SCOPE;
    const controller = new AbortController();
    this.running.set(key, controller);
    this.beginRunEpoch(key);
    if (bot.options.progress !== false) {
      this.progressStates.set(key, this.createProgressState(cwd));
    }

    let sessionId = conversation?.sessionId ?? '';
    try {
      // 附件暂存（失败只跳过该文件，不阻断消息）
      const media = takeMedia(message.segments);
      const stagedResult = media.length > 0
        ? await stageAttachments(this.deps.dataDir, bot.botId, media, controller.signal, this.deps.logger)
        : { staged: [], skipped: [], directory: null };
      const prompt = buildPromptWithAttachments(text, stagedResult.staged, stagedResult.skipped, bot.channel);
      if (!prompt) {
        await this.reply(bot, message.replyTarget, '没有可处理的内容。');
        return;
      }
      const imagePaths = stagedResult.staged
        .filter(item => item.kind === 'image')
        .map(item => item.path);

      let taskId = conversation?.taskId ?? '';
      if (!conversation) {
        const group = this.ensureGroup(engine);
        const title = this.taskTitle(bot, message);
        const task = engine.createTask(title, group?.id);
        taskId = task.id;
        sessionId = task.sessionId ?? task.id;
        this.deps.state.setConversation(key, {
          taskId,
          sessionId,
          title,
          updatedAt: new Date().toISOString(),
        });
        this.deps.server?.broadcastWS({ type: 'task.created', payload: { task, group } });
      }

      if (!sessionId) {
        await this.reply(bot, message.replyTarget, '任务创建失败：缺少会话 ID。');
        return;
      }

      this.deps.server?.registerExternalRun(sessionId, controller);

      const onEvent = (event: AgentEvent): void => {
        try {
          this.deps.server?.sendAgentEvent(sessionId, event);
        } catch {
          // 事件转发失败不影响 IM 侧执行
        }
        this.observeEvent(bot, key, message, sessionId, event);
      };

      const result = await engine.run({
        sessionId,
        userMessage: prompt,
        ...(imagePaths.length > 0 ? { attachments: imagePaths } : {}),
        cwd,
        permissionMode,
        ...(bot.options.agentId ? { agentId: bot.options.agentId } : {}),
        onEvent,
        signal: controller.signal,
      });

      this.fireTyping(bot, message.replyTarget, false);
      await this.settleProgress(key, bot, message.replyTarget);
      await this.deliverResult(bot, message.replyTarget, result.finishReason, result.finalText);
    } catch (error) {
      this.fireTyping(bot, message.replyTarget, false);
      await this.settleProgress(key, bot, message.replyTarget);
      if (controller.signal.aborted) {
        await this.reply(bot, message.replyTarget, '任务已停止。');
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.logger.error(t('im.runFailed'), { botId: bot.botId, error: reason });
        await this.reply(bot, message.replyTarget, `执行失败：${reason}`);
      }
    } finally {
      // 先立即停止「正在输入」再等待播报队列：任务已失败/中止时 typing 不得残留
      this.fireTyping(bot, message.replyTarget, false);
      await this.settleProgress(key, bot, message.replyTarget);
      this.discardProgress(key);
      this.invalidateRunEpoch(key);
      if (sessionId) this.deps.server?.unregisterExternalRun(sessionId, controller);
      // run 结束后未应答的提问/确认已无意义，清理避免下一条普通消息被误当作回答
      this.interactions.clear(key);
      this.running.delete(key);
    }
  }

  /** 最终答案投递：按 finishReason 给出兜底文案 */
  private async deliverResult(
    bot: StoredImBot,
    target: ImReplyTarget,
    finishReason: string | undefined,
    finalText: string,
  ): Promise<void> {
    const text = finalText.trim();
    if (finishReason === 'error') {
      await this.reply(bot, target, text ? `执行出错：${text}` : '执行出错，请稍后重试。');
      return;
    }
    if (finishReason === 'aborted') {
      await this.reply(bot, target, text ? `任务已停止。\n\n${text}` : '任务已停止。');
      return;
    }
    if (!text) {
      await this.reply(bot, target, '任务已完成，但没有产生文本输出。');
      return;
    }
    const prefix = finishReason === 'max_turns' ? '已达到最大轮数上限，以下是当前结果：\n\n' : '';
    await this.reply(bot, target, `${prefix}${text}`);
  }

  // ---------------------------------------------------------------- 过程播报

  private createProgressState(cwd: string): ProgressState {
    return {
      cwd,
      toolCalls: new Map(),
      subagents: [],
      subagentTimer: null,
      queue: Promise.resolve(),
    };
  }

  /** 工具调用事件 → 播报（子代理事件已在 observeEvent 入口按 sessionId 过滤） */
  private trackProgress(
    key: string,
    bot: StoredImBot,
    target: ImReplyTarget,
    event: AgentEvent,
  ): void {
    const state = this.progressStates.get(key);
    if (!state) return;
    switch (event.type) {
      case 'tool-call-start': {
        // 同一 toolCallId 的内部进度消息会重复发 start：保留首次累积的参数文本
        if (state.toolCalls.has(event.toolCallId)) return;
        state.toolCalls.set(event.toolCallId, {
          name: event.toolName,
          argsText: argumentsTextOf(event.args),
        });
        return;
      }
      case 'tool-call-delta': {
        const entry = state.toolCalls.get(event.toolCallId);
        if (entry) entry.argsText += event.argumentsDelta;
        return;
      }
      case 'tool-call-executing': {
        if (event.toolName !== 'agent') return;
        const entry = state.toolCalls.get(event.toolCallId);
        const args = entry ? parseToolArguments(entry.argsText) : null;
        const template = args && typeof args.template === 'string' ? args.template.trim() : '';
        const task = args && typeof args.task === 'string' ? args.task : '';
        if (!task) return;
        state.subagents.push({ name: this.subagentDisplayName(template), task });
        this.scheduleSubagentFlush(key, bot, target);
        return;
      }
      case 'tool-call-end': {
        const entry = state.toolCalls.get(event.toolCallId);
        state.toolCalls.delete(event.toolCallId);
        // 子智能体的调起已在 executing 阶段汇总，结束不再单独播报
        if (event.toolName === 'agent') return;
        if (!entry) return;
        const args = parseToolArguments(entry.argsText);
        if (!args) return;
        const text = formatToolProgress({
          toolName: event.toolName,
          args,
          cwd: state.cwd,
          isError: event.result?.isError === true,
          result: event.result,
        });
        if (text) this.enqueueProgress(state, bot, target, text);
        return;
      }
      default:
        return;
    }
  }

  /** 同一批并发的 agent 调用在同一 tick 内连续 executing：合并窗口后一次汇总 */
  private scheduleSubagentFlush(key: string, bot: StoredImBot, target: ImReplyTarget): void {
    const state = this.progressStates.get(key);
    if (!state || state.subagentTimer !== null) return;
    const timer = setTimeout(() => {
      state.subagentTimer = null;
      this.flushSubagents(key, bot, target);
    }, SUBAGENT_MERGE_WINDOW_MS);
    (timer as { unref?: () => void }).unref?.();
    state.subagentTimer = timer;
  }

  private flushSubagents(key: string, bot: StoredImBot, target: ImReplyTarget): void {
    const state = this.progressStates.get(key);
    if (!state) return;
    if (state.subagentTimer !== null) {
      clearTimeout(state.subagentTimer);
      state.subagentTimer = null;
    }
    if (state.subagents.length === 0) return;
    const entries = state.subagents.splice(0, state.subagents.length);
    this.enqueueProgress(state, bot, target, formatSubagentProgress(entries));
  }

  /** 播报按序发送；失败只记日志，绝不阻塞任务与最终答案 */
  private enqueueProgress(
    state: ProgressState,
    bot: StoredImBot,
    target: ImReplyTarget,
    text: string,
  ): void {
    state.queue = state.queue
      .then(() => this.reply(bot, target, text, { keepTyping: true }))
      .catch(error => {
        this.deps.logger.debug('im: 过程播报发送失败', {
          botId: bot.botId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** 任务收尾：补发剩余子智能体批次并等待播报队列排空（保证先过程、后答案） */
  private async settleProgress(key: string, bot: StoredImBot, target: ImReplyTarget): Promise<void> {
    const state = this.progressStates.get(key);
    if (!state) return;
    this.flushSubagents(key, bot, target);
    await state.queue;
  }

  private discardProgress(key: string): void {
    const state = this.progressStates.get(key);
    if (!state) return;
    if (state.subagentTimer !== null) clearTimeout(state.subagentTimer);
    this.progressStates.delete(key);
  }

  private subagentDisplayName(template: string): string {
    if (!template) return '子智能体';
    const registry = this.deps.services.tryResolve<AgentRegistry>(ServiceNames.AGENT_REGISTRY);
    return registry?.get(template)?.name || template;
  }

  // ---------------------------------------------------------------- 辅助

  private ensureGroup(engine: AgentEngine): { id: string; name: string } | null {
    if (this.groupId) {
      const existing = engine.listTaskGroups().find(group => group.id === this.groupId);
      if (existing) return existing;
      this.groupId = null;
    }
    const found = engine.listTaskGroups().find(group => group.name === IM_GROUP_NAME && !group.hidden);
    if (found) {
      this.groupId = found.id;
      return found;
    }
    const created = engine.createTaskGroup(IM_GROUP_NAME, 'manual');
    this.groupId = created.id;
    return created;
  }

  private taskTitle(bot: StoredImBot, message: ImInboundMessage): string {
    const label = this.deps.channelLabel(bot);
    if (message.kind === 'group') {
      return `[${label}群] ${message.senderName} @ ${message.conversationKey.slice(-6)}`;
    }
    return `[${label}] ${message.senderName}`;
  }

  private async reply(
    bot: StoredImBot,
    target: ImReplyTarget,
    text: string,
    { keepTyping = false }: { keepTyping?: boolean } = {},
  ): Promise<void> {
    if (!keepTyping) this.fireTyping(bot, target, false);
    const chunks = prepareOutbound(
      bot.channel,
      text,
      this.deps.supportsMarkdown(bot),
    );
    for (const chunk of chunks) {
      if (!chunk) continue;
      try {
        await this.deps.sendText(bot, target, chunk);
      } catch (error) {
        this.deps.logger.warn(t('im.replyFailed'), {
          botId: bot.botId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }
}
