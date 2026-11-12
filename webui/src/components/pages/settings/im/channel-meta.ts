// webui/src/components/pages/settings/im/channel-meta.ts
// 渠道图标映射（字段/能力来自后端 /api/im/channels，前端只负责视觉）。

import type { BrandIconName } from '@/lib/brand-icons';
import type { ImChannelId } from '@/types/api';

/** 渠道 → 品牌图标（QQ/微信，见 lib/brand-icons） */
export const CHANNEL_BRAND: Record<ImChannelId, BrandIconName> = {
  'qq-official': 'qq',
  'wechat-ilink': 'wechat',
};

/** 渠道状态点的颜色（沿用设置页语义色） */
export const STATE_DOT_CLASS: Record<string, string> = {
  connected: 'bg-success',
  connecting: 'bg-primary animate-pulse',
  error: 'bg-danger',
  offline: 'bg-muted-foreground/40',
};

export const STATE_BADGE_CLASS: Record<string, string> = {
  connected: 'bg-success/15 text-success',
  connecting: 'bg-primary/15 text-primary-text',
  error: 'bg-danger/15 text-danger',
  offline: 'bg-muted text-muted-foreground',
};
