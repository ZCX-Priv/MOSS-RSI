// webui/src/lib/ui-state.ts
// 跨挂载持久化的轻量 UI 状态（展开/折叠等）。
//
// 为什么需要：消息列表是虚拟列表，滚出窗口的条目会被卸载；组件内部 useState
// 会随卸载丢失，表现为「展开的 subagent/工具卡滚回来又收起了」。
// 这里用模块级 Map + 按 key 订阅，把状态从组件生命周期中解耦。

import { useCallback, useState, useSyncExternalStore } from 'react';

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
/** 状态上限：超长会话长期运行时不无限增长（超过后淘汰最早写入的 key） */
const MAX_ENTRIES = 5000;

function notify(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) {
    try {
      fn();
    } catch {
      // 单个监听异常不影响其他订阅者
    }
  }
}

/** 读取持久化状态（未设置返回 initial） */
export function getUiState<T>(key: string, initial: T): T {
  if (key && values.has(key)) return values.get(key) as T;
  return initial;
}

/** 写入持久化状态（相同值不触发订阅） */
export function setUiState<T>(key: string, value: T): void {
  if (!key) return;
  if (values.has(key) && Object.is(values.get(key), value)) return;
  values.set(key, value);
  if (values.size > MAX_ENTRIES) {
    const oldest = values.keys().next().value;
    if (typeof oldest === 'string' && oldest !== key) values.delete(oldest);
  }
  notify(key);
}

function subscribe(key: string, fn: () => void): () => void {
  if (!key) return () => undefined;
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set && set.size === 0) listeners.delete(key);
  };
}

/**
 * 持久化 state hook。
 * key 为空时退化为普通 useState（不影响未提供稳定 key 的调用方）。
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [local, setLocal] = useState<T>(initial);
  const snapshot = useSyncExternalStore(
    useCallback((fn) => subscribe(key, fn), [key]),
    useCallback(() => (key ? (values.has(key) ? (values.get(key) as T) : initial) : local), [
      key,
      initial,
      local,
    ]),
    useCallback(() => initial, [initial]),
  );
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      const next =
        typeof value === 'function'
          ? (value as (prev: T) => T)(key ? getUiState(key, initial) : local)
          : value;
      if (key) setUiState(key, next);
      else setLocal(next);
    },
    [key, initial, local],
  );
  return [snapshot, setValue];
}
