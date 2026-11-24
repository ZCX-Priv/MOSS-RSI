// webui/src/components/shared/PluginIcon.tsx
// 插件图标：优先显示市场图标，加载失败或超时回退默认图标。
// 统一 10×10 圆角容器，供技能市场 / MCP 市场 / 管理面板共用。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** 远端图标超时（毫秒）：超时视为失败，避免卡片长时间空白 */
const ICON_TIMEOUT_MS = 4000;

export function PluginIcon({
  src,
  fallback,
  className,
  timeoutMs = ICON_TIMEOUT_MS,
}: {
  src?: string | null;
  fallback: ReactNode;
  className?: string;
  timeoutMs?: number;
}) {
  const [broken, setBroken] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    setBroken(false);
    loadedRef.current = false;
    if (!src) return;
    const timer = setTimeout(() => {
      if (!loadedRef.current) setBroken(true);
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [src, timeoutMs]);

  return (
    <div
      className={cn(
        'flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground',
        className,
      )}
    >
      {src && !broken ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-10 object-cover"
          onLoad={() => {
            loadedRef.current = true;
          }}
          onError={() => setBroken(true)}
        />
      ) : (
        fallback
      )}
    </div>
  );
}
