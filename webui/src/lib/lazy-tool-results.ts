// webui/src/lib/lazy-tool-results.ts
// 工具结果按需加载：分页历史只带轻量投影（metadata.__mossLazy=true），
// 卡片展开时才向 /api/session/:id/tool-result 拉取完整正文 / IntelligentUI spec。
//
// 缓存按 `${sessionId}:${toolCallId}` 去重：同一卡片反复展开、多个组件同时请求只发一次。

import { useEffect, useState } from 'react';
import { api } from '../api/http';
import type { ToolResult } from '../types/api';

const cache = new Map<string, Promise<ToolResult | null>>();

/** 是否是被轻量化过的工具结果（需要展开后补拉） */
export function isLazyToolResult(result: ToolResult | undefined): boolean {
  return result?.metadata?.__mossLazy === true;
}

/** 拉取完整工具结果（失败返回 null，调用方保留轻量内容） */
export function loadToolResult(sessionId: string, toolCallId: string): Promise<ToolResult | null> {
  const key = `${sessionId}:${toolCallId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = api
    .getToolResult(sessionId, toolCallId)
    .catch(() => null)
    .then((result) => {
      // 失败不缓存：下次展开仍可重试
      if (!result) cache.delete(key);
      return result;
    });
  cache.set(key, promise);
  return promise;
}

/**
 * 展开时按需补全工具结果。
 * @param enabled 卡片是否展开（折叠态不发请求）
 * @returns 完整结果（未加载/失败时回退轻量 result）
 */
export function useLazyToolResult(
  sessionId: string | null | undefined,
  toolCallId: string,
  result: ToolResult | undefined,
  enabled: boolean,
): ToolResult | undefined {
  const [full, setFull] = useState<ToolResult | null>(null);
  const lazy = isLazyToolResult(result);

  useEffect(() => {
    setFull(null);
  }, [toolCallId]);

  useEffect(() => {
    if (!enabled || !lazy || !sessionId || !toolCallId || full) return;
    let cancelled = false;
    void loadToolResult(sessionId, toolCallId).then((loaded) => {
      if (!cancelled && loaded) setFull(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, lazy, sessionId, toolCallId, full]);

  return full ?? result;
}
