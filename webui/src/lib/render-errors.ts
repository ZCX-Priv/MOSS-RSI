// webui/src/lib/render-errors.ts
// 渲染错误去重注册表：相同错误（相同签名）全局只展示一张合并卡。
//
// 同一个懒加载模块失败时，每条消息/每个卡片都会各自抛一次相同 TypeError；
// 这里按 `error.name: error.message` 归组，只有 orderKey 最小的实例展示完整错误卡，
// 其余实例展示轻量占位。重试按钮通过注册表一次性重置该组所有实例。

export interface RenderErrorRegistration {
  /** 实例 id（React useId） */
  id: string;
  /** `${error.name}: ${error.message}` */
  signature: string;
  /** 决定合并卡位置的稳定排序键（消息下标 / 卡片下标） */
  orderKey: string;
  /** 重试该实例（重置错误边界 / 清除模块缓存并重新加载） */
  retry?: () => void;
}

type RenderErrorEntry = Required<Omit<RenderErrorRegistration, 'retry'>> & {
  retry: (() => void) | null;
  /** 注册顺序，orderKey 相同时用于稳定选出最早实例 */
  seq: number;
};

export interface RenderErrorGroup {
  count: number;
  primaryId: string | null;
}

const entries = new Map<string, RenderErrorEntry>();
const listeners = new Set<() => void>();
let version = 0;
let seq = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 注册一个错误实例，返回注销函数 */
export function registerRenderError(registration: RenderErrorRegistration): () => void {
  entries.set(registration.id, {
    id: registration.id,
    signature: registration.signature,
    orderKey: registration.orderKey,
    retry: registration.retry ?? null,
    seq: seq++,
  });
  notify();
  return () => {
    if (!entries.delete(registration.id)) return;
    notify();
  };
}

export function subscribeRenderErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** useSyncExternalStore 的快照：版本号变化即触发重算 */
export function getRenderErrorVersion(): number {
  return version;
}

/** 当前挂载的相同签名实例数与合并卡归属实例 */
export function getRenderErrorGroup(signature: string): RenderErrorGroup {
  let count = 0;
  let primary: RenderErrorEntry | null = null;
  for (const entry of entries.values()) {
    if (entry.signature !== signature) continue;
    count += 1;
    if (
      !primary ||
      entry.orderKey < primary.orderKey ||
      (entry.orderKey === primary.orderKey && entry.seq < primary.seq)
    ) {
      primary = entry;
    }
  }
  return { count, primaryId: primary?.id ?? null };
}

/** 重试该签名下的全部实例（调用前先快照，避免回调注销条目影响遍历） */
export function retryRenderErrorGroup(signature: string): void {
  const retries: Array<() => void> = [];
  for (const entry of entries.values()) {
    if (entry.signature === signature && entry.retry) retries.push(entry.retry);
  }
  for (const retry of retries) retry();
}
