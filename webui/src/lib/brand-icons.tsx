// webui/src/lib/brand-icons.tsx
// 品牌图标中心：Simple Icons（@icons-pack/react-simple-icons，按图标深导入 → tree-shaking 生效）。
//
// 用法：
//   <BrandIcon name="github" />
//   <BrandIcon name="wechat" size={20} colored />   // colored = 品牌色，默认跟随文字色
//
// 新增品牌：在 BrandIconName / BRAND_META 里补一项，并加入 SIMPLE_BRANDS。
//
// 第三方说明：Simple Icons 图标数据为 CC0-1.0（https://simpleicons.org）。

import type { ReactElement } from 'react';
import SiGithub from '@icons-pack/react-simple-icons/icons/SiGithub';
import SiWechat from '@icons-pack/react-simple-icons/icons/SiWechat';
import SiQq from '@icons-pack/react-simple-icons/icons/SiQq';
import SiTelegram from '@icons-pack/react-simple-icons/icons/SiTelegram';
import SiX from '@icons-pack/react-simple-icons/icons/SiX';
import SiAlipay from '@icons-pack/react-simple-icons/icons/SiAlipay';
import SiBilibili from '@icons-pack/react-simple-icons/icons/SiBilibili';
import SiSinaweibo from '@icons-pack/react-simple-icons/icons/SiSinaweibo';
import SiTiktok from '@icons-pack/react-simple-icons/icons/SiTiktok';
import SiDiscord from '@icons-pack/react-simple-icons/icons/SiDiscord';
import SiNotion from '@icons-pack/react-simple-icons/icons/SiNotion';
import SiGitlab from '@icons-pack/react-simple-icons/icons/SiGitlab';
import SiDocker from '@icons-pack/react-simple-icons/icons/SiDocker';
import SiFigma from '@icons-pack/react-simple-icons/icons/SiFigma';
import SiObsidian from '@icons-pack/react-simple-icons/icons/SiObsidian';
import SiNpm from '@icons-pack/react-simple-icons/icons/SiNpm';
import SiReact from '@icons-pack/react-simple-icons/icons/SiReact';
import SiVite from '@icons-pack/react-simple-icons/icons/SiVite';

/** Simple Icons 组件类型（与包内 IconType 结构一致，避免深层导入类型文件） */
type SimpleIcon = typeof SiGithub;

export type BrandIconName =
  | 'github'
  | 'wechat'
  | 'qq'
  | 'telegram'
  | 'x'
  | 'alipay'
  | 'bilibili'
  | 'weibo'
  | 'tiktok'
  | 'discord'
  | 'notion'
  | 'gitlab'
  | 'docker'
  | 'figma'
  | 'obsidian'
  | 'npm'
  | 'react'
  | 'vite';

export interface BrandMeta {
  /** 无障碍标题 / 悬浮提示用的品牌名 */
  label: string;
  /** 品牌主色（colored=true 时使用） */
  color: string;
}

export const BRAND_META: Record<BrandIconName, BrandMeta> = {
  github: { label: 'GitHub', color: '#181717' },
  wechat: { label: '微信', color: '#07C160' },
  qq: { label: 'QQ', color: '#1EBAFC' },
  telegram: { label: 'Telegram', color: '#26A5E4' },
  x: { label: 'X', color: '#000000' },
  alipay: { label: '支付宝', color: '#1677FF' },
  bilibili: { label: '哔哩哔哩', color: '#00A1D6' },
  weibo: { label: '微博', color: '#E6162D' },
  tiktok: { label: 'TikTok', color: '#000000' },
  discord: { label: 'Discord', color: '#5865F2' },
  notion: { label: 'Notion', color: '#000000' },
  gitlab: { label: 'GitLab', color: '#FC6D26' },
  docker: { label: 'Docker', color: '#2496ED' },
  figma: { label: 'Figma', color: '#F24E1E' },
  obsidian: { label: 'Obsidian', color: '#7C3AED' },
  npm: { label: 'npm', color: '#CB3837' },
  react: { label: 'React', color: '#61DAFB' },
  vite: { label: 'Vite', color: '#9135FF' },
};

export interface BrandIconProps {
  name: BrandIconName;
  /** 像素尺寸（默认 16） */
  size?: number;
  /** true = 品牌主色；false（默认）= currentColor，跟随主题/父级文字色 */
  colored?: boolean;
  className?: string;
  /** 覆盖默认品牌名（无障碍标题） */
  title?: string;
}

const SIMPLE_BRANDS: Record<BrandIconName, SimpleIcon> = {
  github: SiGithub,
  wechat: SiWechat,
  qq: SiQq,
  telegram: SiTelegram,
  x: SiX,
  alipay: SiAlipay,
  bilibili: SiBilibili,
  weibo: SiSinaweibo,
  tiktok: SiTiktok,
  discord: SiDiscord,
  notion: SiNotion,
  gitlab: SiGitlab,
  docker: SiDocker,
  figma: SiFigma,
  obsidian: SiObsidian,
  npm: SiNpm,
  react: SiReact,
  vite: SiVite,
};

export function BrandIcon({
  name,
  size = 16,
  colored = false,
  className,
  title,
}: BrandIconProps): ReactElement {
  const meta = BRAND_META[name];
  const color = colored ? meta.color : 'currentColor';
  const label = title ?? meta.label;
  const Simple = SIMPLE_BRANDS[name];
  return <Simple size={size} color={color} className={className} title={label} />;
}
