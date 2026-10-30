// webui/src/hooks/useIm.ts
// IM 连接状态轮询 + 渠道描述符缓存（设置页「IM 连接」分区使用）。
// 轮询节奏：任一机器人 connecting → 1s；其余 3s；组件卸载自动清理。

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/http';
import type { ImChannelDescriptor, ImStatus } from '../types/api';

export function useIm() {
  const [status, setStatus] = useState<ImStatus | null>(null);
  const [channels, setChannels] = useState<ImChannelDescriptor[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  const poll = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getImStatus();
      if (!aliveRef.current) return;
      setStatus(next);
      setLoadError(null);
      const busy = next.bots.some(bot => bot.state === 'connecting');
      timerRef.current = setTimeout(poll, busy ? 1000 : 3000);
    } catch (err) {
      if (!aliveRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
      timerRef.current = setTimeout(poll, 3000);
    }
  }, []);

  const loadChannels = useCallback(async (): Promise<void> => {
    try {
      const response = await api.getImChannels();
      if (aliveRef.current) setChannels(response.channels);
    } catch {
      // 渠道描述符拉取失败不阻塞状态展示
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void loadChannels();
    void poll();
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [loadChannels, poll]);

  /** 操作后立即刷新（不打断轮询节奏） */
  const refresh = useCallback(async (): Promise<void> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    await poll();
  }, [poll]);

  return { status, channels, loadError, refresh };
}
