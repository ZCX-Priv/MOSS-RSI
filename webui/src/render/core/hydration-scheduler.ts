// webui/src/render/core/hydration-scheduler.ts
// 渐进渲染调度器：把「一批重内容渲染」（markdown 解析 + React 树构建）按帧预算分帧执行，
// 让首帧只承担廉价占位（毫秒级可见），重内容在后续帧内逐个升级——消除
// 「打开会话 / 上滑加载 / 尾部补齐时一批气泡同一帧同步解析导致的主线程冻结」。
//
// 顺序：LIFO（后入队先执行）。初始渲染时 React 按子节点顺序触发挂载 effect，
// 列表底部的块最后入队 → 最先水合，与「打开会话锚定最新消息」的视口方向一致。

interface QueueEntry {
  task: () => void;
  cancelled: boolean;
}

/** 每帧水合预算（毫秒）：留出余量保证 rAF 帧率不跌破 60fps */
const FRAME_BUDGET_MS = 8;

const queue: QueueEntry[] = [];
let rafId: number | null = null;
/** 滚动期间暂停水合：避免 Markdown 解析与滚动抢主线程（停止滚动后恢复） */
let paused = false;

/** 暂停/恢复水合（宿主在滚动开始/停止时调用） */
export function setHydrationPaused(value: boolean): void {
  paused = value;
  if (!value) scheduleDrain();
}

const drainedCallbacks = new Set<() => void>();

/** 订阅「一批队列排空」事件（TaskPage 据此把视口回锚到底部）；返回退订函数 */
export function subscribeDrained(cb: () => void): () => void {
  drainedCallbacks.add(cb);
  return () => {
    drainedCallbacks.delete(cb);
  };
}

function scheduleDrain(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    drain();
  });
}

function drain(): void {
  // 暂停期间保留队列原样；恢复时由 setHydrationPaused(false) 重新调度
  if (paused) return;
  const deadline = performance.now() + FRAME_BUDGET_MS;
  while (queue.length > 0 && performance.now() < deadline) {
    const entry = queue.pop()!;
    if (entry.cancelled) continue;
    entry.task();
  }
  if (queue.length > 0) {
    scheduleDrain();
    return;
  }
  // 本批排空：通知订阅者（单个回调异常不影响其他）
  for (const cb of drainedCallbacks) {
    try {
      cb();
    } catch {
      // 静默
    }
  }
}

/**
 * 排队一个水合任务。返回取消函数（组件在轮到自己前卸载时调用，出队时跳过）。
 * 后入队先执行（LIFO）。
 */
export function scheduleHydration(task: () => void): () => void {
  const entry: QueueEntry = { task, cancelled: false };
  queue.push(entry);
  scheduleDrain();
  return () => {
    entry.cancelled = true;
  };
}
