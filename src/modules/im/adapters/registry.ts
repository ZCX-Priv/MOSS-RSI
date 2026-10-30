// src/modules/im/adapters/registry.ts
// 渠道描述符与适配器工厂注册表。新增渠道只需在此登记一行。

import type { ImAdapterContext, ImChannelAdapter, ImChannelDescriptor, ImChannelId } from '../types';
import * as wecom from './wecom-aibot';
import * as qqOfficial from './qq-official';
import * as qqOnebot from './onebot';
import * as wechatIlink from './wechat-ilink';

const MODULES = {
  'wechat-ilink': wechatIlink,
  'wecom-aibot': wecom,
  'qq-official': qqOfficial,
  'qq-onebot': qqOnebot,
} as const;

/** 设置页展示顺序（微信优先，国内主流在前） */
const CHANNEL_ORDER: ImChannelId[] = [
  'wechat-ilink',
  'wecom-aibot',
  'qq-official',
  'qq-onebot',
];

export function listDescriptors(): ImChannelDescriptor[] {
  return CHANNEL_ORDER.map(id => MODULES[id].descriptor);
}

export function getDescriptor(id: string): ImChannelDescriptor | null {
  if (!CHANNEL_ORDER.includes(id as ImChannelId)) return null;
  return MODULES[id as ImChannelId].descriptor;
}

export function createAdapter(id: ImChannelId, ctx: ImAdapterContext): ImChannelAdapter {
  return MODULES[id].createAdapter(ctx);
}
