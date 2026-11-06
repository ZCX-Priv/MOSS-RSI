// webui/src/hooks/useSessionHistory.ts
// 会话级编排：订阅 + 状态快照 + 分页加载 + 断线重连对齐 + 半截流式续接。
//
// 契约（根治「任务在后台跑、刷新后却显示已完成」）：
// - running（= 前端 generatingBySession）只由权威信号写入：
//     ① 状态快照 GET /api/session/:id/state（**只升不降**：false 竞态不熄灭本地刚点亮的转圈）
//     ② WS session.subscribed 快照（含后端 activeRuns 实况）
//     ③ 完成类事件（done / task.aborted / error / automation.finished）
//     ④ 本地发送与主动中断
//   **历史/快照的任何拉取都不得把 running 置 false**（降级只走完成事件与快照兜底分支）。
// - 半截回复恢复：快照 liveDraft → 落成本地消息（id = 服务端 messageId）→ 后续分片按 offset 续接。
// - 打开已有会话：store 有缓存时**直渲染**（stale-while-revalidate），仅做尾部增量对齐，
//   不再闪骨架屏；无缓存才走首屏分页 + 骨架屏。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import { useStore } from '../store';
import { pendingAssistant, pendingGuideRunIds, pendingRunId } from '../lib/pending-assistant';
import {
  flushPending,
  finishResync,
  getLastStreamAppliedAt,
  onStreamResyncNeeded,
  resetStreamBuffer,
} from '../lib/stream-buffer';
import {
  adoptAuthoritativeRunId,
  attachLiveDraft,
  fetchTailPages,
  onHistoryInvalidated,
  onSessionSnapshot,
  onStreamSettled,
} from '../lib/ws-events';
import { diag, diagAlways } from '../lib/diag';
import { withRetry } from '../lib/retry';
import { runWhenIdle } from '../lib/idle';
import type { VirtualListApi } from '../lib/virtual-list/VirtualList';
import type { SessionState, TaskMessage } from '../types/api';

/** 首屏与每页条数：30 条约占一屏多，JSON 体积可控（超长会话首屏不再传全量） */
export const HISTORY_PAGE_SIZE = 30;
/**
 * 预取页条数：20 条 ≈ 1.5~2 屏。
 * 该会话（长思考型）平均约 42KB/条，20 条约 0.8MB JSON —— 解析+适配可在一次事件循环内完成；
 * 60 条约 2.5MB，已越过卡顿阈值（快速上滑黑屏的直接来源）。
 */
const HISTORY_PREFETCH_PAGE_SIZE = 20;
/** 每个会话始终保持的预取页数（滚动停止后补足 2 页，避免快速上滑断档） */
const HISTORY_PREFETCH_PAGES = 2;
/** 速度感知预取的触发冷却（ms）：同一会话至少间隔这么久才允许再发一次预取 */
const PREFETCH_TRIGGER_COOLDOWN_MS = 150;

export interface UseSessionHistoryResult {
  /** 加载更早的一页（列表到达顶部时回调） */
  loadOlder: () => void;
  /** 是否还有更早的消息 */
  hasMoreBefore: boolean;
  /** 是否正在加载更早的一页 */
  loadingBefore: boolean;
  /** 首屏是否已加载完成（骨架屏判定） */
  loaded: boolean;
  /** 整体重载末页（撤回/恢复后游标失效、外部需要强制刷新时使用） */
  reload: () => Promise<void>;
  /** 高速滚动时主动补页（预取更多） */
  prefetchMore: () => void;
}

/** 首屏空结果重试间隔：等待后端把 task.stream 的 user 消息持久化到内存会话 */
const FIRST_PAGE_RETRY_DELAY_MS = 250;

/** 生成态看门狗轮询间隔（ms）：仅在本地处于「生成中」时运行 */
const WATCHDOG_INTERVAL_MS = 15_000;
/** 宽限期（ms）：发送后「前端已点亮、后端尚未注册 run」存在竞态，期内不做任何降级判定 */
const WATCHDOG_GRACE_MS = 20_000;
/** 连续 N 次读到后端「非运行」才判定终态事件丢失（防止单次抖动误收尾） */
const WATCHDOG_FALSE_STREAK = 2;
/**
 * 生成中「零进展」阈值（ms）：后端确认在跑、但本地超过该时长没有任何分片落地，
 * 或服务端草稿明显领先本地 → 用 /state 草稿做一次权威对账（最多一个 tick 的延迟）。
 */
