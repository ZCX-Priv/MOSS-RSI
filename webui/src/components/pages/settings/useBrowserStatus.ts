// webui/src/components/pages/settings/useBrowserStatus.ts
// 浏览器设置页数据层：状态轮询 + 动作包装 + browser 工具配置读写。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api/http';
import { useTools } from '@/hooks/useTools';
import type { BrowserStatus } from '@/types/api';

const POLL_MS = 5000;

export function useBrowserStatus() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getBrowserStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, successKey: string) => {
      setBusy(key);
      try {
        await action();
        toast.success(t(successKey));
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [refresh, t],
  );

  return { status, loading, busy, error, refresh, run };
}

/** browser 工具配置：configValues 回填 + saveToolConfig 即时保存 */
export function useBrowserToolConfig() {
  const { tools, saveToolConfig } = useTools();
  const browserTool = tools.find((tool) => tool.name === 'browser');
  const values = browserTool?.configValues ?? {};

  const save = useCallback(
    (patch: Record<string, unknown>) => saveToolConfig('browser', patch),
    [saveToolConfig],
  );

  return { values, save, loaded: Boolean(browserTool) };
}

export function readConfigString(
  values: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = values[key];
  return typeof value === 'string' ? value : fallback;
}

export function readConfigNumber(
  values: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readConfigBoolean(
  values: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = values[key];
  return typeof value === 'boolean' ? value : fallback;
}
