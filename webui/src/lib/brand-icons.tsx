// webui/src/lib/brand-icons.tsx
// 品牌图标中心：Simple Icons（@icons-pack/react-simple-icons，按图标深导入 → tree-shaking 生效）
// + 本地补齐的中国 IM 品牌（企业微信，Simple Icons 未收录）。
//
// 用法：
//   <BrandIcon name="github" />
//   <BrandIcon name="wecom" size={20} colored />   // colored = 品牌色，默认跟随文字色
//
// 新增品牌：在 BrandIconName / BRAND_META 里补一项，Simple Icons 收录的直接加进 SIMPLE_BRANDS；
// 未收录的把官方造型矢量写进 LOCAL_BRANDS（保持 fill=currentColor，颜色由 color 传入）。
//
// 第三方说明：
// - Simple Icons 图标数据为 CC0-1.0（https://simpleicons.org）。
// - 企业微信的路径数据来自 @ant-design/icons-svg（MIT）的 WechatWorkOutlined。

import type { ReactElement, SVGProps } from 'react';
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
  | 'wecom'
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

/** 本地补齐品牌（Simple Icons 未收录） */
type LocalBrandIconName = 'wecom';

export interface BrandMeta {
  /** 无障碍标题 / 悬浮提示用的品牌名 */
  label: string;
  /** 品牌主色（colored=true 时使用） */
  color: string;
}

export const BRAND_META: Record<BrandIconName, BrandMeta> = {
  github: { label: 'GitHub', color: '#181717' },
  wecom: { label: '企业微信', color: '#0082EF' },
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

const LOCAL_BRANDS: Record<LocalBrandIconName, (props: LocalIconProps) => ReactElement> = {
  wecom: WecomIcon,
};

const SIMPLE_BRANDS: Record<Exclude<BrandIconName, LocalBrandIconName>, SimpleIcon> = {
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
  if (name === 'wecom') {
    const Local = LOCAL_BRANDS[name];
    return <Local size={size} color={color} className={className} title={label} />;
  }
  const Simple = SIMPLE_BRANDS[name];
  return <Simple size={size} color={color} className={className} title={label} />;
}

interface LocalIconProps {
  size: number;
  color: string;
  className?: string;
  title: string;
}

function iconSvgProps({ size, color, className, title }: LocalIconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    className,
    fill: color,
    viewBox: '64 64 896 896',
    role: 'img',
    'aria-label': title,
    xmlns: 'http://www.w3.org/2000/svg',
  };
}

/** 企业微信：@ant-design/icons-svg 的 WechatWorkOutlined（MIT） */
function WecomIcon(props: LocalIconProps): ReactElement {
  return (
    <svg {...iconSvgProps(props)} fillRule="evenodd">
      <path d="M909.78 729.59a135.87 135.87 0 00-47.04 19.04 114.24 114.24 0 01-51.4 31.08 76.29 76.29 0 0124.45-45.42 169.3 169.3 0 0023.4-55.02 50.41 50.41 0 1150.6 50.32zm-92.21-120.76a168.83 168.83 0 00-54.81-23.68 50.41 50.41 0 01-50.4-50.42 50.41 50.41 0 11100.8 0 137.5 137.5 0 0018.82 47.2 114.8 114.8 0 0130.76 51.66 76.08 76.08 0 01-45.02-24.76h-.19zm-83.04-177.71c-15.19-127.33-146.98-227.1-306.44-227.1-169.87 0-308.09 113.1-308.09 252.2A235.81 235.81 0 00230.06 647.6a311.28 311.28 0 0033.6 21.59L250 723.76c4.93 2.31 9.7 4.78 14.75 6.9l69-34.5c10.07 2.61 20.68 4.3 31.2 6.08 6.73 1.2 13.45 2.43 20.35 3.25a354.83 354.83 0 00128.81-7.4 248.88 248.88 0 0010.15 55.06 425.64 425.64 0 01-96.17 11.24 417.98 417.98 0 01-86.4-9.52L216.52 817.4a27.62 27.62 0 01-29.98-3.14 28.02 28.02 0 01-9.67-28.61l22.4-90.24A292.26 292.26 0 0164 456.21C64 285.98 227 148 428.09 148c190.93 0 347.29 124.53 362.52 282.82a244.97 244.97 0 00-26.47-2.62c-9.9.38-19.79 1.31-29.6 2.88zm-116.3 198.81a135.76 135.76 0 0047.05-19.04 114.24 114.24 0 0151.45-31 76.47 76.47 0 01-24.5 45.34 169.48 169.48 0 00-23.4 55.05 50.41 50.41 0 01-100.8.23 50.41 50.41 0 0150.2-50.58m90.8 121.32a168.6 168.6 0 0054.66 23.9 50.44 50.44 0 0135.64 86.08 50.38 50.38 0 01-86.04-35.66 136.74 136.74 0 00-18.67-47.28 114.71 114.71 0 01-30.54-51.8 76 76 0 0144.95 25.06z" />
    </svg>
  );
}