const STREAM_IDLE_RECONCILE_MS = 10_000;
/**
 * 本地 run 的「新鲜窗口」：超过该时长仍没有任何进展，才允许被旧快照/看门狗收敛。
 * 覆盖「发送后后端注册 run 的竞态」与「长工具执行期间无流式分片」的两种情况。
 */
const RUN_STALE_GRACE_MS = 90_000;

export function useSessionHistory(
  taskId: string,
  apiRef?: RefObject<VirtualListApi | null>,
): UseSessionHistoryResult {
  /** 已请求过首屏的会话（避免重复拉取；切换会话时重置） */
  const loadedRef = useRef<string | null>(null);
  /**
   * 会话级「尾部补齐」串行化（按 sessionId 分组）。
   * 之前是全局 boolean：上一会话的补齐在途时，新会话的 catchUpTail 直接 return，
   * 导致切换后长时间等不到尾部对齐（「切换 session 加载半天」的根因之一）。
   */
  const catchupBusyRef = useRef<Set<string>>(new Set());
  /** 预取串行化（按会话）与游标 */
  const prefetchBusyRef = useRef<Set<string>>(new Set());
  const prefetchCursorRef = useRef<Map<string, number>>(new Map());
  /** 预取触发冷却（按会话）：速度感知预取至少间隔 300ms，避免滚动中连续请求 */
  const prefetchLastAtRef = useRef<Map<string, number>>(new Map());
  /** loadOlder 同步防重入（按会话）：一次只合并一页，避免同一帧连续消费多页缓存 */
  const loadOlderBusyRef = useRef<Set<string>>(new Set());

  const hasMoreBefore = useStore((s) => s.historyMetaBySession[taskId]?.hasMoreBefore ?? false);
  const loadingBefore = useStore((s) => s.historyMetaBySession[taskId]?.loadingBefore ?? false);
  const metaLoaded = useStore((s) => s.historyMetaBySession[taskId]?.loaded ?? false);
  /**
   * 首屏是否已就绪。
   * 空白页（taskId === ''，即「新任务」页）**没有任何历史可加载**，语义上就是「已加载」——
   * 否则欢迎页会被"加载中"门控挡住，只剩一片骨架/空白。
   */
  const loaded = taskId === '' ? true : metaLoaded;

  /** 尾部增量补齐：把本地流式草稿替换为服务端正式消息（一轮结束 / 重连后） */
  const catchUpTail = useCallback(
    async (sessionId: string, dropStreaming: boolean) => {
      // 按会话串行：不同会话可并发补齐，互不阻塞
      if (catchupBusyRef.current.has(sessionId)) return;
      catchupBusyRef.current.add(sessionId);
      // 状态胶囊提示「正在同步最新消息…」（一轮结束 / 重连对齐期间可见）
      useStore.getState().setSyncing(sessionId, true);
      try {
        flushPending();
        const st = useStore.getState();
        // 关键：在发起网络拉取**之前**快照「当前仍在本轮流式的消息 id」。
        // dropStreaming 只允许丢这些（即刚结束那一轮留下的草稿）；拉取期间新一轮若已开始流式，
        // 其消息不在快照内 → 必被保留，避免「新轮内容被整体清空 → 缺口连锁丢流」。
        const streamingBeforeFetch = (st.messagesBySession[sessionId] ?? [])
          .filter((m) => m.streaming)
          .map((m) => m.id);
        const meta = st.historyMetaBySession[sessionId];
        // 首屏历史尚未建立有效游标（meta 缺失或 newestIndex 仍为 -1）：HTTP 首屏
        // （含空结果重试）负责加载末页，这里必须直接跳过。
        // 否则 WS 快照先于首屏返回时（首屏 effect 已 patch 出 newestIndex=-1 的占位 meta），
        // after=-1 会把整段历史当成增量重拉——实测长会话一次请求 1.68~2.29MB，
        // 与首屏 1.09MB 叠加，正是「打开 WebUI 卡爆」的直接来源之一。
        // 首屏仍在进行中（loaded=false 且游标未建立）时跳过；首屏失败后
        // 会 patch loaded=true，此时允许这里以末页兜底恢复（不影响异常恢复路径）。
        if (!meta || (!meta.loaded && meta.newestIndex < 0)) return;
        const after = meta.newestIndex;
        const res = await fetchTailPages(sessionId, after);
        if (!res) return;
        if (res.newestIndex <= after && res.messages.length === 0) return;
        // 会话已切走：丢弃迟到结果（避免把旧会话的大对象写回并触发无意义重渲染）
        const stNow = useStore.getState();
        if (stNow.activeSessionId && stNow.activeSessionId !== sessionId) return;
        useStore.getState().mergeHistory(
          sessionId,
          res.messages,
          'catchup',
          {
            total: res.total,
            oldestIndex: useStore.getState().historyMetaBySession[sessionId]?.oldestIndex ?? 0,
            newestIndex: Math.max(res.newestIndex, after),
            hasMoreBefore: useStore.getState().historyMetaBySession[sessionId]?.hasMoreBefore ?? false,
          },
          { dropStreaming, dropStreamingIds: streamingBeforeFetch },
        );
      } finally {
        useStore.getState().setSyncing(sessionId, false);
        catchupBusyRef.current.delete(sessionId);
      }
    },
    [],
  );

  /**
   * 后台预取更早历史：始终保持缓存里至少有 pages 页。
   * 预取只写缓存（不并入可见列表），loadOlder 命中缓存时零网络等待。
   */
  const prefetchOlder = useCallback((sessionId: string, pages = HISTORY_PREFETCH_PAGES) => {
    if (!sessionId) return;
    if (prefetchBusyRef.current.has(sessionId)) return;
    // 与实时加载互斥：同一游标的实时请求在途时不重复预取（避免两个请求拉同一区间）
    if (loadOlderBusyRef.current.has(sessionId)) return;
    const st = useStore.getState();
    const meta = st.historyMetaBySession[sessionId];
    if (!meta || !meta.hasMoreBefore) return;
    // 会话已切走：不为非活跃会话消耗带宽与内存
    if (st.activeSessionId && st.activeSessionId !== sessionId) return;
    // 缓存已满足目标页数：不重复请求（滚动速度预测只补一页预算）
    const cachedCount = st.historyCacheBySession[sessionId]?.length ?? 0;
    if (cachedCount >= pages) return;
    // 冷却：滚动过程中最多每 300ms 触发一次，避免每帧请求
    const lastAt = prefetchLastAtRef.current.get(sessionId) ?? 0;
    if (Date.now() - lastAt < PREFETCH_TRIGGER_COOLDOWN_MS) return;
    prefetchLastAtRef.current.set(sessionId, Date.now());

    prefetchBusyRef.current.add(sessionId);
    void (async () => {
      try {
        const cached = useStore.getState().historyCacheBySession[sessionId] ?? [];
        // 缓存为空时从当前顶部游标开始；否则沿用已取到的最旧游标继续向前
        const cursor =
          cached.length > 0
            ? prefetchCursorRef.current.get(sessionId) ?? meta.oldestIndex
            : meta.oldestIndex;
        if (cursor <= 0) return;
        // 一次只请求一页（20 条）：预算是硬上限，绝不再退化成多页批量拉取
        const resp = await api.getSessionHistory(sessionId, {
          limit: HISTORY_PREFETCH_PAGE_SIZE,
          before: cursor,
        });
        const cur = useStore.getState();
        if (cur.activeSessionId && cur.activeSessionId !== sessionId) return;
        if (!resp.page || resp.messages.length === 0) {
          cur.patchHistoryMeta(sessionId, { hasMoreBefore: false });
          return;
        }
        cur.cacheHistoryPage(sessionId, {
          before: cursor,
          messages: resp.messages,
          page: resp.page,
        });
        prefetchCursorRef.current.set(sessionId, resp.page.oldestIndex);
      } catch {
        // 预取失败静默：下次上滑会走实时请求
      } finally {
        prefetchBusyRef.current.delete(sessionId);
      }
    })();
  }, []);

  /** 整体重载末页：撤回了消息 / 恢复后下标变化 → 旧游标不可用，必须重新取最新一页 */
  const reload = useCallback(async (): Promise<void> => {
    if (!taskId) return;
    flushPending();
    useStore.getState().resetHistory(taskId);
    useStore.getState().clearHistoryCache(taskId);
    prefetchCursorRef.current.delete(taskId);
    prefetchLastAtRef.current.delete(taskId);
    try {
      // withRetry：后端内核启动窗口内 agent 引擎未就绪会返回 503（可重试）
      const resp = await withRetry(() => api.getSessionHistory(taskId, { limit: HISTORY_PAGE_SIZE }));
      const st = useStore.getState();
      if (st.activeSessionId && st.activeSessionId !== taskId) return;
      st.mergeHistory(
        taskId,
        resp.messages,
        'tail',
        resp.page ?? {
          total: resp.messages.length,
          oldestIndex: 0,
          newestIndex: resp.messages.length - 1,
          hasMoreBefore: false,
        },
      );
    } catch {
      useStore.getState().patchHistoryMeta(taskId, { loaded: true });
    }
  }, [taskId]);

  /**
   * 与后端权威状态对齐：运行态 / 半截草稿 / 待答 / 待确认 / 权限模式 / 统计。
   * 用于：首屏、WS 重连、offset 缺口自愈三种时机。
   */
  const reconcileFromState = useCallback(
    async (sessionId: string, opts?: { allowIdleConverge?: boolean }): Promise<void> => {
    let state: SessionState;
    try {
      state = await withRetry(() => api.getSessionState(sessionId));
    } catch {
      // 对齐失败也必须释放 resync 冷却标记：否则该消息后续所有缺口分片会被永久暂存丢弃
      finishResync(sessionId);
      return;
    }
    const st = useStore.getState();
    // 会话已切换：丢弃过期结果（避免污染新会话）
    if (st.activeSessionId && st.activeSessionId !== sessionId) {
      finishResync(sessionId);
      return;
    }

    // ① 权威运行态（只升不降）：true 直接点亮；false **不降级**——
    //    「本地已发送、后端尚未注册 run」窗口内的 /state 竞态会瞬间熄灭刚点亮的「响应中」。
    //    降级由完成类事件（done/error/aborted）与 session.subscribed running=false 兜底分支负责。
    //    allowIdleConverge 例外：终态 mismatch / 缺口自愈需要按后端权威态收敛，否则永久停在旧 run。
    if (state.running) {
      st.setGenerating(sessionId, true);
      // 权威 runId 对齐：本地 activeRun 指向旧 run 时，新 run 的流式分片会被 runId 过滤全部丢弃
      adoptAuthoritativeRunId(sessionId, state.runId);
    } else if (opts?.allowIdleConverge && !state.liveDraft && st.generatingBySession[sessionId]) {
      // 刚发起、后端尚未注册 run 的窗口内不得按空闲态收敛：否则会把新 runId 记入
      // 终止集合，使该轮全部事件被永久丢弃（这是「响应中」永挂的第二处入口）。
      // 与 session.subscribed 快照的 RUN_STALE_GRACE_MS 同口径。
      const activeRun = st.activeRunBySession[sessionId];
      const fresh = !!activeRun && Date.now() - activeRun.startedAt < RUN_STALE_GRACE_MS;
      if (fresh) {
        finishResync(sessionId);
        return;
      }
      // 后端已空闲且无半截草稿：先补齐服务端正式消息（保留半截内容），再做权威收敛
      await catchUpTail(sessionId, false);
      const cur = useStore.getState();
      if (cur.activeSessionId && cur.activeSessionId !== sessionId) {
        finishResync(sessionId);
        return;
      }
      cur.terminateRun(sessionId, cur.activeRunBySession[sessionId]?.runId);
      pendingAssistant.delete(sessionId);
      pendingRunId.delete(sessionId);
      pendingGuideRunIds.clear(sessionId);
    }

    // ② 半截流式草稿（含 stale 的历史残留）
    if (state.liveDraft && state.liveDraft.messageId) {
      attachLiveDraft({ ...state.liveDraft, sessionId });
    }

    // ③ 待答提问 / 待确认权限：先清本会话再按服务端回填（幂等）
    st.clearPendingAsksBySession(sessionId);
    st.clearPendingConfirmsBySession(sessionId);
    for (const ask of state.pendingAsks) {
      st.addPendingAsk({
        toolCallId: ask.toolCallId,
        sessionId,
        questions: ask.questions,
        createdAt: Date.now(),
      });
    }
    for (const cf of state.pendingConfirms) {
      st.addPendingConfirm({
        toolCallId: cf.toolCallId,
        sessionId,
        toolName: '',
        question: cf.question,
        ruleSuggestion: cf.ruleSuggestion,
        createdAt: Date.now(),
      });
    }

    // ④ 会话级权限模式 / 最近一次 run 统计
    if (state.permissionMode) st.setPermissionMode(state.permissionMode, sessionId);
    if (state.lastRunStats) st.setRunStats(sessionId, state.lastRunStats);

    // ⑤ 游标校正：断线期间后端可能新增了消息（本地 newestIndex 落后 → 补尾部）
    const meta = st.historyMetaBySession[sessionId];
    if (meta && state.newestIndex > meta.newestIndex) {
      await catchUpTail(sessionId, false);
    }
    // 对齐动作结束（无论是否带回草稿）：释放 resync 冷却标记，后续缺口仍能再次对齐
    finishResync(sessionId);
  }, [catchUpTail]);

  /** 首屏历史（空结果重试版）：新任务发送后 fetch 可能先于 user 消息持久化到达 → 返回空 */
  const fetchFirstPage = useCallback(async (sid: string) => {
    const localCount = () => useStore.getState().messagesBySession[sid]?.length ?? 0;
    // withRetry：引擎未就绪返回 503 时退避重试；下方循环处理「服务端已就绪但消息尚未持久化」的空结果
    let resp = await withRetry(() => api.getSessionHistory(sid, { limit: HISTORY_PAGE_SIZE }));
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!((resp.page?.total ?? resp.messages.length) === 0 && localCount() > 0)) break;
      diag('first-page-empty-retry', { sid, attempt });
      await new Promise<void>((resolve) => setTimeout(resolve, FIRST_PAGE_RETRY_DELAY_MS));
      resp = await withRetry(() => api.getSessionHistory(sid, { limit: HISTORY_PAGE_SIZE }));
    }
    return resp;
  }, []);

  // ==========================================================================
  // 挂载 / 切换会话：订阅 + 首屏（缓存直渲染 or 分页）+ 并行加载附属数据
  // ==========================================================================
  // 注意：本 effect 内的异步续体**不使用 alive 守卫**——所有写入都是「会话键控的幂等
  // 写入」（mergeHistory 按消息 id 去重、setTodos/setContext/setContextStats 全量替换、
  // 压缩卡片按 compaction_<id> 去重），迟到/重复落库无害且正好命中缓存。
  // 此前用 alive 守卫 + loadedRef 防重发，在 React StrictMode（Vite dev 双调用 effect：
  // setup→cleanup→setup）下首屏请求被丢弃且第二次 setup 跳过重发 → 刷新后消息永远不加载。
  // 视图相关的守卫统一由 activeSessionId 判定（见 reconcileFromState）。
  useEffect(() => {
    if (!taskId) {
      // 空白页（路由 /task 无 taskId）：store 的 active 指针必须与可见页面一致。
      // 否则 sendMessage 会回退到遗留的 activeTaskId，把消息投递给旧会话（且不导航），
      // 其它消费方（权限模式 / 终端作用域 / 文件预览 sessionId）也会误用旧会话。
      const st = useStore.getState();
      if (st.activeSessionId !== null) st.setActiveSession(null);
      if (st.activeTaskId !== null) st.setActiveTaskId(null);
      return;
    }
    // 先订阅：后端 session.subscribed 会带回权威快照（running / liveDraft / 游标）
    wsClient.subscribeSession(taskId);

    const st0 = useStore.getState();
    st0.setActiveSession(taskId);
    st0.setActiveTaskId(taskId);

    const isFirstLoad = loadedRef.current !== taskId;
    // 缓存直渲染判定：store 里已有该会话的消息且游标有效（切回会话 / 刚发过消息）
    const hasCache =
      (st0.messagesBySession[taskId]?.length ?? 0) > 0 &&
      (st0.historyMetaBySession[taskId]?.loaded ?? false);

    if (isFirstLoad) {
      loadedRef.current = taskId;
      resetStreamBuffer(taskId);
      st0.setWsRestoring(taskId, true);

      if (hasCache) {
        // 缓存直渲染（stale-while-revalidate）：保留已加载消息与游标（不闪骨架屏，
        // 消息直接向上浮出），仅做尾部增量对齐补齐断线期间的新消息。
        void catchUpTail(taskId, false)
          .catch(() => {})
          .finally(() => {
            useStore.getState().setWsRestoring(taskId, false);
          });
        // 延迟预取：给 catchUpTail 让路，避免同一游标并发两个请求
        window.setTimeout(() => prefetchOlder(taskId, HISTORY_PREFETCH_PAGES), 500);
      } else {
        st0.patchHistoryMeta(taskId, { loaded: false, loadingBefore: false });
        // ① 首屏历史（分页，仅末页；空结果重试等待持久化可见）+ 压缩卡：
        //    两者并行拉取后**合并为一次 store 写入**。压缩卡原先走独立异步链，会在记录
        //    渲染完成之后才插入并整体重排（用户看到的「卡片迟到 / 移位」），且 tail 合并的
        //    localOnly 会把卡片追加到末尾再由 sort 纠正（二次位移）。合并写入后首帧即含卡片。
        void Promise.all([
          fetchFirstPage(taskId),
          api.getCompactions(taskId).catch(() => null),
        ])
          .then(([resp, compactions]) => {
            const serverIds = new Set(resp.messages.map((m) => m.id));
            const cards: TaskMessage[] = (compactions?.compactions ?? [])
              .filter((c) => !serverIds.has(`compaction_${c.id}`))
              .map((c) => ({
                id: `compaction_${c.id}`,
                role: 'assistant' as const,
                content: c.summary,
                timestamp: c.at,
                compaction: c,
              }));
            // 按时间序合并：mergeHistory('tail') 保留传入顺序（resolved 原序），
            // 故卡片首帧就落在正确位置，不再有第二次插入 / 整体重排。
            const merged = [...resp.messages, ...cards].sort(
              (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
            );
            useStore.getState().mergeHistory(
              taskId,
              merged,
              'tail',
              resp.page ?? {
                total: resp.messages.length,
                oldestIndex: 0,
                newestIndex: resp.messages.length - 1,
                hasMoreBefore: false,
              },
            );
            if (resp.permissionMode) useStore.getState().setPermissionMode(resp.permissionMode, taskId);
            if (resp.lastRunStats) useStore.getState().setRunStats(taskId, resp.lastRunStats);
            // 首屏就绪后延迟预取更早历史：首屏渲染阶段可能已有一次实时 loadOlder 在途，
            // 立即预取会用同一 before 游标重复拉取（实测并发两个请求 0.6+0.8MB）。
            // 500ms 后 meta.oldestIndex 已被那次加载推进，预取自然落到更早的一页。
            window.setTimeout(() => prefetchOlder(taskId, HISTORY_PREFETCH_PAGES), 500);
          })
          .catch(() => {
            // 后端未就绪 / 会话不存在：静默（保持空态）
            useStore.getState().patchHistoryMeta(taskId, { loaded: true });
          });
      }
    }

    // ② 权威状态快照（运行态 + 半截草稿 + 待答 / 待确认）
    void reconcileFromState(taskId)
      .catch(() => {})
      .finally(() => {
        useStore.getState().setWsRestoring(taskId, false);
      });

    // ③ 附属数据（todos / 上下文文件 / 上下文统计）：右侧面板默认收起、消息流优先用
    // todoSnapshot，故延后到浏览器空闲时再拉，避免与首屏历史/渲染争抢主线程与后端。
    runWhenIdle(() => {
      void api
        .listTodos(taskId)
        .then((resp) => {
          if (resp.todos) useStore.getState().setTodos(taskId, resp.todos);
        })
        .catch(() => {});
    });
    runWhenIdle(() => {
      void api
        .getSessionContext(taskId)
        .then((ctx) => {
          useStore.getState().setContext(taskId, {
            files: ctx.files,
            totalTokens: ctx.totalTokens,
            maxTokens: ctx.maxTokens,
          });
        })
        .catch(() => {});
    });
    runWhenIdle(() => {
      void api
        .getContextStats(taskId)
        .then((stats) => {
          useStore.getState().setContextStats(taskId, stats);
        })
        .catch(() => {});
    });

    return () => {
      // 卸载时若 activeSessionId 仍指向自己则清除（防 useWebSocket 误用旧 session）。
      // 注意：不停止后端 agent.run（任务可在后台继续），也不清 pendingAssistant
      //（同一会话重新挂载时还要靠它继续接流）。
      const cur = useStore.getState().activeSessionId;
      if (cur === taskId) useStore.getState().setActiveSession(null);
    };
  }, [taskId, reconcileFromState, catchUpTail, fetchFirstPage, prefetchOlder]);

  // ==========================================================================
  // 编排信号：快照对齐 / 一轮结束补齐 / offset 缺口自愈
  // ==========================================================================
  useEffect(() => {
    if (!taskId) return;

    const unsubSnapshot = onSessionSnapshot((sessionId, payload) => {
      if (sessionId !== taskId) return;
      // 运行态：true 直接点亮（已在 ws-events 处理）；false 时**不能无条件降级**——
      // 刷新/切会话/重连期间的旧快照可能恰好落在「本地已发起、后端尚未注册 run」的窗口，
      // 无条件 setGenerating(false) 会让发送/停止按钮来回跳。只有当快照确认是同一轮、
      // 或本地本轮已超过 stale 窗口仍无进展时，才允许收敛。
      if (payload.running === false) {
        const st0 = useStore.getState();
        const active = st0.activeRunBySession[sessionId];
        const locallyGenerating = st0.generatingBySession[sessionId] ?? false;
        const sameRun =
          !!active && payload.runId !== undefined && payload.runId === active.runId;
        const stale = !active || Date.now() - active.startedAt > RUN_STALE_GRACE_MS;
        if (!sameRun && !stale) {
          // 本地有新鲜 run：只补齐尾部（若需要），绝不熄灭生成态
          void catchUpTail(sessionId, false);
          return;
        }
        // 本地流式草稿换成服务端正式消息；若本地确实处于「生成中」，统一收敛
        // （断线期间任务已完成 → done 事件丢失 → 这里兜底，杜绝 spinner 永转）
        void catchUpTail(sessionId, locallyGenerating).then(() => {
          if (!locallyGenerating) return;
          const st = useStore.getState();
          st.terminateRun(sessionId, payload.runId ?? active?.runId);
          pendingAssistant.delete(sessionId);
          pendingRunId.delete(sessionId);
          pendingGuideRunIds.clear(sessionId);
        });
      } else if (payload.running === true) {
        // 重连后仍在运行：对齐草稿（半截内容 / 工具卡片状态）
        void reconcileFromState(sessionId).catch(() => {});
      }
    });

    const unsubSettled = onStreamSettled((sessionId, reason) => {
      if (sessionId !== taskId) return;
      // 一轮结束：本地流式草稿换成服务端正式消息（含工具结果 / todo 快照）
      const drop = reason === 'done';
      void catchUpTail(sessionId, drop).then(() => {
        if (reason === 'done') pendingAssistant.delete(sessionId);
        resetStreamBuffer(sessionId);
      });
    });

    const unsubResync = onStreamResyncNeeded((sessionId) => {
      if (sessionId !== taskId) return;
      // 出现缺口（分片丢失 / 乱序）或终态 runId 不一致：用后端权威状态重建该消息内容，
      // 并按 running/runId 对齐；后端已空闲时允许收敛本地生成态（否则永久停在旧 run）。
      void reconcileFromState(sessionId, { allowIdleConverge: true }).catch(() => {});
    });

    const unsubInvalidated = onHistoryInvalidated((sessionId) => {
      if (sessionId !== taskId) return;
      // 撤回 / 恢复 / 压缩折叠：消息下标已变化 → 整体重载末页
      void reload();
    });

    return () => {
      unsubSnapshot();
      unsubSettled();
      unsubResync();
      unsubInvalidated();
    };
  }, [taskId, catchUpTail, reconcileFromState, reload]);

  // ==========================================================================
  // 生成态看门狗：把「永久卡在响应中」变成「最多 ~30s 自愈」
  //
  // 背景：running（前端 generatingBySession）只由权威信号写入，其中终态事件是唯一收敛点。
  // 一旦终态事件丢失（连接抖动 / 旧 run 迟到 / 后端崩溃重启），前端会永久停在「响应中」，
  // 只能手动刷新。本看门狗在「本地生成中」时周期向 /state 对账，后端已非运行即强制收尾。
  //
  // 保守性（避免误伤刚发出去的新 run）：
  //   ① 只在本地 generating===true 时运行；
  //   ② 发送后 20s 宽限期内不做任何判定（避开「前端已点亮、后端尚未注册 run」竞态）；
  //   ③ 需连续 2 次读到 running===false 才收尾。
  // ==========================================================================
  const isGenerating = useStore((s) => s.generatingBySession[taskId] ?? false);
  useEffect(() => {
    if (!taskId || !isGenerating) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let falseStreak = 0;
    const startedAt = Date.now();

    const tick = async (): Promise<void> => {
      if (disposed) return;
      if (useStore.getState().generatingBySession[taskId] !== true) return;
      if (Date.now() - startedAt < WATCHDOG_GRACE_MS) return;
      let state: SessionState;
      try {
        state = await api.getSessionState(taskId);
        if (disposed) return;
      } catch {
        // /state 不可用（后端重启窗口）：保持现状，下个周期再试
        return;
      }
      if (state.running) {
        falseStreak = 0;
        // 后端确认在跑，但本地长时间没有分片落地 / 服务端草稿领先：说明流被静默丢弃
        //（runId 误过滤、慢客户端丢帧等）。用权威草稿全量对齐一次，把「永久响应中」
        // 降级为最多一个 tick 的延迟；草稿与本地等长时不触发，避免无意义覆盖。
        const draft = state.liveDraft;
        if (draft && draft.messageId) {
          const local = (useStore.getState().messagesBySession[taskId] ?? []).find(
            (m) => m.id === draft.messageId,
          );
          const localLen = local ? local.content.length + (local.thinking ?? '').length : 0;
          const serverLen = draft.contentLength + draft.thinkingLength;
          const lastApplied = getLastStreamAppliedAt(taskId);
          const idleMs = lastApplied === undefined ? Infinity : Date.now() - lastApplied;
          if (idleMs > STREAM_IDLE_RECONCILE_MS && serverLen > localLen) {
            diagAlways('generation-watchdog-reconcile', {
              sessionId: taskId,
              localLen,
              serverLen,
              idleMs,
            });
            void reconcileFromState(taskId).catch(() => {});
          }
        }
        return;
      }
      falseStreak++;
      if (falseStreak < WATCHDOG_FALSE_STREAK) return;
      // 后端权威态已非运行，本地仍「生成中」= 终态事件丢失 → 强制收敛
      diagAlways('generation-watchdog-recover', { sessionId: taskId, waitedMs: Date.now() - startedAt });
      await catchUpTail(taskId, true);
      if (disposed) return;
      const st = useStore.getState();
      const active = st.activeRunBySession[taskId];
      st.terminateRun(taskId, active?.runId);
      pendingAssistant.delete(taskId);
      pendingRunId.delete(taskId);
    };

    const schedule = (): void => {
      timer = setTimeout(() => {
        void tick().finally(() => {
          if (!disposed) schedule();
        });
      }, WATCHDOG_INTERVAL_MS);
    };
    schedule();

    // 回前台立即对账一次（后台期间定时器被节流，回来时尽快恢复）
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [taskId, isGenerating, catchUpTail, reconcileFromState]);

  // ==========================================================================
  // WS 重连：重新对齐（覆盖断线期间错过的消息 / 草稿推进 / 运行态变化）
  // ==========================================================================
  const wsStatus = useStore((s) => s.wsStatus);
  const prevStatusRef = useRef(wsStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = wsStatus;
    if (!taskId) return;
    if (wsStatus === 'open' && prev !== 'open' && prev !== 'connecting') {
      // 断线后重连成功：重订阅 + 全量对齐
      wsClient.subscribeSession(taskId);
      void reconcileFromState(taskId).catch(() => {});
    }
  }, [wsStatus, taskId, reconcileFromState]);

  // ==========================================================================
  // 上滑加载更早的一页
  // ==========================================================================
  const loadOlder = useCallback(() => {
    if (!taskId) return;
    // 同步防重入：同一帧内滚动事件可能多次进入（缓存命中路径没有 loadingBefore 异步窗口），
    // 这里保证一次只合并一页、只 apply 一次 prepend 锚定。
    if (loadOlderBusyRef.current.has(taskId)) return;
    const st = useStore.getState();
    const meta = st.historyMetaBySession[taskId];
    if (!meta || !meta.hasMoreBefore || meta.loadingBefore) return;

    // 缓存优先：命中时同步合并（无网络等待，毫秒级跟手）
    const cached = st.takeCachedHistoryPage(taskId);
    if (cached) {
      const anchor = apiRef?.current?.anchorPrepend();
      useStore.getState().mergeHistory(taskId, cached.messages, 'prepend', cached.page);
      anchor?.apply();
      // 消费一页后再补足缓冲（有冷却与「缓存已满」判定，不会连环请求）
      prefetchOlder(taskId, HISTORY_PREFETCH_PAGES);
      return;
    }

    loadOlderBusyRef.current.add(taskId);
    st.patchHistoryMeta(taskId, { loadingBefore: true });
    void api
      .getSessionHistory(taskId, { limit: HISTORY_PAGE_SIZE, before: meta.oldestIndex })
      .then((resp) => {
        const cur = useStore.getState();
        if (cur.activeSessionId && cur.activeSessionId !== taskId) return;
        if (!resp.page) {
          cur.patchHistoryMeta(taskId, { loadingBefore: false, hasMoreBefore: false });
          return;
        }
        if (resp.messages.length === 0) {
          cur.patchHistoryMeta(taskId, { loadingBefore: false, hasMoreBefore: false });
          return;
        }
        // prepend 锚定：合入前捕获 scrollHeight，合入提交后按增量修正 scrollTop（视口不跳动）
        const anchor = apiRef?.current?.anchorPrepend();
        cur.mergeHistory(taskId, resp.messages, 'prepend', resp.page);
        anchor?.apply();
        // 实时请求成功后继续预取，恢复缓冲
        prefetchOlder(taskId, HISTORY_PREFETCH_PAGES);
      })
      .catch(() => {
        useStore.getState().patchHistoryMeta(taskId, { loadingBefore: false });
      })
      .finally(() => {
        loadOlderBusyRef.current.delete(taskId);
      });
  }, [taskId, apiRef, prefetchOlder]);

  return {
    loadOlder,
    hasMoreBefore,
    loadingBefore,
    loaded,
    reload,
    /** 滚动速度超阈值 / 停止滚动时主动补一页（由 VirtualList 的两个滚动回调触发） */
    prefetchMore: () => prefetchOlder(taskId, HISTORY_PREFETCH_PAGES),
  };
}
