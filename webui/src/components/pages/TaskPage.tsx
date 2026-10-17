import { useState, useEffect, useCallback, memo, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ChevronRight,
  ChevronLeft,
  Compass,
  FileText,
  FileDiff,
  Folder,
  Info,
  List,
  PanelRight,
  Plus,
  Loader2,
  MessageCirclePlus,
  HelpCircle,
  Atom,
  Terminal,
  X,
  Copy,
  Undo2,
  Trash2,
  FileWarning,
  Sparkles,
  ListTodo,
  ShieldCheck,
  Circle,
  CircleAlert,
  Package,
  Zap,
  Inbox,
  Users,
  SquarePen,
  ArrowUp,
  Stethoscope,
} from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { resolveToolIcon } from '@/lib/tool-icons';
import { FilePreviewPane, archiveEntrySource, fileNameOf, MarkdownRenderer } from '../../render';
import { subscribeDrained } from '../../render/core/hydration-scheduler';
import type { OverlayType } from '../../types';
import { cn } from '@/lib/utils';
import { parseAttachmentBlock, stripAttachmentBlock } from '@/lib/attachment-block';
import { stripInjectBlock } from '@/lib/inject-block';
import { onSessionTruncated } from '@/lib/ws-events';
import { thinkingPreview, formatThinkingSeconds } from '@/lib/thinking-preview';
import { computeReplyEnds } from '@/lib/reply-end';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { SystemErrorCard, MessageActions } from '@/components/pages/SystemErrorCard';
import { InsightDialog } from '@/components/insight/InsightDialog';
import { useIsMobile, useWindowWidth } from '@/hooks/use-mobile';
import { useResizable } from '@/hooks/use-resizable';
import { useOpenFilePreview } from '@/hooks/useOpenFilePreview';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskInput } from '../shared/TaskInput';
import { MentionTokenText, useMentionLookups } from '../shared/MentionTokens';
import { stripMentionTokens } from '../shared/mention-data';
import { MessageAttachmentCards } from '../shared/AttachmentCards';
import { FileTypeIcon } from '../shared/FileTypeIcon';
import { ScrollToBottomButton } from '../shared/ScrollToBottomButton';
import { ConnectionStatusTag } from '../shared/ConnectionStatusTag';
import { VirtualList, type VirtualListApi } from '../../lib/virtual-list/VirtualList';
import { useSessionHistory } from '../../hooks/useSessionHistory';
import { useTabBarScroll } from '../../hooks/useTabBarScroll';
import { TodoProgressCard, TodoRow } from '../shared/TodoProgressCard';
import { AskPromptCard } from '../shared/AskPromptCard';
import { ConfirmPromptCard } from '../shared/ConfirmPromptCard';
import { TerminalPanel } from '../shared/TerminalPanel';
import { TERMINAL_SCRATCH_SCOPE } from '../../lib/terminal-scope';
import { FileBrowserPanel } from '../shared/FileBrowserPanel';
import { FileChangesPanel } from '../shared/FileChangesPanel';
import { AgenteamPanel } from '../agenteam/AgenteamPanel';
import { AgenteamInlineCard, type InlineTeamPlan } from '../agenteam/AgenteamInlineCard';
import { SubagentInlineCard } from '../agenteam/SubagentInlineCard';
import { isAgentCall, parseAgentArgs, buildToolResultIndex, type ToolResultEntry } from '../agenteam/agent-calls';
import { MessageErrorBoundary } from '../shared/MessageErrorBoundary';
import { ControlHub } from '../shared/ControlHub';
import { StatsBar } from '../shared/StatsBar';
import { CompactionCard } from '../shared/CompactionCard';
import { MaxTurnsNoticeCard } from '../shared/MaxTurnsNoticeCard';
import { OutputLimitNoticeCard } from '../shared/OutputLimitNoticeCard';
import {
  useStore,
  DEFAULT_SIDEBAR_TABS,
  RIGHT_PANEL_MIN_PX,
  RIGHT_PANEL_RATIO_MIN,
  RIGHT_PANEL_RATIO_MAX,
} from '../../store';
import { useTask } from '../../hooks/useTask';
import { useFileIndex } from '../../hooks/useFileIndex';
import { api } from '../../api/http';
import type { TaskMessage, TodoItem, SidebarTab, CompactPreview, ContextStats } from '../../types/api';

// 稳定引用的空数组，避免 useStore 选择器每次返回新 [] 触发 useSyncExternalStore 无限循环
const EMPTY_MESSAGES: TaskMessage[] = [];
const EMPTY_TODOS: TodoItem[] = [];

/** 文件索引构建进度条（三引擎构建期间显示于任务页顶部；全就绪/全关时隐藏） */
function FileIndexProgressBar() {
  const { t } = useTranslation();
  const cwd = useStore((s) => s.workingDirectory) || undefined;
  const { status, building, overallPercent } = useFileIndex(cwd);
  if (!building || !status) return null;
  const engineName =
    status.indexing.state === 'scanning'
      ? t('settings.fileIndex.indexingTitle')
      : status.graph.state === 'scanning'
        ? t('settings.fileIndex.graphTitle')
        : status.sag.state === 'scanning'
          ? t('settings.fileIndex.sagTitle')
          : '';
  const percent = overallPercent ?? 0;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-1.5"
      title={t('task.fileIndexBuilding', { engine: engineName, percent })}
    >
      <Progress value={percent} className="h-1 flex-1" />
      <span className="shrink-0 text-xs text-muted-foreground">
        {t('task.fileIndexBuilding', { engine: engineName, percent })}
      </span>
    </div>
  );
}
const EMPTY_QUEUE: Array<{
  id: string;
  content: string;
  timestamp: string;
  attachments?: string[];
}> = [];

// 单条消息正文渲染上限：超长内容（如 base64/大文件摘录）截断渲染，防止一次性布局卡死滚动
const MAX_RENDER_CHARS = 6000;

// 用户消息附件：优先用后端结构化字段 message.attachments；老会话无该字段时回退
// lib/attachment-block 的 parseAttachmentBlock（同时覆盖「只发附件不打字 → 块在消息开头」）。

// 根据当前小时返回问候语 i18n key
function getGreetingKey(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 9) return 'task.greeting.morning';       // 早上好
  if (h >= 9 && h < 11) return 'task.greeting.forenoon';      // 上午好
  if (h >= 11 && h < 14) return 'task.greeting.noon';         // 中午好
  if (h >= 14 && h < 18) return 'task.greeting.afternoon';    // 下午好
  if (h >= 18 && h < 23) return 'task.greeting.evening';      // 晚上好
  return 'task.greeting.lateNight';                            // 夜深了（23-4）
}

interface TaskPageProps {
  onOpenOverlay?: (overlay: OverlayType) => void;
}

/**
 * 等待指定会话下一次「撤回/截断」事件落地（本地消息已按截断点删除）。
 * 「重新生成」先登记等待，再调截断；截断事件处理完后再重发 → 乐观新消息不会被同一次删除误删。
 * 超时兜底：WS 不可用时 1.5s 后放行。
 */
