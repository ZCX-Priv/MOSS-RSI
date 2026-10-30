// src/modules/im/identity.ts
// 机器人身份派生与展示脱敏。botId 由平台身份哈希派生，保证重装/重复添加时身份稳定。

import { createHash, randomInt } from 'node:crypto';
import type { ImChannelId } from './types';

/** 渠道前缀（botId 可读性用） */
const CHANNEL_PREFIX: Record<ImChannelId, string> = {
  'wecom-aibot': 'wc',
  'qq-official': 'qq',
  'qq-onebot': 'ob',
  'wechat-ilink': 'wx',
};

/** 派生稳定 botId：`<前缀>_<sha256(platformId) 前 16 位>` */
export function deriveBotId(channel: ImChannelId, platformId: string): string {
  const digest = createHash('sha256').update(`${channel}:${platformId}`).digest('hex').slice(0, 16);
  return `${CHANNEL_PREFIX[channel]}_${digest}`;
}

/** 平台身份脱敏：保留头 4 尾 4，过短则整体打码 */
export function maskPlatformId(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}•••`;
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

/** 所有 IM 机器人在 MOSS 内的默认名称 */
export const DEFAULT_BOT_NAME = 'MOSS';

/** 旧版系统自动生成的默认名（微信机器人 xxxx 等）迁移为统一名称 */
export function migrateLegacyBotName(name: string): string {
  const text = name.trim();
  if (!text) return DEFAULT_BOT_NAME;
  if (/^(微信|企业微信|QQ)机器人\s*[A-Za-z0-9_-]{1,8}$/.test(text)) return DEFAULT_BOT_NAME;
  return text;
}

/** 生成 6 位数字配对码 */
export function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 校验配对码格式 */
export function isValidPairingCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}
