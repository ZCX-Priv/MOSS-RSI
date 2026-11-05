// webui/src/lib/idle.ts
// 首屏非关键工作调度：优先在浏览器空闲时执行，避免与首屏渲染/消息加载抢主线程。
// 无 requestIdleCallback（Safari 旧版等）时退化为短延时。

interface IdleCapableWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
}

/**
 * 在浏览器空闲时执行一次任务。
 * @param task 任务函数（不得同步抛出未捕获异常）
 * @param timeoutMs 空闲回调的兜底超时（ms）：超时后浏览器强制执行，保证任务最终会跑
 */
export function runWhenIdle(task: () => void, timeoutMs = 1000): void {
  const w = window as unknown as IdleCapableWindow;
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(() => task(), { timeout: timeoutMs });
    return;
  }
  window.setTimeout(task, Math.min(timeoutMs, 300));
}