function waitNextSessionTruncated(sessionId: string, timeoutMs = 1500): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (off) off();
      clearTimeout(timer);
      resolve();
    };
    off = onSessionTruncated((sid) => {
      if (sid === sessionId) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * 对话区（消息列表 + 发送框）固定最大宽度：固定上限内自适应。
 * 可用宽度更小时列自身 w-full 自动收缩；不再按窗宽比例动态计算，避免小窗口下被压得过窄。
 */
const CHAT_MAX_WIDTH_PX = 768;

/**
 * 回复结尾判定见 `webui/src/lib/reply-end.ts`（纯函数，已被单测覆盖）：
 * - replyEndIds：所有「一段 AI 回复的结尾」消息 id → 这些消息才挂「复制」按钮
 * - lastReplyEndId：最新的一段回复结尾 → 仅它挂「重新生成 / 诊断(Harness)」
 */
export function TaskPage({ onOpenOverlay }: TaskPageProps) {
  const { t } = useTranslation();
  const { taskId = '' } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  // 右侧面板展开态（会话级）/宽度（全局）：store 内存态而非本地 state，TaskPage 因路由
  // 切换重挂载时保持不重置；开合按会话独立（一个会话收起不影响其他会话），宽度作为
  // UI 偏好跨会话共享；taskId 为空串（空白页）时读写 '' key，建会话时随对话转移
  const rightPanelOpen = useStore((s) => s.rightPanelOpenBySession[taskId] ?? false);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);
  // 右侧面板宽度 = 占整窗比例 × 窗口宽度（外观设置三档预设 + 拖拽微调，比例持久化）
  const rightPanelRatio = useStore((s) => s.rightPanelRatio);
  const setRightPanelRatio = useStore((s) => s.setRightPanelRatio);
  const isMobile = useIsMobile();
  const windowWidth = useWindowWidth();
  // 移动端侧边栏抽屉开合态：展开时顶栏「新建对话」快捷按钮自动隐藏（抽屉内已有同名按钮）
  const { openMobile } = useSidebar();

  // 右侧面板像素宽度：比例 × 窗宽（比例已由 store 钳制在 [窄, 宽] 区间）；
  // 再用 240px 兜底，防止极端窄窗口下面板不可用
  const rightPanelPx = Math.max(RIGHT_PANEL_MIN_PX, Math.round(rightPanelRatio * windowWidth));

  // 对话区宽度：固定上限 CHAT_MAX_WIDTH_PX + w-full 自适应（可用宽度不足时自动收缩、居中）。
  const chatMaxWidth = CHAT_MAX_WIDTH_PX;

  // 右侧面板拖拽调宽（仅桌面端内嵌 aside）：范围＝「窄 ~ 宽」，拖动像素宽度换算为精确比例
  const rightResize = useResizable({
    side: 'left',
    min: Math.round(RIGHT_PANEL_RATIO_MIN * windowWidth),
    max: Math.round(RIGHT_PANEL_RATIO_MAX * windowWidth),
    onChange: (px) => {
      // manual=true：拖拽产生的宽度 → 设置项显示「自定义」
      if (windowWidth > 0) setRightPanelRatio(px / windowWidth, true);
    },
  });

  // 右侧面板标签页拖拽排序
  const tabSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const handleTabDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    reorderSidebarTabs(taskId, String(active.id), String(over.id));
  };

  const messages = useStore((s) => s.messagesBySession[taskId] ?? EMPTY_MESSAGES);
  /**
   * 工具结果全局索引（toolCallId → 结果文本/错误标记）。
   * 长耗时工具（subagent / 建队）的结果消息不保证紧邻其 assistant 消息，
   * 卡片必须跨整条消息列表取结果，否则刷新后报告与 teamId 全丢。
   *
   * 增量缓存：流式期间 store 每次追加都会产生新数组（每 rAF 一次），全量重建
   * O(n) 会随会话长度线性放大；append-only 时前缀引用不变，仅增量扫描尾部，
   * 前缀引用变化（工具结果原地更新 / 上滑 prepend / catchup patch）才全量重建。
   */
  const toolResultCacheRef = useRef<{ messages: readonly TaskMessage[]; index: Map<string, ToolResultEntry> }>({
    messages: EMPTY_MESSAGES,
    index: new Map(),
  });
  const toolResultIndex = useMemo(() => {
    const cache = toolResultCacheRef.current;
    const prev = cache.messages;
    if (messages.length > prev.length) {
      let prefixSame = true;
      for (let i = 0; i < prev.length; i++) {
        if (messages[i] !== prev[i]) {
          prefixSame = false;
          break;
        }
      }
      if (prefixSame) {
        // append-only：复用已有索引，仅扫描新增尾部（first-wins 语义与全量重建一致）
        const index = cache.index;
        for (let i = prev.length; i < messages.length; i++) {
          const results = messages[i].toolResults;
          if (!results) continue;
          for (const entry of results) {
            if (!entry.toolCallId || index.has(entry.toolCallId)) continue;
            const text = entry.result.content
              .filter((c) => c.type === 'text')
              .map((c) => (c.type === 'text' ? c.text : ''))
              .join('\n');
            index.set(entry.toolCallId, { text, isError: entry.result.isError === true });
          }
        }
        cache.messages = messages;
        return index;
      }
    }
    const index = buildToolResultIndex(messages);
    toolResultCacheRef.current = { messages, index };
    return index;
  }, [messages]);
  /** token 名单：队列预览 / 标题剥离用（与气泡渲染同口径） */
  const lookups = useMentionLookups();
  const isGenerating = useStore((s) => s.generatingBySession[taskId] ?? false);
  const task = useStore((s) => s.tasks.find((tk) => tk.id === taskId));
  // 隐藏会话（subagent / agenteam 衍生任务）不在侧边栏列表，store.tasks 查不到 → 直连接口兜底标题
  const [fallbackTitle, setFallbackTitle] = useState<string | null>(null);
  const todos = useStore((s) => s.todosBySession[taskId] ?? EMPTY_TODOS);
  const pendingAsks = useStore((s) => s.pendingAsks);
  const pendingConfirms = useStore((s) => s.pendingConfirms);
  const messageQueue = useStore((s) => s.messageQueueBySession[taskId] ?? EMPTY_QUEUE);
  const removeFromMessageQueue = useStore((s) => s.removeFromMessageQueue);
  // 当前会话 run 统计（中控岛下方指标栏）与中控岛展开模块
  const runStats = useStore((s) => s.runStatsBySession[taskId]);
  const hubActiveModule = useStore((s) => s.hubActiveModuleBySession[taskId]);
  const setHubActiveModule = useStore((s) => s.setHubActiveModule);

  // ===== 中控岛自动展开/折叠 =====
  // 竞态防护：用户手动操作（chips/折叠按钮）经 handleHubModuleChange 记录时间戳并取消
  // 自动折叠定时器；程序化 setHubActiveModule 不经过包装，不会误标为用户操作
  const prevAskCountRef = useRef(0);
  const prevConfirmCountRef = useRef(0);
  /** todo 签名（id:status 列表）；null = 未初始化（首次跳过，防挂载误触发） */
  const prevTodoSigRef = useRef<string | null>(null);
  /** 上一次 todo 是否处于「全部完成」态（进入沿检测基准） */
  const prevAllDoneRef = useRef(false);
  /** 本次生成（run）内是否已执行过 todo「首次展开」；isGenerating 上升沿重置 */
  const runTodoExpandedRef = useRef(false);
  /** 上一次 isGenerating（上升沿检测基准） */
  const prevGeneratingRef = useRef(false);
  /** 上一次处理的会话 id（切换会话时重置基准，防跨会话比较误触发） */
  const lastHubTaskIdRef = useRef('');
  /** todo 自动折叠定时器（变更后展示 3s） */
  const todoCollapseTimerRef = useRef<number | null>(null);
  /** 用户最近一次手动操作时间（自动折叠前校验，防止与用户操作打架） */
  const lastUserActionAtRef = useRef(0);
  /** 最近一次自动展开时间 */
  const autoExpandAtRef = useRef(0);

  const clearTodoCollapseTimer = useCallback(() => {
    if (todoCollapseTimerRef.current !== null) {
      window.clearTimeout(todoCollapseTimerRef.current);
      todoCollapseTimerRef.current = null;
    }
  }, []);

  /** 用户手动切换模块（chips 点击/折叠按钮）：标记操作时间并取消待执行的自动折叠 */
  const handleHubModuleChange = useCallback(
    (moduleId: string | null) => {
      lastUserActionAtRef.current = Date.now();
      clearTodoCollapseTimer();
      setHubActiveModule(taskId, moduleId);
    },
    [clearTodoCollapseTimer, setHubActiveModule, taskId],
  );

  // 自动行为：新提问/权限确认到达 → 自动展开并切换对应类别；回答/处理后 → 默认折叠；
  // todo 变更 → 仅两个时机展开（各展示 3s 后自动折叠，不抢占待处理的提问/权限）：
  //   ① 本次生成内首次建立/变更（发送任务后 todo 首次出现/变化）
  //   ② 进入「全部完成」态（所有项 completed 的上升沿）
  //   中间变更不展开、不重置定时器（面板内容仍随 store 实时刷新）
  useEffect(() => {
    if (!taskId) return;
    // 会话切换：重置基准状态（在比较前执行，避免旧会话计数/签名误触发）
    if (lastHubTaskIdRef.current !== taskId) {
      lastHubTaskIdRef.current = taskId;
      prevAskCountRef.current = 0;
      prevConfirmCountRef.current = 0;
      prevTodoSigRef.current = null;
      prevAllDoneRef.current = false;
      runTodoExpandedRef.current = false;
      clearTodoCollapseTimer();
    }
    // 生成开始（上升沿）：重置「run 内首次展开」标志，下一次 todo 变更即为本次生成的首次
    if (isGenerating && !prevGeneratingRef.current) {
      runTodoExpandedRef.current = false;
    }
    prevGeneratingRef.current = isGenerating;
    const askCount = pendingAsks.filter((a) => a.sessionId === taskId).length;
    const confirmCount = pendingConfirms.filter((c) => c.sessionId === taskId).length;
    const todoSig = todos.map((td) => `${td.id}:${td.status}`).join('|');
    const prevAsk = prevAskCountRef.current;
    const prevConfirm = prevConfirmCountRef.current;
    const prevTodoSig = prevTodoSigRef.current;
    const prevAllDone = prevAllDoneRef.current;
    const wasRunTodoExpanded = runTodoExpandedRef.current;
    const nowAllDone = todos.length > 0 && todos.every((td) => td.status === 'completed');
    const todoChanged = prevTodoSig !== null && todoSig !== prevTodoSig;
    prevAskCountRef.current = askCount;
    prevConfirmCountRef.current = confirmCount;
    prevTodoSigRef.current = todoSig;
    // 基准在分支前无条件推进（ask/confirm 分支提前 return 也不能让基准过期）；
    // 分支内使用的是上方捕获的旧值 wasRunTodoExpanded / prevAllDone
    prevAllDoneRef.current = nowAllDone;
    runTodoExpandedRef.current = wasRunTodoExpanded || todoChanged;

    // 新提问到达：切换/展开 ask（阻塞 agent，最高优先级）
    if (askCount > prevAsk) {
      clearTodoCollapseTimer();
      setHubActiveModule(taskId, 'ask');
      autoExpandAtRef.current = Date.now();
      return;
    }
    // 提问清空（已回答）：默认折叠；仍有待确认权限则切过去
    if (prevAsk > 0 && askCount === 0 && hubActiveModule === 'ask') {
      setHubActiveModule(taskId, confirmCount > 0 ? 'permission' : null);
      return;
    }
    // 新权限确认到达：切换/展开 permission
    if (confirmCount > prevConfirm) {
      clearTodoCollapseTimer();
      setHubActiveModule(taskId, 'permission');
      autoExpandAtRef.current = Date.now();
      return;
    }
    // 权限确认清空（已处理）：默认折叠；仍有待答提问则切回去
    if (prevConfirm > 0 && confirmCount === 0 && hubActiveModule === 'permission') {
      setHubActiveModule(taskId, askCount > 0 ? 'ask' : null);
      return;
    }
    // todo 变更（跳过首次初始化）：无阻塞项时，仅「本次生成内首次变更」或
    // 「进入全部完成态」两个时机展开 3s 后自动折叠；中间变更静默刷新不展开
    if (todoChanged && askCount === 0 && confirmCount === 0) {
      const isFirstChange = !wasRunTodoExpanded;
      const becomesAllDone = nowAllDone && !prevAllDone;
      if (isFirstChange || becomesAllDone) {
        clearTodoCollapseTimer();
        setHubActiveModule(taskId, 'todo');
        autoExpandAtRef.current = Date.now();
        todoCollapseTimerRef.current = window.setTimeout(() => {
          todoCollapseTimerRef.current = null;
          const s = useStore.getState();
          // 竞态防护：仅当仍处于 todo 模块且自动展开后用户无手动干预时才折叠
          if (
            s.hubActiveModuleBySession[taskId] === 'todo' &&
            lastUserActionAtRef.current <= autoExpandAtRef.current
          ) {
            s.setHubActiveModule(taskId, null);
          }
        }, 3000);
      }
    }
  }, [
    pendingAsks,
    pendingConfirms,
    todos,
    hubActiveModule,
    taskId,
    isGenerating,
    setHubActiveModule,
    clearTodoCollapseTimer,
  ]);

  // ===== 消息撤回（截断）状态机 =====
  /** 待确认的撤回目标（用户消息） */
  const [truncateTarget, setTruncateTarget] = useState<TaskMessage | null>(null);
  // ===== 滚动控制（自建虚拟列表：followOutput 仅在「已在底部」时跟随）=====
  const listApiRef = useRef<VirtualListApi | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  /** 跟随态快照（供发送时读取最新值，不触发重渲染） */
  const atBottomRef = useRef(true);
  /** 预览加载中 */
  const [truncateLoading, setTruncateLoading] = useState(false);
  /** 预览结果 */
  const [truncatePreview, setTruncatePreview] = useState<{
    messagesToRemove: Array<{ index: number; role: string; content: string }>;
    fileChanges: Array<{ absPath: string; operation: string; toolName: string; timestamp: string }>;
    rollbackSkippedReason?: 'no-file-history' | 'no-timestamp';
  } | null>(null);
  /** 执行中 */
  const [truncating, setTruncating] = useState(false);
  // ===== AI 错误诊断弹窗 =====
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState('');
  // Harness 缺陷诊断弹窗（操作栏「诊断」按钮触发；与错误诊断弹窗相互独立）
  const [harnessOpen, setHarnessOpen] = useState(false);
  const context = useStore((s) => s.contextBySession[taskId]);
  /** 上下文引擎统计（token 构成/缓存命中/压缩状态/系统分段；stats API + WS 事件维护） */
  const contextStats = useStore((s) => s.contextStatsBySession[taskId]);

  // ===== 手动压缩状态机（空闲可用 + 确认对话框） =====
  const [compactDialogOpen, setCompactDialogOpen] = useState(false);
  const [compactPreview, setCompactPreview] = useState<CompactPreview | null>(null);
  const [compactPreviewLoading, setCompactPreviewLoading] = useState(false);
  const [compacting, setCompacting] = useState(false);

  // 右侧边栏标签页：按会话隔离（taskId → { tabs, activeId }）；无记录的会话回退默认「开始」
  const sessionTabs = useStore((s) => s.sidebarTabsBySession[taskId]);
  const sidebarTabs = useMemo(() => sessionTabs?.tabs ?? DEFAULT_SIDEBAR_TABS, [sessionTabs]);
  const activeSidebarTabId = sessionTabs?.activeId ?? sidebarTabs[0]?.id ?? null;
  const addSidebarTab = useStore((s) => s.addSidebarTab);
  const removeSidebarTab = useStore((s) => s.removeSidebarTab);
  const setActiveSidebarTab = useStore((s) => s.setActiveSidebarTab);
  const reorderSidebarTabs = useStore((s) => s.reorderSidebarTabs);
  const resetSidebarTabs = useStore((s) => s.resetSidebarTabs);
  const convertSidebarTab = useStore((s) => s.convertSidebarTab);
  const toolIconMap = useStore((s) => s.toolIconMap);
  const { sendMessage, abort, editQueuedMessage, sendQueuedNow } = useTask();
  // 统一文件预览入口：桌面端 → 右侧边栏标签；移动端 → 仅侧边栏入口走标签，其余走弹层
  const openFilePreview = useOpenFilePreview();

  // 点击消息流附件卡片：按平台/来源决定预览方式并展开面板
  const openAttachment = useCallback(
    (path: string) => {
      openFilePreview(taskId, path);
    },
    [openFilePreview, taskId],
  );

  // 当前活跃标签对象
  const activeTab = sidebarTabs.find((t) => t.id === activeSidebarTabId) ?? sidebarTabs[0];
  // 压缩包内层标签：稳定引用地构造其内容源（否则 effect 依赖抖动 → 反复重新提取）
  const archiveEntry = activeTab?.type === 'file' ? activeTab.archiveEntry : undefined;
  const fileTabSource = useMemo(() => (archiveEntry ? archiveEntrySource(archiveEntry) : undefined), [archiveEntry]);
  // 下拉菜单只显示当前标签栏中未打开的类型；全部类型都已打开时禁用加号按钮
  const hasSummaryTab = sidebarTabs.some((tab) => tab.type === 'summary');
  const hasTerminalTab = sidebarTabs.some((tab) => tab.type === 'terminal');
  const hasAgenteamTab = sidebarTabs.some((tab) => tab.type === 'agenteam');
  const hasFilesTab = sidebarTabs.some((tab) => tab.type === 'files');
  const hasChangesTab = sidebarTabs.some((tab) => tab.type === 'changes');
  const allTabTypesOpen =
    hasSummaryTab && hasTerminalTab && hasAgenteamTab && hasFilesTab && hasChangesTab;

  // 「开始」面板：打开/切换到某类型标签；「开始」标签存在时原地变身，不再新开标签
  const openTabType = useCallback(
    (type: 'summary' | 'terminal' | 'agenteam' | 'files' | 'changes', titleKey: string) => {
      // 已开该类型 → 直接切换
      const existing = sidebarTabs.find((tab) => tab.type === type);
      if (existing) {
        setActiveSidebarTab(taskId, existing.id);
        return;
      }
      // 未开 → 若当前有「开始」标签则原地转换，否则新增
      const startTab = sidebarTabs.find((tab) => tab.type === 'start');
      if (startTab) convertSidebarTab(taskId, startTab.id, type, titleKey);
      else addSidebarTab(taskId, type, titleKey);
    },
    [sidebarTabs, addSidebarTab, setActiveSidebarTab, convertSidebarTab, taskId],
  );

  // 标签栏单行横向滚动：按「一个标签页」滚动 + 新建/激活标签自动滚入视野（哪边还有内容才显示箭头）
  const {
    ref: tabBarRef,
    canScrollLeft: canScrollTabsLeft,
    canScrollRight: canScrollTabsRight,
    onScroll: onTabBarScroll,
    scrollByTab: scrollTabs,
    scrollTabIntoView: scrollTabIntoView,
  } = useTabBarScroll<HTMLDivElement>();

  // 新建/激活/排序后让当前标签自动滚入视野（已完整可见时为空操作）
  useEffect(() => {
    scrollTabIntoView(activeTab?.id);
  }, [activeTab?.id, sidebarTabs.length, scrollTabIntoView]);

  // 隐藏会话标题兜底：store.tasks 无该任务（subagent / agenteam 衍生会话已被侧边栏过滤）时，
  // 直连 /api/tasks/:id 取标题；任务进入 store 后自动让位（task 存在则清空兜底）
  useEffect(() => {
    if (!taskId || task) {
      setFallbackTitle(null);
      return;
    }
    let alive = true;
    void api
      .getTask(taskId)
      .then((resp) => {
        if (alive) setFallbackTitle(resp.task.title);
      })
      .catch(() => {
        if (alive) setFallbackTitle(null);
      });
    return () => {
      alive = false;
    };
  }, [taskId, task]);

  // 卸载时清理 todo 自动折叠定时器 + 防状态污染（不清 pendingAssistant：
// 同会话重新挂载后仍需靠它继续接流）
  useEffect(() => {
    return () => {
      clearTodoCollapseTimer();
    };
  }, [clearTodoCollapseTimer]);

  // ===== 会话编排（订阅 + 状态快照 + 分页 + 断线对齐 + 半截流式续接）=====
  // 历史加载 / todos / 上下文 / 统计 / 压缩卡片 / 半截草稿恢复全部收敛在 hook 内，
  // 组件只消费结果（分页游标、加载态、上滑加载更早）。
  const {
    loadOlder,
    hasMoreBefore,
    loadingBefore,
    loaded: historyLoaded,
    reload: reloadHistory,
  } = useSessionHistory(taskId, listApiRef);

  // ===== 自动滚动（自建虚拟列表接管）=====
  // followOutput 仅在「已在底部」时跟随 → 用户上滑查看历史时绝不被拉回；
  // atBottomStateChange 同步按钮显隐；scrollToBottom 走列表 api 的 scrollToBottom。
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    listApiRef.current?.scrollToBottom(behavior);
  }, []);
  const handleAtBottomChange = useCallback((v: boolean) => {
    atBottomRef.current = v;
    setAtBottom(v);
  }, []);

  /**
   * 列表未挂载时（空白页 / 历史未加载）滚动状态失去意义：
   * 复位为「在底部」，避免上一会话用户上滑后残留的 atBottom=false
   * 让「返回底部」按钮在空白页幽灵出现（列表不在，无人能回调重置）。
   */
  useEffect(() => {
    if (messages.length > 0) return;
    if (atBottomRef.current) return;
    atBottomRef.current = true;
    setAtBottom(true);
  }, [messages.length]);

  /** 滚动容器 DOM（用于判定「是否真的在顶部」，见 handleStartReached） */
  const scrollerElRef = useRef<HTMLDivElement | null>(null);

  /**
   * 上滑到顶 → 加载更早的一页。
   * 必须校验「当前是否真的在顶部」：虚拟列表在 prepend 后 scrollTop 仍可能很小，
   * 不校验会把整段历史在用户停留顶部时级联全部加载（分页的意义被抵消）。
   */
  const handleStartReached = useCallback(() => {
    const el = scrollerElRef.current;
    if (el && el.scrollTop > 120) return;
    loadOlder();
  }, [loadOlder]);

  /**
   * 首屏 / 切回会话：末页到达后强制定位到最新消息（每会话一次）。
   * 为什么需要：虚拟列表的 initialBottom 只在「首次带数据的渲染」生效，
   * 而切回会话时列表可能先用 store 里的旧缓存渲染、随后被末页替换；
   * 显式定位一次可保证任何路径下「打开会话即看到最新消息」。
   */
  const tailAnchoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!taskId || messages.length === 0) return;
    const meta = useStore.getState().historyMetaBySession[taskId];
    if (!meta?.loaded) return;
    if (tailAnchoredRef.current === taskId) return;
    tailAnchoredRef.current = taskId;
    requestAnimationFrame(() => {
      listApiRef.current?.scrollToBottom('auto');
      atBottomRef.current = true;
      setAtBottom(true);
    });
  }, [taskId, messages.length]);

  /**
   * 渐进水合回锚：一批延迟渲染的块（hydration-scheduler）升级完成后，若视口仍在底部
   * 则回锚最新消息一次——上方内容水合后高度变化会把底部顶出视口，这里拉回。
   * rAF 再延迟一帧：等水合引发的重渲染/重排实际提交后再定位。
   */
  useEffect(() => {
    return subscribeDrained(() => {
      if (!atBottomRef.current) return;
      requestAnimationFrame(() => {
        listApiRef.current?.scrollToBottom('auto');
      });
    });
  }, []);

  const contextFiles = context?.files ?? [];
  const totalTokens = context?.totalTokens ?? 0;
  const maxTokens = context?.maxTokens ?? 1;
  const contextPercent = maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 100) : 0;

  // 「响应中」占位门控：生成中且尾条尚无可视输出时显示。
  // 后端首个 assistant 事件（thinking / tool-call-delta）会先建出一条空占位 assistant 消息，
  // 若仍按「尾条非 assistant」判定，提示会在占位无内容时凭空消失（用户看到的「一片死寂」）。
  const tail = messages[messages.length - 1];
  const tailHasVisibleOutput =
    !!tail && tail.role === 'assistant' &&
    (tail.content.trim().length > 0 ||
      (tail.thinking ?? '').trim().length > 0 ||
      (tail.toolCalls?.length ?? 0) > 0);
  const showTailThinking = isGenerating && !tailHasVisibleOutput;

  // ===== 右侧面板 Tab 切换状态机 =====
  // 默认"系统"；仅当 LLM 真实读取文件（WS context-updated，read/grep/glob）时自动切到"文件"；
  // 用户手动切换后不再自动切换（尊重用户操作）；切换会话时重置回"系统"。
  const [contextTab, setContextTab] = useState('system');
  const contextTabUserTouchedRef = useRef(false);
  const prevTaskIdRef = useRef(taskId);
  const contextFileReadSeq = useStore((s) => s.contextFileReadSeqBySession[taskId]);
  // LLM 新读取文件（seq 递增）且用户未手动切换过 → 自动切到"文件"
  useEffect(() => {
    if (contextFileReadSeq == null || contextFileReadSeq < 1) return;
    if (contextTabUserTouchedRef.current) return;
    setContextTab('files');
  }, [contextFileReadSeq]);
  // 会话切换：重置为默认"系统"，恢复自动切换能力
  useEffect(() => {
    if (prevTaskIdRef.current === taskId) return;
    prevTaskIdRef.current = taskId;
    contextTabUserTouchedRef.current = false;
    setContextTab('system');
  }, [taskId]);
  // 进入空白页（新任务）时重置右侧边栏标签为默认「开始」（覆盖侧边栏/移动端各新任务入口）
  const prevTabsTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (taskId === '' && prevTabsTaskIdRef.current !== '') resetSidebarTabs('');
    prevTabsTaskIdRef.current = taskId;
  }, [taskId, resetSidebarTabs]);
  // 受控值防御：contextTab 指向的条件 tab（summary）消失时回退"系统"
  const contextTabValue =
    (contextTab === 'summary' && !contextStats?.breakdown?.summary)
      ? 'system'
      : contextTab;

  // 空状态：发送消息后创建任务并跳转；任务态：直接发送到当前 session
  const handleSend = useCallback(
    async (text: string, attachments?: string[]) => {
      // 仅跟随态才自动滚底：用户上滑看历史时发送消息，视图停留在原位不被拉回底部
      if (atBottomRef.current) scrollToBottom('auto');
      if (taskId) {
        sendMessage(text, { taskId, attachments });
      } else {
        // 空白页首条消息：sendMessage 同步预分配会话 id、写入乐观任务与用户消息后，
        // 通过 onSessionReady 立即导航 —— 配合 flushSync 同步应用路由，点发送即刻就是任务页，
        // 不存在「taskId 为空」的过渡帧（无需居中/底部加载态）。
        sendMessage(text, {
          attachments,
          onSessionReady: (id) => {
            // 面板开合状态随对话转移到新会话，避免 navigate 重挂载后收起
            useStore.getState().migrateRightPanelState('', id);
            // flushSync：同步提交路由更新；否则 navigate 走低优先级 transition，
            // 期间 taskId 仍为空 → 仍会渲染空白页（欢迎页）一帧
            navigate(`/task/${id}`, { flushSync: true });
          },
        });
      }
    },
    [taskId, sendMessage, navigate, scrollToBottom],
  );

  /** 轮数触顶卡「继续执行」：稳定引用（内联箭头每次渲染都新建，会让 MessageBubble 的 memo 恒失效 → 整列表重渲） */
  const handleContinue = useCallback(
    () => void handleSend(t('task.maxTurnsContinue')),
    [handleSend, t],
  );

  // ===== 消息撤回流程 =====
  /** 点击撤回按钮：拉取预览并弹确认框 */
  const handleTruncateClick = useCallback(
    async (message: TaskMessage) => {
      if (!taskId || isGenerating) return;
      setTruncateTarget(message);
      setTruncatePreview(null);
      setTruncateLoading(true);
      try {
        const resp = await api.previewTruncate(taskId, message.timestamp, message.content);
        setTruncatePreview({
          messagesToRemove: resp.messagesToRemove,
          fileChanges: resp.fileChanges,
          ...(resp.rollbackSkippedReason ? { rollbackSkippedReason: resp.rollbackSkippedReason } : {}),
        });
      } catch {
        // 预览失败（后端未就绪/旧消息无时间戳）：仍允许执行（只删消息）
        setTruncatePreview({ messagesToRemove: [], fileChanges: [] });
      } finally {
        setTruncateLoading(false);
      }
    },
    [taskId, isGenerating],
  );

  /** 确认撤回：执行截断（软删除 + 文件回滚），toast 提供恢复入口 */
  const handleTruncateConfirm = useCallback(async () => {
    if (!taskId || !truncateTarget) return;
    setTruncating(true);
    try {
      const resp = await api.truncateSession(taskId, truncateTarget.timestamp, truncateTarget.content);
      const hasFiles = resp.rolledBackFiles > 0;
      toast(t('task.truncateDone', { count: resp.removedCount, files: resp.rolledBackFiles }), {
        description: hasFiles ? t('task.truncateFilesRolled', { files: resp.rolledBackFiles }) : undefined,
        action: {
          label: t('task.truncateRestore'),
          onClick: async () => {
            try {
              const restoreResp = await api.restoreTruncate(taskId);
              // 防御性刷新：WS 断线重连期间 session-restored 事件可能丢失，
              // 恢复成功后直接按末页整体重载（WS 正常时两者幂等一致）
              if (restoreResp.restoredCount > 0) {
                useStore.getState().setTruncateBackup(taskId, undefined);
                await reloadHistory();
              }
            } catch {
              toast.error(t('task.truncateRestoreFailed'));
            }
          },
        },
        duration: 15000,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('task.truncateFailed'));
    } finally {
      setTruncating(false);
      setTruncateTarget(null);
      setTruncatePreview(null);
    }
  }, [taskId, truncateTarget, t, reloadHistory]);

  /** 复制消息文本 */
  const handleCopyMessage = useCallback((content: string) => {
    void navigator.clipboard.writeText(content).then(
      () => toast.success(t('task.messageCopied')),
      () => toast.error(t('task.messageCopyFailed')),
    );
  }, [t]);

  /** 打开 AI 错误诊断弹窗（入参为原始 provider 错误文本） */
  const handleDiagnose = useCallback((errorDetail: string) => {
    setDiagnosisError(errorDetail);
    setDiagnosisOpen(true);
  }, []);

  /** 打开 Harness 缺陷诊断弹窗（操作栏「诊断」按钮触发；基于当前会话任务流链路 + 日志） */
  const handleDiagnoseHarness = useCallback(() => {
    setHarnessOpen(true);
  }, []);

  /**
   * 统一 AI 回复操作栏「重新生成」：
   * 1) 由**服务端**在完整历史上定位「最后一条真实用户消息」为重跑起点
   *    （前端只加载最后一页，本地可能找不到该 user 消息 → 旧实现会静默失败）；
   * 2) 截断到该 user 消息（rollbackFiles:false —— 仅软删除消息，不回滚此前工具产生的文件变更）；
   * 3) 以原内容 + 附件重发，重新走一次 run。
   */
  const handleRegenerate = useCallback(
    async (_message: TaskMessage) => {
      if (!taskId || isGenerating) return;
      let target: { timestamp: string; content: string; attachments?: string[] };
      try {
        target = (await api.getRegenerateTarget(taskId)).userMessage;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('task.regenerateFailed'));
        return;
      }
      try {
        // 1) 先登记等待本会话下一次「撤回/截断」事件落地（避免乐观新消息被同一次删除误删）
        const truncated = waitNextSessionTruncated(taskId);
        // 2) 后端截断到该 user 消息（不回滚此前工具产生的文件变更）
        await api.truncateSession(taskId, target.timestamp, target.content, { rollbackFiles: false });
        // 3) 等本地删除落地后再重发
        await truncated;
        // 清除撤回备份：本条消息即将被重发，避免「恢复」把旧消息重复插回
        useStore.getState().setTruncateBackup(taskId, undefined);
        sendMessage(target.content, {
          taskId,
          ...(target.attachments?.length ? { attachments: target.attachments } : {}),
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('task.regenerateFailed'));
      }
    },
    [taskId, isGenerating, sendMessage, t],
  );

  // ===== 手动压缩流程 =====
  /** 点击压缩按钮：拉取预览并弹确认框（运行中禁用由按钮 disabled 保证） */
  const handleCompactClick = useCallback(async () => {
    if (!taskId || isGenerating) return;
    setCompactDialogOpen(true);
    setCompactPreview(null);
    setCompactPreviewLoading(true);
    try {
      const preview = await api.compactPreview(taskId);
      setCompactPreview(preview);
    } catch {
      // 预览失败（无引擎/会话空）：弹框仍显示，提示不可压缩
      setCompactPreview(null);
    } finally {
      setCompactPreviewLoading(false);
    }
  }, [taskId, isGenerating]);

  /** 确认压缩：执行手动压缩，完成后 toast（卡片由 WS compaction-completed 插入消息流） */
  const handleCompactConfirm = useCallback(async () => {
    if (!taskId || compacting) return;
    setCompacting(true);
    try {
      const result = await api.manualCompact(taskId);
      if (result.ok && result.compaction) {
        // WS 不可达时兜底插入卡片 + 更新 stats
        const s = useStore.getState();
        const existing = s.messagesBySession[taskId] ?? [];
        if (!existing.some((m) => m.id === `compaction_${result.compaction!.id}`)) {
          s.setMessages(taskId, [
            ...existing,
            {
              id: `compaction_${result.compaction.id}`,
              role: 'assistant',
              content: result.compaction.summary,
              timestamp: result.compaction.at,
              compaction: result.compaction,
            },
          ]);
        }
        void api.getContextStats(taskId).then((stats) => useStore.getState().setContextStats(taskId, stats)).catch(() => {});
        setCompactDialogOpen(false);
      } else {
        toast.error(result.error ?? t('context.compactFailed'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('context.compactFailed'));
    } finally {
      setCompacting(false);
    }
  }, [taskId, compacting, t]);

  // 右侧面板内容（移动端 Sheet 与桌面端 aside 共用，避免重复 JSX）
  const rightPanelContent = (
    <>
      {/* Panel Header：标签页栏 + 加号下拉菜单 */}
      <div className="flex h-12 items-center gap-2 border-b border-border px-3">
        {/* 标签页栏 */}
        {/* 左滚动箭头：仅当左侧还有未滚动到内容时显示（与附件栏同款规则） */}
        {canScrollTabsLeft && (
          <button
            type="button"
            onClick={() => scrollTabs(-1)}
            title={t('task.scrollTabsLeft')}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        <DndContext
          sensors={tabSensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
          onDragEnd={handleTabDragEnd}
        >
          <SortableContext items={sidebarTabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            <div
              ref={tabBarRef}
              onScroll={onTabBarScroll}
              className="flex flex-1 items-center gap-1.5 overflow-x-auto no-scrollbar scroll-smooth"
            >
              {sidebarTabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTab?.id}
                  canShowClose={tab.type !== 'start'}
                  onSelect={(id) => setActiveSidebarTab(taskId, id)}
                  onRemove={(id) => removeSidebarTab(taskId, id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        {/* 右滚动箭头：仅当右侧还有未滚动到内容时显示 */}
        {canScrollTabsRight && (
          <button
            type="button"
            onClick={() => scrollTabs(1)}
            title={t('task.scrollTabsRight')}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
        {/* 加号下拉菜单：新建标签页（仅显示当前标签栏中未打开的类型） */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title={t('task.add')}
              disabled={allTabTypesOpen}
            >
              <Plus />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={4} collisionPadding={8}>
            {!hasSummaryTab && (
              <DropdownMenuItem
                onSelect={() => addSidebarTab(taskId, 'summary', 'task.taskSummary')}
              >
                <List className="size-4" />
                {t('task.taskSummary')}
              </DropdownMenuItem>
            )}
            {!hasTerminalTab && (
              <DropdownMenuItem
                onSelect={() => addSidebarTab(taskId, 'terminal', 'terminal.title')}
              >
                <Terminal className="size-4" />
                {t('terminal.title')}
              </DropdownMenuItem>
            )}
            {!hasAgenteamTab && (
              <DropdownMenuItem
                onSelect={() => addSidebarTab(taskId, 'agenteam', 'agenteam.title')}
              >
                <Users className="size-4" />
                {t('agenteam.title')}
              </DropdownMenuItem>
            )}
            {!hasFilesTab && (
              <DropdownMenuItem
                onSelect={() => addSidebarTab(taskId, 'files', 'task.files')}
              >
                <Folder className="size-4" />
                {t('task.files')}
              </DropdownMenuItem>
            )}
            {!hasChangesTab && (
              <DropdownMenuItem
                onSelect={() => addSidebarTab(taskId, 'changes', 'task.fileChanges')}
              >
                <FileDiff className="size-4" />
                {t('task.fileChanges')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 标签内容路由 */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {activeTab?.type === 'start' && <StartPanel onOpen={openTabType} />}
        {activeTab?.type === 'summary' && (
          <>
            <TodoProgressCard
              todos={todos}
              variant="sidebar"
              className="border-b border-border"
            />
            {/* Context Section（上下文引擎：token 构成/缓存命中/动态分类/手动压缩） */}
            <div className="flex flex-1 flex-col gap-2 overflow-hidden p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span>{t('task.context')}</span>
                  <Info className="size-3 text-muted-foreground" />
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={isGenerating || compacting || !taskId}
                  title={isGenerating ? t('context.compressDisabledRunning') : t('context.compressHint')}
                  onClick={handleCompactClick}
                >
                  {compacting ? <Loader2 className="size-3.5 animate-spin" /> : <Package className="size-3.5" />}
                  {t('task.compress')}
                </Button>
              </div>

              {/* token 构成堆叠条 + 百分比 + 缓存命中率徽章 */}
              <div className="flex items-center gap-2">
                {contextStats ? (
                  <ContextStackedBar stats={contextStats} />
                ) : (
                  <>
                    <Progress value={contextPercent} className="flex-1" />
                    <span className="text-xs text-muted-foreground">{contextPercent}%</span>
                  </>
                )}
                {contextStats?.avgHitRate != null && (
                  <span
                    className="flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] tabular-nums"
                    title={t('context.cacheHitHint')}
                    style={{
                      color: contextStats.avgHitRate >= 0.6 ? '#10b981' : contextStats.avgHitRate >= 0.3 ? '#f59e0b' : '#ef4444',
                      borderColor: contextStats.avgHitRate >= 0.6 ? '#10b98155' : contextStats.avgHitRate >= 0.3 ? '#f59e0b55' : '#ef444455',
                    }}
                  >
                    <Zap className="size-2.5" />
                    {Math.round(contextStats.avgHitRate * 100)}%
                  </span>
                )}
              </div>

              {/* 动态标签：默认 系统；LLM 读取文件后自动切到 文件；有活跃技能/压缩摘要时动态追加 */}
              <Tabs
                value={contextTabValue}
                onValueChange={(v) => {
                  contextTabUserTouchedRef.current = true;
                  setContextTab(v);
                }}
                className="flex flex-1 flex-col gap-2 overflow-hidden"
              >
                <TabsList>
                  <TabsTrigger value="system">{t('context.tabSystem')}</TabsTrigger>
                  <TabsTrigger value="files">{t('task.files')}</TabsTrigger>
                  {contextStats?.breakdown?.summary ? (
                    <TabsTrigger value="summary">{t('context.tabSummary')}</TabsTrigger>
                  ) : null}
                </TabsList>

                {/* 系统标签页：折叠栏展示系统上下文各段（身份/规则/规范引导/环境/工具定义/技能） */}
                <TabsContent value="system" className="flex-1 min-h-0 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="flex flex-col gap-1 pr-1">
                      {contextStats?.systemSections?.length ? (
                        contextStats.systemSections.map((section) => (
                          <SystemSectionItem key={section.id} section={section} />
                        ))
                      ) : (
                        <span className="px-2 py-4 text-xs text-muted-foreground">
                          {t('context.noSystemSections')}
                        </span>
                      )}
                      {/* 压缩摘要折叠栏（系统页常驻入口） */}
                      {contextStats?.compaction?.lastCompaction && (
                        <SystemSectionItem
                          section={{
                            id: 'last-compaction',
                            title: t('context.lastCompaction'),
                            tokens: contextStats.compaction?.activeSummaryTokens ?? 0,
                            content: contextStats.compaction?.lastCompaction?.summary ?? '',
                            defaultOpen: false,
                          }}
                        />
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* 文件标签页：上下文文件轨迹 */}
                <TabsContent value="files" className="flex-1 min-h-0 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="flex w-full flex-col gap-0.5">
                      {contextFiles.length === 0 ? (
                        <span className="px-2 py-4 text-xs text-muted-foreground">
                          {t('task.noContextFiles')}
                        </span>
                      ) : (
                        contextFiles.map((file) => {
                          // 文件已被删除（事件 reason）或磁盘上不存在（后端存在性校验 missing）→ 灰色 + 删除线 + 禁用
                          const removed = file.reason === 'delete' || file.missing === true;
                          // 分离 文件名 / 目录部分（同时兼容 / 与 \；无分隔符时 dir 为空）
                          const sepIdx = Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\'));
                          const name = sepIdx >= 0 ? file.path.slice(sepIdx + 1) : file.path;
                          const dir = sepIdx >= 0 ? file.path.slice(0, sepIdx) : '';
                          return (
                            <Button
                              key={file.path}
                              variant="ghost"
                              size="xs"
                              disabled={removed}
                              onClick={() => openFilePreview(taskId, file.path, { fromSidebar: true })}
                              className="w-full min-w-0 justify-start gap-1.5 font-normal"
                              title={removed ? t('task.fileRemovedFromContext') : file.path}
                            >
                              <FileText
                                className={cn('size-3.5 shrink-0', removed ? 'text-muted-foreground' : 'text-primary-strong')}
                              />
                              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden text-left">
                                <span className={cn('max-w-[60%] shrink-0 truncate', removed && 'text-muted-foreground line-through')}>
                                  {name}
                                </span>
                                {dir && (
                                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>
                                )}
                              </span>
                            </Button>
                          );
                        })
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* 摘要标签页：活跃压缩摘要全文 */}
                {contextStats?.breakdown?.summary ? (
                  <TabsContent value="summary" className="flex-1 min-h-0 overflow-hidden">
                    <ScrollArea className="h-full">
                      <div className="whitespace-pre-wrap break-words px-1 py-2 text-xs leading-relaxed text-foreground">
                        {contextStats.compaction?.lastCompaction?.summary ??
                          t('context.noSummary')}
                      </div>
                    </ScrollArea>
                  </TabsContent>
                ) : null}
              </Tabs>
            </div>
          </>
        )}
        {activeTab?.type === 'terminal' && (
          <TerminalPanel key={taskId} sessionId={taskId || TERMINAL_SCRATCH_SCOPE} />
        )}
        {activeTab?.type === 'agenteam' && <AgenteamPanel />}
        {activeTab?.type === 'files' && <FileBrowserPanel key={taskId} sessionId={taskId} />}
        {activeTab?.type === 'changes' && <FileChangesPanel key={taskId} sessionId={taskId} />}
        {activeTab?.type === 'file' && (activeTab.filePath || activeTab.archiveEntry) && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {fileTabSource ? (
              <FilePreviewPane source={fileTabSource} active sessionId={taskId} />
            ) : (
              <FilePreviewPane path={activeTab.filePath} active sessionId={taskId} />
            )}
          </div>
        )}
      </div>
    </>
  );

  /**
   * 回复结尾索引（一次性 O(n) 预计算；见 lib/reply-end.ts）：
   * - replyEndIds：所有「一段 AI 回复的结尾」消息 id → 这些消息才挂「复制」按钮
   * - lastReplyEndId：最新的一段回复结尾 → 仅它挂「重新生成 / 诊断(Harness)」
   */
  const { replyEndIds, lastReplyEndId } = useMemo(() => computeReplyEnds(messages), [messages]);

  /**
   * 消息条目渲染（稳定引用）：避免 TaskPage 任意状态变化都让虚拟列表整片重渲。
   * inViewport（精确视口内）→ deferContent=false：可见项首帧直接渲染终态（完整 Markdown/思考），
   * 不再先出「纯文本占位」再升级；overscan 区条目仍走占位→渐进水合（升级发生在视口外，不可见）。
   */
  const renderItem = useCallback(
    (msg: TaskMessage, _index: number, inViewport: boolean) => {
      // 复制按钮：每条「总 AI 消息」（每段回复结尾）都带
      const showActions = replyEndIds.has(msg.id);
      // 重新生成 / 诊断(Harness)：仅最新的一段回复结尾
      const isLastReply = msg.id === lastReplyEndId;
      return (
        <div className="px-4 pb-4">
          <MessageErrorBoundary>
            <MessageBubble
              message={msg}
              todos={todos}
              toolIconMap={toolIconMap}
              toolResults={toolResultIndex}
              truncateDisabled={isGenerating}
              onTruncate={handleTruncateClick}
              onCopy={handleCopyMessage}
              onRegenerate={handleRegenerate}
              regenerateDisabled={isGenerating}
              showActions={showActions}
              showRegenerate={isLastReply}
              showDiagnose={isLastReply}
              onDiagnose={handleDiagnose}
              onDiagnoseHarness={handleDiagnoseHarness}
              onContinue={handleContinue}
              continueDisabled={isGenerating}
              onOpenAttachment={openAttachment}
              deferContent={!inViewport}
            />
          </MessageErrorBoundary>
        </div>
      );
    },
    [
      todos,
      toolIconMap,
      toolResultIndex,
      replyEndIds,
      lastReplyEndId,
      isGenerating,
      handleTruncateClick,
      handleCopyMessage,
      handleRegenerate,
      handleDiagnose,
      handleDiagnoseHarness,
      handleContinue,
      openAttachment,
    ],
  );

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Task Area */}
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {/* Task Header — 移动端：三栏 grid（左 trigger + 新建快捷 + 居中标题 + 右按钮） */}
        <div className="grid h-12 grid-cols-3 items-center px-3 md:hidden">
          <div className="flex items-center gap-1">
            <SidebarTrigger />
            {/* 新建对话快捷入口：复用侧边栏「新任务」按钮逻辑；仅浏览任务时显示，
                侧边栏抽屉展开时自动消失（抽屉内已有该按钮） */}
            {taskId && !openMobile && (
              <Button
                variant="ghost"
                size="icon-sm"
                title={t('sidebar.newTask')}
                aria-label={t('sidebar.newTask')}
                onClick={() => {
                  useStore.getState().setActiveTaskId(null);
                  useStore.getState().setActiveSession(null);
                  navigate('/task');
                }}
              >
                <MessageCirclePlus />
              </Button>
            )}
          </div>
          <h2 className="truncate text-center text-sm font-medium text-foreground">
            {task?.title ?? fallbackTitle ?? t('task.newTask')}
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={() => setRightPanelOpen(taskId, !rightPanelOpen)}
            title={rightPanelOpen ? t('task.collapseRightPanel') : t('task.expandRightPanel')}
          >
            <PanelRight />
          </Button>
        </div>
        {/* Task Header — 桌面端：标题 + 右按钮 */}
        <div className="hidden h-12 items-center justify-between px-4 md:flex">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">
              {task?.title ?? fallbackTitle ?? t('task.newTask')}
            </h2>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRightPanelOpen(taskId, !rightPanelOpen)}
            title={rightPanelOpen ? t('task.collapseRightPanel') : t('task.expandRightPanel')}
          >
            <PanelRight />
          </Button>
        </div>

        {/* 文件索引构建进度（构建期间显示，全就绪时隐藏） */}
        <FileIndexProgressBar />

        {/* 对话列：固定最大宽度（CHAT_MAX_WIDTH_PX）+ 水平居中；可用宽度不足时由 w-full 自动收缩。
            header 与文件索引进度条保持整宽，以保证桌面端 header 右侧的面板开关始终贴着右栏 */}
        <div
          className="mx-auto flex min-h-0 w-full flex-1 flex-col"
          style={{ maxWidth: chatMaxWidth }}
        >
        {/* Task Messages（自建虚拟列表：无论会话多长，DOM 中只挂载视口附近的消息；
            relative wrapper 让「返回底部」按钮悬浮于滚动区上方、不随内容滚动） */}
        <div className="relative min-h-0 flex-1">
          {/* 三态门控：有消息 → 列表；空白页或**已确认**为空 → 欢迎页；
              非空白页且历史尚未加载 → 不渲染（纯空白）。
              「加载中（状态未知）」与「确认为空（状态已知）」必须区分：前者渲染欢迎页会与随后的
              记录形成「欢迎页 → 记录」整块内容切换（用户看到的「闪两次」根因）。
              加载态刻意不放 spinner/骨架屏，保持与页面底色一致的空白，记录到达后直接出现。 */}
          {messages.length > 0 ? (
            /* 仅在已有消息时才挂载虚拟列表：空数据时先挂载会让列表停在顶部
               （切回会话/刷新后不显示最新消息）。自建列表 initialBottom 兜底首帧定位；
               容器不做整体淡入（opacity 起点为 0 会造成暗色主题下「黑一下」的空帧）。 */
            <VirtualList
              className="task-scroll-area"
              apiRef={listApiRef}
              items={messages}
              // 会话标识：合并路由后切换会话不再重挂组件，列表需据此重置贴底跟随与高度缓存
              sessionKey={taskId}
              // 稳定 key：分页 prepend 后同一消息的 key 不变（不会整列表重挂载）
              itemKey={(m) => m.id}
              // 滚动容器句柄：startReached 需据 scrollTop 判定「是否真的在顶部」
              registerScroller={(el) => {
                scrollerElRef.current = el;
              }}
              onStartReached={handleStartReached}
              initialBottom
              // 仅在「已在底部」时跟随追加：用户上滑看历史时绝不打扰
              followOutput
              atBottomThreshold={100}
              onAtBottomChange={handleAtBottomChange}
              overscan={600}
              renderItem={renderItem}
              // 列表头：加载更早的指示（已到最早时不再显示任何提示）
              header={
                messages.length === 0 ? null : (
                  <div className="flex items-center justify-center py-2 text-xs text-muted-foreground">
                    {loadingBefore ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="size-3.5 animate-spin" />
                        {t('task.loadingEarlier')}
                      </span>
                    ) : hasMoreBefore ? (
                      <span>{t('task.scrollUpForEarlier')}</span>
                    ) : null}
                  </div>
                )
              }
              footer={
                showTailThinking ? (
                  <div className="flex items-center gap-2 px-4 pb-4 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    <span className="text-sm">{t('task.thinking')}</span>
                  </div>
                ) : (
                  <div className="h-2" />
                )
              }
            />
          ) : taskId === '' || historyLoaded ? (
            /* 欢迎页：仅「空白页（无历史可加载）」或「历史已加载且确认为空」两种情况渲染。
               运行中/空白页发送中补一行「响应中…」，不做假等待。 */
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <img src="/MOSS.png" alt="MOSS" className="size-18 object-cover" />
              <p className="text-xl font-semibold text-muted-foreground">
                {t(getGreetingKey())}{t('task.greeting.prompt')}
              </p>
              {isGenerating && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <span className="text-sm">{t('task.thinking')}</span>
                </div>
              )}
            </div>
          ) : null}
          {/* 返回底部按钮：不在底部时显示；流式生成中显示顺时针跑马灯 */}
          <ScrollToBottomButton
            // 仅在列表存在（有消息）时才可能显示；空白页 / 未加载时按钮无语义，直接隐藏
            visible={messages.length > 0 && !atBottom}
            streaming={isGenerating}
            onClick={() => scrollToBottom('smooth')}
          />
        </div>

        {/* 消息撤回确认弹窗（预览卡片：将删除的消息 + 将回滚的文件变更） */}
        <Dialog
          open={truncateTarget !== null}
          onOpenChange={(open) => {
            if (!open && !truncating) {
              setTruncateTarget(null);
              setTruncatePreview(null);
            }
          }}
        >
          <DialogContent size="md">
            <DialogHeader>
              <DialogTitle>{t('task.truncateTitle')}</DialogTitle>
              <DialogDescription>
                {t('task.truncateDescription')}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="text-sm">
              {truncateLoading ? (
                <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <span className="text-xs">{t('task.truncateLoading')}</span>
                </div>
              ) : (
                <>
                  {/* 将删除的消息 */}
                  <div>
                    <div className="mb-1 text-xs font-medium text-foreground">
                      {t('task.truncateMessages', { count: truncatePreview?.messagesToRemove.length ?? 0 })}
                    </div>
                    <div className="no-scrollbar max-h-32 overflow-auto rounded-md border border-border p-2">
                      {truncatePreview && truncatePreview.messagesToRemove.length > 0 ? (
                        truncatePreview.messagesToRemove.map((m) => (
                          <div key={m.index} className="whitespace-nowrap py-0.5 text-xs text-muted-foreground">
                            <span className="mr-1 opacity-60">[{m.role}]</span>
                            {m.content}
                          </div>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('task.truncateNoPreview')}</span>
                      )}
                    </div>
                  </div>
                  {/* 将回滚的文件变更 */}
                  <div>
                    <div className="mb-1 flex items-center gap-1 text-xs font-medium text-foreground">
                      <FileWarning className="size-3.5 text-amber-500" />
                      {t('task.truncateFiles', { count: truncatePreview?.fileChanges.length ?? 0 })}
                    </div>
                    {/* 回滚被跳过的原因（诚实降级：不再静默，用户明确知道文件不会回滚） */}
                    {truncatePreview?.rollbackSkippedReason && (
                      <div className="mb-1 rounded-md border border-amber-300/60 bg-amber-50/60 px-2 py-1.5 text-xs text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400">
                        {truncatePreview.rollbackSkippedReason === 'no-file-history'
                          ? t('task.truncateSkipNoHistory')
                          : t('task.truncateSkipNoTimestamp')}
                      </div>
                    )}
                    <div className="no-scrollbar max-h-32 overflow-auto rounded-md border border-border p-2">
                      {truncatePreview && truncatePreview.fileChanges.length > 0 ? (
                        truncatePreview.fileChanges.map((f) => (
                          <div key={`${f.absPath}-${f.timestamp}`} className="whitespace-nowrap py-0.5 text-xs text-muted-foreground">
                            <span className="mr-1 rounded bg-muted px-1 py-px text-[10px]">{f.operation}</span>
                            {f.absPath}
                          </div>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('task.truncateNoFiles')}</span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTruncateTarget(null);
                  setTruncatePreview(null);
                }}
                disabled={truncating}
              >
                {t('task.truncateCancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleTruncateConfirm}
                disabled={truncateLoading || truncating}
              >
                {truncating ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
                {t('task.truncateConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* AI 错误诊断弹窗（仅错误报告；链路式流式）：错误卡头部「错误诊断」按钮触发 */}
        <InsightDialog
          open={diagnosisOpen}
          onOpenChange={setDiagnosisOpen}
          title={t('task.errorDiagnoseTitle')}
          kind="cause"
          icon={<Stethoscope className="size-4 text-destructive" />}
          {...(taskId ? { sessionId: taskId } : {})}
          providerError={diagnosisError}
        />

        {/* Harness 缺陷诊断弹窗（链路式流式）：操作栏「诊断」按钮触发（基于当前会话任务流链路 + 日志） */}
        <InsightDialog
          open={harnessOpen}
          onOpenChange={setHarnessOpen}
          title={t('task.harnessDiagnoseTitle')}
          kind="harness"
          icon={<Stethoscope className="size-4 text-primary-strong" />}
          {...(taskId ? { sessionId: taskId } : {})}
        />

        {/* 手动压缩确认框：预估压缩范围/收益/保留尾部 */}
        <Dialog open={compactDialogOpen} onOpenChange={(open) => !compacting && setCompactDialogOpen(open)}>
          <DialogContent size="md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-1.5">
                <Package className="size-4 text-primary-strong" />
                {t('context.compactDialogTitle')}
              </DialogTitle>
              <DialogDescription>{t('context.compactDialogDesc')}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              {compactPreviewLoading ? (
                <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>{t('context.compactPreviewLoading')}</span>
                </div>
              ) : compactPreview && compactPreview.compactableCount > 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md border border-border p-2">
                      <div className="text-muted-foreground">{t('context.compactableMessages')}</div>
                      <div className="mt-0.5 text-base font-medium tabular-nums text-foreground">
                        {compactPreview.compactableCount}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <div className="text-muted-foreground">{t('context.compactableTokens')}</div>
                      <div className="mt-0.5 text-base font-medium tabular-nums text-foreground">
                        ~{compactPreview.compactableTokens.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <div className="text-muted-foreground">{t('context.tailKeepCount')}</div>
                      <div className="mt-0.5 text-base font-medium tabular-nums text-foreground">
                        {compactPreview.tailKeepCount}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <div className="text-muted-foreground">{t('context.estimatedAfter')}</div>
                      <div className="mt-0.5 text-base font-medium tabular-nums text-emerald-500">
                        ~{compactPreview.estimatedAfterTokens.toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div className="rounded-md bg-muted/50 p-2 text-xs leading-relaxed text-muted-foreground">
                    {t('context.compactDialogNote')}
                  </div>
                </>
              ) : (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  {t('context.compactNothing')}
                </div>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCompactDialogOpen(false)}
                disabled={compacting}
              >
                {t('task.truncateCancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleCompactConfirm}
                disabled={compacting || compactPreviewLoading || !compactPreview || compactPreview.compactableCount === 0}
              >
                {compacting ? <Loader2 className="size-3.5 animate-spin" /> : <Package className="size-3.5" />}
                {t('context.compactConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 通用中控岛：独立于发送框的平级组件（todo / ask / 权限确认），默认折叠。
            连接状态胶囊置于 chips 行最左（「空闲/运行中」状态的右边，替代原常驻状态条） */}
        <div className="shrink-0 px-3">
          <ControlHub
            leading={<ConnectionStatusTag sessionId={taskId} />}
            status={
              isGenerating ? (
                <>
                  <Loader2 className="size-3.5 animate-spin text-primary-strong" />
                  <span className="text-xs font-medium text-primary-strong">{t('hub.statusRunning')}</span>
                </>
              ) : (
                <>
                  <Circle className="size-2.5 fill-current text-muted-foreground/50" />
                  <span className="text-xs font-medium text-muted-foreground">{t('hub.statusIdle')}</span>
                </>
              )
            }
            activeModuleId={hubActiveModule}
            onActiveModuleChange={handleHubModuleChange}
            modules={[
              {
                id: 'todo',
                icon: ListTodo,
                title: t('hub.todoModule'),
                badge: todos.filter((td) => td.status !== 'completed').length,
                render: () =>
                  todos.length === 0 ? (
                    <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground">
                      <ListTodo className="size-3.5" />
                      {t('task.noTodos')}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {todos.map((item) => (
                        <TodoRow key={item.id} item={item} />
                      ))}
                    </div>
                  ),
              },
              // 队列模块：排队等待发送的消息（合并为一条），仅当队列非空时出现
              ...(messageQueue.length > 0
                ? [
                    {
                      id: 'queue',
                      icon: Inbox,
                      title: t('hub.queueModule'),
                      badge: messageQueue.length,
                      render: () => {
                        const queued = messageQueue[0];
                        if (!queued) return null;
                        const text =
                          stripMentionTokens(
                            stripAttachmentBlock(stripInjectBlock(queued.content)),
                            lookups,
                          ) ||
                          (queued.attachments?.[0] ? fileNameOf(queued.attachments[0]) : queued.content);
                        const iconBtn =
                          'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';
                        return (
                          <div className="flex flex-col gap-2">
                            {/* 头行：图标 + 计数 + 右侧三键（编辑 / 删除 / 中断发送） */}
                            <div className="flex items-center gap-2">
                              <Inbox className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-semibold text-foreground">
                                {messageQueue.length}
                              </span>
                              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => editQueuedMessage(taskId, queued.id)}
                                  className={iconBtn}
                                  title={t('hub.editQueued')}
                                >
                                  <SquarePen className="size-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeFromMessageQueue(taskId, queued.id)}
                                  className={iconBtn}
                                  title={t('hub.deleteQueued')}
                                >
                                  <Trash2 className="size-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void sendQueuedNow(taskId, queued.id)}
                                  className={iconBtn}
                                  title={t('hub.sendQueuedNow')}
                                >
                                  <ArrowUp className="size-3.5" />
                                </button>
                              </div>
                            </div>
                            {/* 正文：合并后的完整内容（换行 + 分隔符已保留） */}
                            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-2 text-xs leading-relaxed text-foreground">
                              {text}
                            </div>
                          </div>
                        );
                      },
                    },
                  ]
                : []),
              // ask 模块：动态独立分类，仅当存在待回答提问时出现
              ...(pendingAsks.filter((a) => a.sessionId === taskId).length > 0
                ? [
                    {
                      id: 'ask',
                      icon: HelpCircle,
                      title: t('hub.askModule'),
                      badge: pendingAsks.filter((a) => a.sessionId === taskId).length,
                      render: () => (
                        <div className="flex flex-col gap-2.5">
                          {pendingAsks
                            .filter((a) => a.sessionId === taskId)
                            .map((ask) => (
                              <AskPromptCard
                                key={ask.toolCallId}
                                ask={ask}
                                className="border-0 bg-transparent p-0 shadow-none"
                              />
                            ))}
                        </div>
                      ),
                    },
                  ]
                : []),
              {
                id: 'permission',
                icon: ShieldCheck,
                title: t('hub.permissionModule'),
                badge: pendingConfirms.filter((c) => c.sessionId === taskId).length,
                render: () => {
                  const confirms = pendingConfirms.filter((c) => c.sessionId === taskId);
                  if (confirms.length === 0) {
                    return (
                      <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground">
                        <ShieldCheck className="size-3.5" />
                        {t('hub.noPending')}
                      </div>
                    );
                  }
                  return (
                    <div className="flex flex-col gap-2.5">
                      {confirms.map((cf) => (
                        <ConfirmPromptCard
                          key={cf.toolCallId}
                          confirm={cf}
                          className="border-0 bg-transparent p-0 shadow-none"
                        />
                      ))}
                    </div>
                  );
                },
              },
            ]}
          />
        </div>

        {/* Task Input */}
        <div className="shrink-0 p-3 pt-1.5">
          <TaskInput
            isGenerating={isGenerating}
            showDirectoryBadge={messages.length === 0 && !isGenerating}
            onAbort={() => abort(taskId)}
            onOpenOverlay={onOpenOverlay}
            onSend={handleSend}
            onOpenAttachment={openAttachment}
          />
          {/* 运行指标栏（轮/步/耗时累计 + 引擎实时 token/命中） */}
          <StatsBar stats={runStats} contextStats={contextStats} />
        </div>
        </div>
      </div>

      {/* Right Panel — 移动端：Sheet 抽屉；桌面端：内嵌 aside */}
      {isMobile ? (
        <Sheet open={rightPanelOpen} onOpenChange={(open) => setRightPanelOpen(taskId, open)}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="w-[85%] max-w-sm gap-0 bg-card p-0 text-card-foreground"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t('task.taskSummary')}</SheetTitle>
              <SheetDescription>{t('task.taskSummary')}</SheetDescription>
            </SheetHeader>
            {rightPanelContent}
          </SheetContent>
        </Sheet>
      ) : (
        // 常驻渲染 + 宽度过渡（替代条件挂载的瞬跳）：收起时 width=0 由 overflow-hidden 裁切。
        // 拖拽调宽时移除 transition 保证跟手；invisible 离散过渡：收起动画播完才隐藏、展开立即显示
        <aside
          className={cn(
            'anim-panel relative flex flex-col overflow-hidden border-l border-border bg-card',
            !rightResize.resizing && 'transition-[width,visibility] duration-200 ease-out',
            !rightPanelOpen && 'invisible',
          )}
          style={{ width: rightPanelOpen ? rightPanelPx : 0 }}
          aria-hidden={!rightPanelOpen}
        >
          <div
            {...rightResize.bind}
            className="absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-col-resize touch-none select-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent hover:after:bg-border"
          />
          {/* 内容固定宽度 wrapper：宽度动画期间内容不被挤压变形（外层裁切） */}
          <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ width: rightPanelPx }}>
            {rightPanelContent}
          </div>
        </aside>
      )}
    </div>
  );
}

/** 右侧面板标签页（支持拖拽排序） */
interface SortableTabProps {
  tab: SidebarTab;
  isActive: boolean;
  canShowClose: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}
function SortableTab({ tab, isActive, canShowClose, onSelect, onRemove }: SortableTabProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  // 追踪拖拽状态：拖拽结束后抑制紧随的 click 事件
  const wasDragRef = useRef(false);
  useEffect(() => {
    if (isDragging) {
      wasDragRef.current = true;
    } else if (wasDragRef.current) {
      const timer = setTimeout(() => { wasDragRef.current = false; });
      return () => clearTimeout(timer);
    }
  }, [isDragging]);

  // ── 移动端：长按 → 显示删除按钮（桌面端仍为常亮 × 按钮） ──
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  /** 长按计时器 */
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 长按起始坐标（位移超阈值即取消，交给拖拽） */
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  /** 本次长按已触发（抑制长按释放时紧随的 click，避免刚出现就被点掉） */
  const longPressFiredRef = useRef(false);
  /** 长按判定时长 */
  const LONG_PRESS_MS = 500;
  /** 位移阈值（超过则视为拖拽，取消长按） */
  const MOVE_CANCEL_PX = 8;

  const clearPressTimer = useCallback(() => {
    if (pressTimerRef.current !== null) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  // 合并 ref（本组件根节点 + dnd 排序节点）：稳定引用，避免每次渲染重建导致节点 detach/attach
  const mergedRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  // 长按监听：原生 pointer 事件（不侵入 dnd-kit 的 listeners，二者共存）
  useEffect(() => {
    if (!isMobile || !canShowClose) return;
    const el = rootRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      longPressFiredRef.current = false;
      pressStartRef.current = { x: e.clientX, y: e.clientY };
      clearPressTimer();
      pressTimerRef.current = setTimeout(() => {
        pressTimerRef.current = null;
        longPressFiredRef.current = true;
        setShowDelete(true);
      }, LONG_PRESS_MS);
    };
    const onMove = (e: PointerEvent) => {
      const start = pressStartRef.current;
      if (!start) return;
      if (Math.abs(e.clientX - start.x) > MOVE_CANCEL_PX || Math.abs(e.clientY - start.y) > MOVE_CANCEL_PX) {
        clearPressTimer();
      }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', clearPressTimer);
    el.addEventListener('pointercancel', clearPressTimer);
    el.addEventListener('pointerleave', clearPressTimer);
    return () => {
      clearPressTimer();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', clearPressTimer);
      el.removeEventListener('pointercancel', clearPressTimer);
      el.removeEventListener('pointerleave', clearPressTimer);
    };
  }, [isMobile, canShowClose, clearPressTimer]);

  // 组件卸载清理计时器
  useEffect(() => clearPressTimer, [clearPressTimer]);

  // 拖拽开始：取消长按并隐藏删除按钮（拖拽排序优先）
  useEffect(() => {
    if (isDragging) {
      clearPressTimer();
      setShowDelete(false);
    }
  }, [isDragging, clearPressTimer]);

  // 删除按钮显示期间：点击标签外部任意处 → 收起
  useEffect(() => {
    if (!showDelete) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setShowDelete(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [showDelete]);

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return (
    <div
      ref={mergedRef}
      data-tab-id={tab.id}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => {
        if (wasDragRef.current) {
          wasDragRef.current = false;
          return;
        }
        // 长按释放紧随的 click：不切换也不收起（保留刚出现的删除按钮）
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false;
          return;
        }
        // 移动端已显示删除按钮时，点击标签本体 → 收起
        if (isMobile && showDelete) {
          setShowDelete(false);
          return;
        }
        onSelect(tab.id);
      }}
      className={cn(
        'group relative flex cursor-grab select-none items-center gap-1.5 rounded-lg border px-3 py-1 text-sm transition-colors',
        isDragging && 'z-10 border-border bg-muted text-foreground shadow-sm',
        isActive
          ? 'border-border bg-muted text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      {tab.type === 'start' ? (
        <Compass className="size-3.5" />
      ) : tab.type === 'terminal' ? (
        <Terminal className="size-3.5" />
      ) : tab.type === 'agenteam' ? (
        <Users className="size-3.5" />
      ) : tab.type === 'files' ? (
        <Folder className="size-3.5" />
      ) : tab.type === 'changes' ? (
        <FileDiff className="size-3.5" />
      ) : tab.type === 'file' ? (
        <FileTypeIcon fileName={tab.title} size={14} className="shrink-0" />
      ) : (
        <List className="size-3.5" />
      )}
      <span
        className={cn('truncate', tab.type === 'file' ? 'max-w-[160px]' : 'max-w-[120px]')}
        title={tab.type === 'file' ? tab.title : undefined}
      >
        {tab.type === 'file' ? tab.title : t(tab.title)}
      </span>
      {/* 关闭/删除：桌面端常亮 × 按钮；移动端长按后浮现删除按钮（单标签不显示） */}
      {canShowClose && !isDragging && (
        isMobile ? (
          showDelete ? (
            <button
              type="button"
              aria-label={t('task.deleteTab')}
              title={t('task.deleteTab')}
              onClick={(e) => {
                e.stopPropagation();
                setShowDelete(false);
                onRemove(tab.id);
              }}
              className="ml-0.5 flex size-5 shrink-0 items-center justify-center rounded text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : null
        ) : (
          <button
            type="button"
            aria-label={t('task.deleteTab')}
            title={t('task.deleteTab')}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(tab.id);
            }}
            className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-muted"
          >
            <X className="size-3" />
          </button>
        )
      )}
    </div>
  );
}

/** 「开始」标签页：面板启动器（任务摘要 / 终端 / 专家团 / 文件 / 文件变更），点击行打开或切换到对应标签 */
interface StartPanelProps {
  /** 点击某行：已开该类型标签则激活，未开则新建（title 为 i18n key） */
  onOpen: (type: 'summary' | 'terminal' | 'agenteam' | 'files' | 'changes', titleKey: string) => void;
}
function StartPanel({ onOpen }: StartPanelProps) {
  const { t } = useTranslation();
  const rows: Array<{
    type: 'summary' | 'terminal' | 'agenteam' | 'files' | 'changes';
    titleKey: string;
    descKey: string;
    Icon: typeof List;
  }> = [
    {
      type: 'summary',
      titleKey: 'task.taskSummary',
      descKey: 'start.summaryDesc',
      Icon: List,
    },
    {
      type: 'terminal',
      titleKey: 'terminal.title',
      descKey: 'start.terminalDesc',
      Icon: Terminal,
    },
    {
      type: 'agenteam',
      titleKey: 'agenteam.title',
      descKey: 'start.agenteamDesc',
      Icon: Users,
    },
    {
      type: 'files',
      titleKey: 'task.files',
      descKey: 'start.filesDesc',
      Icon: Folder,
    },
    {
      type: 'changes',
      titleKey: 'task.fileChanges',
      descKey: 'start.changesDesc',
      Icon: FileDiff,
    },
  ];
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-4">
      <div className="flex w-full max-w-xs flex-col items-center">
        <Compass className="mb-3 size-10 text-muted-foreground/40" strokeWidth={1.5} />
        <p className="mb-8 text-xs text-muted-foreground">{t('start.hint')}</p>
        <div className="flex w-full flex-col gap-3">
          {rows.map(({ type, titleKey, descKey, Icon }) => (
            <button
              key={type}
              type="button"
              onClick={() => onOpen(type, titleKey)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-muted/30 px-3.5 py-3 text-left transition-colors hover:bg-muted"
            >
              <Icon className="size-5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">{t(titleKey)}</span>
                <span className="truncate text-xs text-muted-foreground">{t(descKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** token 数人性化：1048576→1M、1572864→1.5M、2299→2.3k、100000→100k、194→194 */
function formatTokens(n: number): string {
  const trim = (s: string) => (s.endsWith('.0') ? s.slice(0, -2) : s);
  if (n >= 1_000_000) return trim((n / 1_000_000).toFixed(1)) + 'M';
  if (n >= 1_000) return trim((n / 1_000).toFixed(1)) + 'k';
  return String(n);
}

/** 占用百分比分级精度：≥1% 取整；0.1%~1% 保留 1 位小数；<0.1% 显示下限标记。
 *  修复大窗口低占用时 Math.round 抹成 0% 的缺陷 */
function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const pct = ratio * 100;
  if (pct >= 1) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${pct.toFixed(1)}%`;
  return '<0.1%';
}

/** token 构成堆叠条：system/env/summary/history 分段配色 + 占用百分比。
 *  分段宽度基于上下文窗口：各段之和 = 实际占用，剩余空白 = 未占用。
 *  统一口径：usedTokens（LLM 真实上报 promptTokens）优先于 breakdown 估算，
 *  与底部 StatsBar"输入"同源同值；无样本时回退发送视图估算。
 *  悬停显示完整占用明细：分段构成/剩余可用/上次请求/缓存命中/自动压缩阈值 */
function ContextStackedBar({ stats }: { stats: ContextStats }) {
  const { t } = useTranslation();
  const { breakdown, windowTokens, lastUsage, avgHitRate, compaction } = stats;
  const window = Math.max(1, windowTokens);
  const usedTokens = lastUsage?.promptTokens ?? null;
  const total = usedTokens && usedTokens > 0 ? usedTokens : breakdown.total;
  // 分段按 breakdown 占比缩放到 total（真实占用与估算存在系统性偏差时保持构成比例）
  const scale = breakdown.total > 0 ? total / breakdown.total : 0;
  const segments = [
    { key: 'system', value: breakdown.system, color: 'bg-blue-700', label: t('context.segSystem') },
    { key: 'env', value: breakdown.env, color: 'bg-teal-500', label: t('context.segEnv') },
    { key: 'summary', value: breakdown.summary, color: 'bg-amber-500', label: t('context.segSummary') },
    { key: 'history', value: breakdown.history, color: 'bg-blue-500', label: t('context.segHistory') },
    // 规则/记忆注入段（新后端字段；值为 0 时不渲染——旧数据无噪声）
    ...(breakdown.rules ? [{ key: 'rules', value: breakdown.rules, color: 'bg-violet-500', label: t('context.segRules') }] : []),
    ...(breakdown.memory ? [{ key: 'memory', value: breakdown.memory, color: 'bg-rose-500', label: t('context.segMemory') }] : []),
  ];
  const percentText = formatPercent(total / window);
  const usedText = formatTokens(total);
  const windowText = formatTokens(windowTokens);
  // 悬停完整明细（原生 title 支持 \n 多行）：占用 + 分段 + 剩余 + 上次请求 + 缓存命中 + 压缩阈值
  const titleLines: string[] = [
    t('context.usageTitle', { used: usedText, total: windowText, percent: percentText }),
    ...segments.map((s) => `${s.label}: ${formatTokens(s.value)}`),
    t('context.hoverRemaining', { remaining: formatTokens(Math.max(0, window - total)) }),
  ];
  if (lastUsage) {
    titleLines.push(
      t('context.hoverLastUsage', {
        prompt: formatTokens(lastUsage.promptTokens),
        completion: formatTokens(lastUsage.completionTokens),
        cached: formatTokens(lastUsage.cachedTokens),
      }),
    );
  }
  if (lastUsage && avgHitRate != null) {
    titleLines.push(
      t('context.hoverCacheHit', {
        rate: formatPercent(lastUsage.promptTokens > 0 ? lastUsage.cachedTokens / lastUsage.promptTokens : 0),
        avg: formatPercent(avgHitRate),
      }),
    );
  }
  if (compaction?.enabled) {
    const threshold = window * compaction.compactRatio;
    const left = threshold - total;
    titleLines.push(
      left >= 0
        ? t('context.hoverCompactThreshold', {
            threshold: formatTokens(threshold),
            left: formatTokens(left),
          })
        : t('context.hoverCompactReached', { threshold: formatTokens(threshold) }),
    );
  }
  const barTitle = titleLines.join('\n');
  return (
    <div className="flex flex-1 items-center gap-2">
      <div
        className="flex h-2 flex-1 overflow-hidden rounded-full bg-muted"
        title={barTitle}
      >
        {segments.map((s) => (
          <div
            key={s.key}
            className={s.color}
            style={{ width: `${Math.min(100, ((s.value * scale) / window) * 100)}%` }}
          />
        ))}
      </div>
      <span
        className="text-xs tabular-nums text-muted-foreground"
        title={barTitle}
      >
        {percentText}
      </span>
    </div>
  );
}

/** 系统上下文分段折叠栏（「系统」标签页内的动态一栏栏） */
function SystemSectionItem({
  section,
}: {
  section: { id: string; title: string; tokens: number; content: string; defaultOpen?: boolean };
}) {
  return (
    <Collapsible defaultOpen={section.defaultOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:text-foreground">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        <span className="truncate font-medium">{section.title}</span>
        <span className="ml-auto shrink-0 tabular-nums">~{section.tokens}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed">
          {section.content}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 渲染单条消息 */
interface MessageBubbleProps {
  message: TaskMessage;
  todos: TodoItem[];
  toolIconMap: Record<string, string>;
  /** 工具结果全局索引（跨消息匹配；见页面内的 buildToolResultIndex） */
  toolResults: Map<string, ToolResultEntry>;
  /** 流式生成中禁用撤回（防竞态） */
  truncateDisabled?: boolean;
  onTruncate?: (message: TaskMessage) => void;
  onCopy?: (content: string) => void;
  /** 统一 AI 回复操作栏「重新生成」：重跑该回复所对应的用户消息（回滚到该 user 消息后重发） */
  onRegenerate?: (message: TaskMessage) => void;
  /** 生成中禁用重新生成（防并发 run） */
  regenerateDisabled?: boolean;
  /** 是否渲染操作栏（每条「总 AI 消息」= 每段回复结尾都为 true；复制按钮据此出现） */
  showActions?: boolean;
  /** 是否展示「重新生成」按钮（仅最新一段回复结尾为 true） */
  showRegenerate?: boolean;
  /** 是否展示「诊断(Harness)」按钮（仅最新一段回复结尾为 true；错误卡不展示） */
  showDiagnose?: boolean;
  /** 错误卡片「诊断」：打开 AI 错误诊断弹窗（入参为原始 provider 错误文本） */
  onDiagnose?: (errorDetail: string) => void;
  /** 操作栏「诊断」：打开 Harness 缺陷诊断弹窗 */
  onDiagnoseHarness?: () => void;
  /** 轮数触顶卡「继续执行」：发送继续消息起新 run（轮数重新计数） */
  onContinue?: () => void;
  /** 生成中禁用继续按钮（防并发 run） */
  continueDisabled?: boolean;
  /** 点击用户消息附件卡片：在右侧边栏打开该文件预览标签页 */
  onOpenAttachment?: (path: string) => void;
  /**
   * 是否允许渐进渲染占位（默认 true 保持既有行为）。
   * 首屏可见项传 false → 直接完整渲染 Markdown（首帧即终态，无「明文占位→升级」闪动）；
   * overscan 区条目传 true → 占位后渐进水合（升级在视口外，不可见）。
   */
  deferContent?: boolean;
}
const MessageBubble = memo(function MessageBubble({ message, todos, toolIconMap, toolResults, truncateDisabled, onTruncate, onCopy, onRegenerate, regenerateDisabled, showActions, showRegenerate, showDiagnose, onDiagnose, onDiagnoseHarness, onContinue, continueDisabled, onOpenAttachment, deferContent = true }: MessageBubbleProps) {
  const { t } = useTranslation();
  // 超长正文截断渲染（防止单条巨型文本布局卡死）；展开后完整渲染。
  // 流式生成中超限时显示尾部（正在生成的内容在末尾），结束后恢复头部截断。
  const [expanded, setExpanded] = useState(false);
  // 显式思考：流式思考期间每 100ms 刷新一次「当前时刻」，驱动状态行秒数递增（0.1s 分辨率；非思考消息不启动定时器）
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!message.thinkingStreaming) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(id);
  }, [message.thinkingStreaming]);
  // 思考已用时（毫秒；渲染时经 formatThinkingSeconds 格式化）：
  // ① 完成后优先用后端持久化的 thinkingMs（刷新/重进会话仍可见）
  // ② 否则用本地记录的 thinkingStartedAt（流式中实时计时，完成后用 thinkingEndedAt 冻结兜底）
  // ③ 都没有（旧数据）→ 不显示秒数
  let thinkMs: number | null = null;
  if (message.thinkingMs != null) {
    thinkMs = Math.max(0, message.thinkingMs);
  } else if (message.thinkingStartedAt) {
    const started = Date.parse(message.thinkingStartedAt);
    if (Number.isFinite(started)) {
      if (message.thinkingStreaming) {
        thinkMs = Math.max(0, nowMs - started);
      } else if (message.thinkingEndedAt) {
        const ended = Date.parse(message.thinkingEndedAt);
        if (Number.isFinite(ended)) thinkMs = Math.max(0, ended - started);
      }
    }
  }
  // 思考预览：仅流式期间展示最新片段（单行截断交给 CSS）
  const thinkPreview = message.thinkingStreaming ? thinkingPreview(message.thinking) : '';
  // 命令注入块（LLM 可见、UI 不可见）先剥离：气泡/附件解析/正文/复制都在「可见文本」上进行，
  // 刷新后从会话 JSON 重新加载同样走这里 → 不会突然显现模板正文
  const visibleContent = stripInjectBlock(message.content);
  const overLimit = visibleContent.length > MAX_RENDER_CHARS;
  const displayContent = overLimit && !expanded
    ? message.streaming
      ? '…' + visibleContent.slice(-MAX_RENDER_CHARS)
      : visibleContent.slice(0, MAX_RENDER_CHARS) + '…'
    : visibleContent;
  // 用户消息附件：结构化字段优先（新消息，后端持久化），缺失时回退解析正文附件块（老会话）。
  // 正文一律剥离附件块，避免把 "附件：- 路径" 原文渲染进气泡。
  const parsed = message.role === 'user' ? parseAttachmentBlock(visibleContent) : null;
  const structuredPaths = message.attachments?.length ? message.attachments : null;
  const userPaths = structuredPaths ?? parsed?.paths ?? [];
  const userBody = structuredPaths
    ? (parsed?.body ?? stripAttachmentBlock(visibleContent))
    : (parsed?.body ?? visibleContent);
  const userBodyOverLimit = userBody.length > MAX_RENDER_CHARS;
  const userBodyDisplay = userBodyOverLimit && !expanded
    ? message.streaming
      ? '…' + userBody.slice(-MAX_RENDER_CHARS)
      : userBody.slice(0, MAX_RENDER_CHARS) + '…'
    : userBody;
  const hasUserBody = userBody.trim().length > 0;

  // 系统提示消息：居中气泡（防御性保留；skill 持久模式已废弃，正常流程不再产生）
  if (message.role === 'system') {
    return (
      <div className="flex justify-center">
        <div className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
          <Sparkles className="size-3 shrink-0" />
          <span className="max-w-md truncate">{message.content}</span>
        </div>
      </div>
    );
  }
  // 上下文压缩卡片：独立于普通气泡的居中卡片（前后 token 对比 + 摘要可展开）
  if (message.compaction) {
    return <CompactionCard compaction={message.compaction} />;
  }
  // 轮数触顶提示卡：居中卡片（上限说明 + 继续执行按钮）
  if (message.maxTurnsNotice) {
    return (
      <MaxTurnsNoticeCard
        notice={message.maxTurnsNotice}
        onContinue={onContinue}
        disabled={continueDisabled}
      />
    );
  }
  // 输出长度触顶提示卡：居中卡片（截断说明 + 继续生成按钮）
  if (message.outputLimitNotice) {
    return (
      <OutputLimitNoticeCard
        notice={message.outputLimitNotice}
        onContinue={onContinue}
        disabled={continueDisabled}
      />
    );
  }
  // 防御：tool 已被适配层合并进 assistant；此处不应出现
  if (message.role === 'tool') return null;
  if (message.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-1">
        {userPaths.length > 0 && (
          <MessageAttachmentCards paths={userPaths} onOpen={onOpenAttachment ?? (() => {})} />
        )}
        {/* 只发附件不打字时正文为空：不渲染空气泡，只显示上方附件卡片行 */}
        {hasUserBody && (
        <div className="max-w-[80%] rounded-2xl border border-border bg-indigo-100 px-3 py-2 text-sm text-foreground shadow-sm break-words whitespace-pre-wrap dark:bg-blue-600 dark:text-white dark:shadow-[0_2px_14px_rgba(37,99,235,0.35)]">
        <MentionTokenText text={userBodyDisplay} onOpenFile={onOpenAttachment ?? (() => {})} />
      </div>
        )}
      {userBodyOverLimit && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="max-w-[80%] self-end rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={t('task.messageTruncated')}
        >
          {expanded ? t('task.todoCollapse') : t('task.messageExpand')}
        </button>
      )}
        {/* 操作行：复制 + 撤回（hover 显示；触屏常显；生成中撤回禁用） */}
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
          <button
            type="button"
            title={t('task.messageCopy')}
            aria-label={t('task.messageCopy')}
            onClick={() => onCopy?.(visibleContent)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Copy className="size-3.5" />
          </button>
          <button
            type="button"
            title={truncateDisabled ? t('task.truncateDisabled') : t('task.truncateMessage')}
            aria-label={t('task.truncateMessage')}
            disabled={truncateDisabled}
            onClick={() => onTruncate?.(message)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Undo2 className="size-3.5" />
          </button>
        </div>
      </div>
    );
  }

  // 工具调用分流：agent 调用走专属卡片，其余走通用折叠卡（todo/ask 另有专属渲染）
  const agentCalls = message.toolCalls?.filter((tc) => isAgentCall(tc)) ?? [];
  const otherCalls =
    message.toolCalls?.filter(
      (tc) => tc.name !== 'todo' && tc.name !== 'ask' && !isAgentCall(tc),
    ) ?? [];

  // 模型请求失败「系统错误卡片」：实时（WS error）与历史恢复（system-error 消息）同构渲染。
  // 顶部固定标题 + 右侧「错误诊断」按钮；底部操作栏（复制 + 重新生成）仅在回复结尾出现，且不含 Harness 诊断。
  if (message.isError) {
    return (
      <SystemErrorCard
        message={message}
        onCopy={onCopy}
        onRegenerate={onRegenerate ? () => onRegenerate(message) : undefined}
        regenerateDisabled={regenerateDisabled}
        showActions={showActions}
        showRegenerate={showRegenerate}
        onDiagnose={onDiagnose}
      />
    );
  }

  // assistant 消息
  return (
    <div className="group/message flex flex-col gap-2">
      {/* 上次进程中断遗留的未完成回复：明确标注（避免被误认为完整回答） */}
      {message.interrupted && (
        <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
          <CircleAlert className="size-3.5 shrink-0" />
          <span>{t('task.interruptedReply')}</span>
        </div>
      )}
      {/* thinking 折叠区：显式思考状态行（默认折叠；流式中展示实时秒数与最新片段预览，完成后保留总耗时） */}
      {message.thinking && (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
            {message.thinkingStreaming ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <Atom className="size-3.5 shrink-0" />
            )}
            <span className="shrink-0">
              {message.thinkingStreaming ? t('task.thinkingStreaming') : t('task.thinkingDone')}
            </span>
            {thinkMs != null && (
              <>
                <span className="shrink-0">·</span>
                <span className="shrink-0 tabular-nums">
                  {t('task.thinkingElapsed', { sec: formatThinkingSeconds(thinkMs) })}
                </span>
              </>
            )}
            {/* 预览仅在折叠态展示：展开后全文可见，隐藏预览避免重复 */}
            {thinkPreview && (
              <span className="group-open:hidden flex min-w-0 items-center gap-1.5">
                <span className="shrink-0">·</span>
                <span className="min-w-0 truncate text-muted-foreground/70">{thinkPreview}</span>
              </span>
            )}
          </summary>
          <div className="mt-1">
            <MarkdownRenderer
              text={message.thinking}
              streaming={!!message.thinkingStreaming}
              variant="compact"
              defer={deferContent && !message.thinkingStreaming}
            />
          </div>
        </details>
      )}
      {/* 正文 */}
      {message.content && !message.isError && (
        <div className="text-sm text-foreground">
          {/* 流式 spinner 经 cursor 渲染进文本流末尾，与最后一行文字同行（见 MarkdownRenderer / markdown.css） */}
          <MarkdownRenderer
            text={displayContent}
            streaming={!!message.streaming}
            defer={deferContent && !message.streaming}
            cursor={message.streaming ? <Loader2 className="ml-1 inline size-3 animate-spin" /> : undefined}
          />
        </div>
      )}
      {overLimit && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={t('task.messageTruncated')}
        >
          {expanded ? t('task.todoCollapse') : t('task.messageExpand')}
        </button>
      )}
      {/* agent 工具调用 → 按 mode 分派专属卡片（统一机器人图标 Bot）：
          mode=subagent → Subagent 卡片（角色名 + 状态徽章 + 树形任务 + 运行中事件计数 + 可展开微缩任务流/报告）
          mode=agenteam → 专家团卡片（团队名 + 任务数 + 进度点阵 + 阶段徽章 + 成员头像任务行，行可展开）
          结果统一从全局索引取（长耗时工具的结果消息未必紧邻本消息） */}
      {agentCalls.map((tc) => {
        const matched = toolResults.get(tc.id);
        const resultText = matched?.text;
        const args = parseAgentArgs(tc) ?? {};
        if (args.mode === 'agenteam') {
          const plan: InlineTeamPlan | null = args.name
            ? {
                name: args.name,
                members: (args.members ?? []).map((m) => ({
                  name: m.name ?? '',
                  role: m.role,
                  agentId: m.agentId,
                })),
                tasks: (args.tasks ?? []).map((t) => ({
                  subject: t.subject ?? '',
                  assignee: t.assignee,
                })),
              }
            : null;
          // 从结果文本 "团队已创建：id=<teamId> phase=..." 提取团队 id 绑定实时数据
          const teamId = resultText?.match(/id=([A-Za-z0-9_-]+)/)?.[1] ?? null;
          return <AgenteamInlineCard key={tc.id} plan={plan} teamId={teamId} />;
        }
        // 默认按 subagent 渲染（mode=subagent 或参数缺失兜底，保证不丢卡）
        return (
          <SubagentInlineCard
            key={tc.id}
            template={args.template ?? ''}
            task={args.task ?? ''}
            status={tc.status}
            resultText={resultText}
            isError={matched?.isError}
          />
        );
      })}
      {/* todo 工具调用 → 在任务流中渲染 TodoProgressCard（像其他工具一样在调用位置显示）。
          渲染条件基于消息自身快照（?? 回落到 store）：store 被清空不牵连历史卡片。 */}
      {message.toolCalls?.some((tc) => tc.name === 'todo') && (message.todoSnapshot ?? todos).length > 0 && (
        <TodoProgressCard todos={message.todoSnapshot ?? todos} variant="inline" />
      )}
      {/* ask 工具调用 → 渲染为问答卡片（仅已完成、有结果时渲染；进行中的由底部 AskPromptCard 处理） */}
      {message.toolCalls?.filter((tc) => tc.name === 'ask').map((tc) => {
        const matchedResult = message.toolResults?.find((tr) => tr.toolCallId === tc.id);
        if (!matchedResult) return null; // 只渲染已完成的 ask
        const fullText = matchedResult.result.content
          .filter((c) => c.type === 'text')
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n');
        // 工具返回固定格式「问题：X\n用户回答：Y」；问题优先取 arguments，回答取"用户回答："之后的部分
        let replyText = fullText;
        const answerMarker = fullText.indexOf('用户回答：');
        if (answerMarker !== -1) {
          replyText = fullText.slice(answerMarker + '用户回答：'.length);
        }
        let questionText = '';
        try {
          questionText = (JSON.parse(tc.arguments || '{}') as { question?: string }).question ?? '';
        } catch {
          questionText = '';
        }
        return (
          <div
            key={tc.id}
            className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3 shadow-sm"
          >
            <div className="flex items-center gap-1.5">
              <HelpCircle className="size-3.5 text-primary-strong" />
              <span className="text-xs font-medium text-foreground">{t('task.askTitle')}</span>
            </div>
            <div>
              <div className="text-xs text-muted-foreground/70">{t('task.askQuestion')}</div>
              <p className="whitespace-pre-wrap text-sm text-foreground">{questionText}</p>
            </div>
            {replyText && (
              <div>
                <div className="text-xs text-muted-foreground/70">{t('task.askReply')}</div>
                <p className="whitespace-pre-wrap text-sm text-foreground">{replyText}</p>
              </div>
            )}
          </div>
        );
      })}
      {/* 非 todo/ask/agent 工具调用（可折叠：展开显示参数与结果）。
          agent 工具已由上方专属卡片渲染。 */}
      {otherCalls.length > 0 && (
        <div className="flex flex-col gap-1">
          {otherCalls.map((tc) => {
            const matchedResult = message.toolResults?.find((tr) => tr.toolCallId === tc.id);
            // 结果文本/错误标记回退到全局索引：长耗时工具的结果消息可能不紧邻本消息
            const indexed = toolResults.get(tc.id);
            const resultText = matchedResult
              ? matchedResult.result.content
                  .filter((c) => c.type === 'text')
                  .map((c) => (c.type === 'text' ? c.text : ''))
                  .join('\n')
              : indexed?.text;
            const isError = matchedResult?.result.isError ?? indexed?.isError;
            // MCP 扩展：structuredContent（结构化输出）/ resources（资源引用）
            const structured = matchedResult?.result.metadata?.structuredContent;
            const resources = matchedResult?.result.metadata?.resources;
            let prettyArgs = tc.arguments;
            try {
              prettyArgs = JSON.stringify(JSON.parse(tc.arguments || '{}'), null, 2);
            } catch {
              // 非 JSON，原样显示
            }
            return (
              <details key={tc.id} className="group px-2 py-1">
                <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                  {tc.status === 'generating' || tc.status === 'executing' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : isError ? (
                    <CircleAlert className="size-3.5 text-destructive" />
                  ) : (
                    (() => {
                      const ToolIcon = resolveToolIcon(tc.name, toolIconMap);
                      return <ToolIcon className="size-3.5" />;
                    })()
                  )}
                  <span>{tc.name}</span>
                </summary>
                <div className="mt-1 flex flex-col gap-2 rounded-md border border-border p-2 text-xs max-h-[300px] overflow-auto no-scrollbar">
                  {tc.arguments && (
                    <div>
                      <div className="text-muted-foreground/70">{t('task.toolCallArguments')}</div>
                      <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-foreground">
                        {prettyArgs}
                      </pre>
                    </div>
                  )}
                  {resultText && (
                    <div>
                      <div className={cn('text-muted-foreground/70', isError && 'text-destructive/80')}>
                        {isError ? t('task.errorResult') : t('task.result')}
                      </div>
                      <pre className={cn(
                        'mono mt-0.5 whitespace-pre-wrap break-all',
                        isError ? 'text-destructive' : 'text-foreground',
                      )}>
                        {resultText}
                      </pre>
                    </div>
                  )}
                  {/* MCP structuredContent：结构化输出 JSON */}
                  {structured && (
                    <div>
                      <div className="text-muted-foreground/70">{t('task.structuredOutput')}</div>
                      <pre className="mono mt-0.5 whitespace-pre-wrap break-all text-foreground">
                        {JSON.stringify(structured, null, 2)}
                      </pre>
                    </div>
                  )}
                  {/* MCP resources：资源引用卡片（uri + mimeType + 可展开 text） */}
                  {resources && resources.length > 0 && (
                    <div>
                      <div className="text-muted-foreground/70">{t('task.resourceRefs', { count: resources.length })}</div>
                      <div className="mt-0.5 flex flex-col gap-1">
                        {resources.map((r) => (
                          <details key={r.uri} className="group/res rounded border border-border px-1.5 py-1">
                            <summary className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                              <ChevronRight className="size-3 transition-transform group-open/res:rotate-90" />
                              <FileText className="size-3 shrink-0" />
                              <span className="truncate">{r.uri}</span>
                              {r.mimeType && (
                                <span className="ml-auto shrink-0 rounded bg-muted px-1 py-px text-[10px]">{r.mimeType}</span>
                              )}
                            </summary>
                            {r.text && (
                              <pre className="mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-foreground">
                                {r.text}
                              </pre>
                            )}
                          </details>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
      {/* 统一 AI 回复操作栏：仅在「一段回复的结尾」渲染（复制每条都有；重新生成/诊断仅最新一段） */}
      {showActions && !message.streaming && (visibleContent.trim().length > 0 || (message.toolCalls?.length ?? 0) > 0) && (
        <MessageActions
          content={visibleContent}
          onCopy={onCopy}
          onRegenerate={onRegenerate ? () => onRegenerate(message) : undefined}
          regenerateDisabled={regenerateDisabled}
          showRegenerate={showRegenerate}
          showDiagnose={showDiagnose}
          onDiagnose={onDiagnoseHarness}
        />
      )}
    </div>
  );
});
