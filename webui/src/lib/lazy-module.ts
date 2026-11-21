// webui/src/lib/lazy-module.ts
// 可重试、可清除缓存的动态 import。
//
// React.lazy 会把失败的 Promise 永久缓存：服务重启/HMR 导致一次模块拉取失败后，
// 同一 lazy 组件实例不会再发请求，只能整页刷新。这里用模块级 Promise 缓存做统一入口：
// - 并发调用共用同一个 Promise，避免同一模块重复请求；
// - 失败后按短退避自动重试，覆盖服务重启瞬间；
// - 最终失败时删除缓存，手动重试可以真正重新拉取。

import { useCallback, useEffect, useRef, useState } from 'react';

export interface LazyModuleLoadOptions {
  /** 首次失败后的额外重试次数（默认 2，即最多 3 次尝试） */
  retries?: number;
  /** 首次重试间隔（默认 300ms；后续按 3 倍递增） */
  retryDelayMs?: number;
}

const moduleCache = new Map<string, Promise<unknown>>();

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 按 key 加载模块：并发共享、失败退避重试、最终失败清缓存 */
export function loadLazyModule<T>(
  key: string,
  importer: () => Promise<T>,
  options: LazyModuleLoadOptions = {},
): Promise<T> {
  const cached = moduleCache.get(key) as Promise<T> | undefined;
  if (cached) return cached;

  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 300;

  const loading = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await importer();
      } catch (error) {
        lastError = error;
        if (attempt < retries) await delay(retryDelayMs * 3 ** attempt);
      }
    }
    throw toError(lastError);
  })().catch((error: unknown) => {
    // 失败结果不能被缓存：否则手动重试会命中同一个已拒绝的 Promise
    moduleCache.delete(key);
    throw toError(error);
  });

  moduleCache.set(key, loading);
  return loading;
}

/** 手动重试前清除缓存，让下一次 loadLazyModule 真正重新发起请求 */
export function clearLazyModule(key: string): void {
  moduleCache.delete(key);
}

export type RetryableImportState<T> =
  | { status: 'loading' }
  | { status: 'ready'; module: T }
  | { status: 'error'; error: Error };

/**
 * 组件内使用：加载状态 + 手动重试。
 * `importer` 通过 ref 读取，允许调用处写内联箭头函数而不会导致 effect 每次渲染重跑。
 */
export function useRetryableImport<T>(
  key: string,
  importer: () => Promise<T>,
): [RetryableImportState<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RetryableImportState<T>>({ status: 'loading' });
  const importerRef = useRef(importer);
  importerRef.current = importer;

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void loadLazyModule(key, () => importerRef.current())
      .then((module) => {
        if (alive) setState({ status: 'ready', module });
      })
      .catch((error: unknown) => {
        if (alive) setState({ status: 'error', error: toError(error) });
      });
    return () => {
      alive = false;
    };
  }, [key, attempt]);

  const retry = useCallback(() => {
    clearLazyModule(key);
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, [key]);

  return [state, retry];
}
