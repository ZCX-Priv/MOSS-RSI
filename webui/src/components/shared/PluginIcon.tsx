// webui/src/components/shared/PluginIcon.tsx
// 插件图标：兜底图标常驻底层，远端图片加载完成后淡入覆盖。
// 不用 loading="lazy"：市场列表是滚动追加的，懒加载会让视口外的图标长期不发起请求
//（再叠加「挂载超时即判失败」就会被永久降级成兜底 —— 用户下滑后看到「图标全没了」）。
// 也不设超时：加载慢时用户看到的是兜底图标而不是空色块，图片晚到仍会正常淡入。
// 统一 10×10 圆角容器，供技能市场 / MCP 市场 / 管理面板共用。

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function PluginIcon({
  src,
  fallback,
  className,
}: {
  src?: string | null;
  fallback: ReactNode;
  className?: string;
}) {
  // 记录「哪个 src 处于什么状态」：src 变化自然回到 loading，无需 effect 重置
  const [imgState, setImgState] = useState<{ src: string; status: 'loaded' | 'error' } | null>(null);
  const status = src && imgState?.src === src ? imgState.status : 'loading';

  return (
    <div
      className={cn(
        'relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground',
        className,
      )}
    >
      {/* 兜底图标常驻底层：加载中 / 加载失败 / 无地址都不会出现空白块；
          图片加载完成后淡出（避免透明 PNG 透出底层字符） */}
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center transition-opacity duration-150',
          status === 'loaded' ? 'opacity-0' : 'opacity-100',
        )}
      >
        {fallback}
      </span>
      {src && status !== 'error' && (
        <img
          src={src}
          alt=""
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          className={cn(
            'absolute inset-0 size-full object-cover transition-opacity duration-150',
            status === 'loaded' ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => setImgState({ src, status: 'loaded' })}
          onError={() => setImgState({ src, status: 'error' })}
        />
      )}
    </div>
  );
}
