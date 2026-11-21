// webui/src/components/shared/RunningBar.tsx
// 安装中的半透明跑动进度条：绝对定位铺满父容器。
// 使用方需给父元素加 relative overflow-hidden（通常是按钮）。

import { cn } from '@/lib/utils';

export function RunningBar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]',
        className,
      )}
    >
      <span className="absolute inset-y-0 w-1/2 animate-[moss-running-bar_1.2s_ease-in-out_infinite] bg-primary/25" />
    </span>
  );
}
