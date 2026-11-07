// webui/src/hooks/usePlatform.ts
// 后端运行平台（/api/version）：用于禁用移动端（Android）不可用的能力。
// 模块级缓存一次请求，多个组件共享同一结果，避免重复拉取。

import { useEffect, useState } from 'react';
import { api } from '../api/http';

export interface BackendPlatform {
  /** win32 / darwin / linux / android / other */
  platform: string;
  isAndroid: boolean;
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
}

export const UNKNOWN_PLATFORM: BackendPlatform = {
  platform: 'unknown',
  isAndroid: false,
  isWindows: false,
  isMac: false,
  isLinux: false,
};

let cached: BackendPlatform | null = null;
let pending: Promise<BackendPlatform> | null = null;

function normalize(info: { platform?: string; isAndroid?: boolean }): BackendPlatform {
  const platform = info.platform ?? 'unknown';
  return {
    platform,
    isAndroid: info.isAndroid === true || platform === 'android',
    isWindows: platform === 'win32',
    isMac: platform === 'darwin',
    isLinux: platform === 'linux',
  };
}

function load(): Promise<BackendPlatform> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = api
    .getVersion()
    .then((info) => {
      cached = normalize(info);
      return cached;
    })
    .catch(() => UNKNOWN_PLATFORM)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** 后端运行平台：ready=false 表示尚未拿到（按可用处理，避免误灰） */
export function usePlatform(): { platform: BackendPlatform; ready: boolean } {
  const [platform, setPlatform] = useState<BackendPlatform>(cached ?? UNKNOWN_PLATFORM);
  const [ready, setReady] = useState(Boolean(cached));

  useEffect(() => {
    if (cached) return;
    let alive = true;
    void load().then((value) => {
      if (!alive) return;
      setPlatform(value);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { platform, ready };
}
