// webui/src/lib/tab-wake-lock.ts
// 阻止标签页休眠：Screen Wake Lock 的唯一驱动。
//
// - 开关值来自 store（IndexedDB 持久化），初始化时应用一次并订阅后续变化；
// - 页面重新可见时自动重申请（浏览器在隐藏标签页时会强制释放 wake lock）；
// - 不支持 Wake Lock 的环境静默降级，由设置页显示「不支持」。

import { useStore } from '../store';

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

let sentinel: WakeLockSentinelLike | null = null;
let requesting = false;
let initialized = false;

/** 取浏览器 Wake Lock API；不支持时返回 null（不假设 navigator.wakeLock 一定存在） */
function wakeLockApi(): WakeLockApi | null {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null;
  return (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock ?? null;
}

/** 当前环境是否支持 Screen Wake Lock */
export function isWakeLockSupported(): boolean {
  return wakeLockApi() !== null;
}

async function acquire(): Promise<void> {
  const api = wakeLockApi();
  if (sentinel || requesting || !api) return;
  requesting = true;
  try {
    const lock = await api.request('screen');
    sentinel = lock;
    lock.addEventListener('release', () => {
      if (sentinel === lock) sentinel = null;
    });
  } catch {
    // 页面不可见 / 用户策略拒绝：下次可见时会重试，不打扰用户
  } finally {
    requesting = false;
  }
}

async function release(): Promise<void> {
  const lock = sentinel;
  sentinel = null;
  if (!lock || lock.released) return;
  try {
    await lock.release();
  } catch {
    // 已释放
  }
}

async function apply(enabled: boolean): Promise<void> {
  if (enabled && document.visibilityState === 'visible') await acquire();
  else await release();
}

/** 应用启动时调用一次：读取持久化开关并接管后续变化 */
export function initTabWakeLock(): void {
  if (initialized) return;
  initialized = true;
  void apply(useStore.getState().preventTabSleep);
  useStore.subscribe((state, prev) => {
    if (state.preventTabSleep !== prev.preventTabSleep) {
      void apply(state.preventTabSleep);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (useStore.getState().preventTabSleep) void apply(true);
  });
}
