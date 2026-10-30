// webui/src/components/pages/settings/im/channel-meta.ts
// 渠道图标映射（字段/能力来自后端 /api/im/channels，前端只负责视觉）。

import type { BrandIconName } from '@/lib/brand-icons';
import type { ImChannelId } from '@/types/api';

/** 渠道 → 品牌图标（企业微信/QQ/微信，见 lib/brand-icons） */
export const CHANNEL_BRAND: Record<ImChannelId, BrandIconName> = {
  'wecom-aibot': 'wecom',
  'qq-official': 'qq',
  'qq-onebot': 'qq',
  'wechat-ilink': 'wechat',
};

/** 渠道状态点的颜色（沿用设置页语义色） */
export const STATE_DOT_CLASS: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-blue-500 animate-pulse',
  error: 'bg-red-500',
  offline: 'bg-muted-foreground/40',
};

export const STATE_BADGE_CLASS: Record<string, string> = {
  connected: 'bg-emerald-600/15 text-emerald-600',
  connecting: 'bg-blue-600/15 text-blue-600',
  error: 'bg-red-500/15 text-red-600',
  offline: 'bg-muted text-muted-foreground',
};
