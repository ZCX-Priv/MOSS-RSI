// webui/src/components/subagent/HumationAvatar.tsx
// Agent 头像：基于 Humation 确定性手绘头像引擎。
// 同一 seed 永远渲染同一头像（本地 SVG，无 AI、无网络请求）。

import { memo } from 'react';
import { Avatar } from '@humation/react';
import { humation1 } from '@humation/assets-humation-1';
import { cn } from '@/lib/utils';

interface HumationAvatarProps {
  /** 种子（agent id / 模板 id 等；相同种子 → 相同头像） */
  seed: string;
  /** 渲染尺寸（px，默认 32） */
  size?: number;
  className?: string;
}

export const HumationAvatar = memo(function HumationAvatar({
  seed,
  size = 32,
  className,
}: HumationAvatarProps) {
  const safeSeed = seed?.trim() !== '' ? seed : 'moss';
  return (
    <span
      className={cn('inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Avatar assets={humation1} seed={safeSeed} size={size} />
    </span>
  );
});
