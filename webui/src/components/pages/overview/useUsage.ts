// webui/src/components/pages/overview/useUsage.ts
// 设置-概览「用量」数据 hook：按日期范围请求跨会话聚合（/api/usage/overview）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/http';
import type { UsageOverview, UsageRange } from '@/types/api';

export function useUsageOverview(range: UsageRange) {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (showLoading: boolean) => {
      const id = seq.current + 1;
      seq.current = id;
      if (showLoading) setLoading(true);
      try {
        const next = await api.getUsageOverview(range);
        if (seq.current !== id) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (seq.current !== id) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq.current === id) setLoading(false);
      }
    },
    [range],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  return { data, loading, error, refresh: () => void load(false) } as const;
}
