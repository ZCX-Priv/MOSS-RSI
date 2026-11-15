// webui/src/render/core/WebLinkCard.tsx
// 独立链接卡片：独占一行的 http(s) 链接渲染为「Globe + 标题 + 域名 + 跳转箭头」。
// 与文件类型卡片视觉同族（圆角、细边框、hover 提亮）。

import { ArrowUpRight, Globe } from 'lucide-react';

export interface WebLinkCardProps {
  href: string;
  label?: string;
}

function splitHref(href: string): { host: string; path: string } {
  try {
    const url = new URL(href);
    return { host: url.host, path: url.pathname === '/' ? '' : url.pathname };
  } catch {
    return { host: href, path: '' };
  }
}

export function WebLinkCard({ href, label }: WebLinkCardProps) {
  const { host, path } = splitHref(href);
  const rawLabel = (label ?? '').trim();
  const title = rawLabel !== '' && !/^https?:\/\//i.test(rawLabel) ? rawLabel : host;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      className="my-1 flex w-full min-w-0 max-w-xl items-center gap-2.5 rounded-xl border border-border bg-card/40 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        <Globe className="size-4 text-primary-strong" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs font-medium leading-tight text-foreground">{title}</span>
        <span className="truncate text-[10px] leading-tight text-muted-foreground">
          {host}
          {path}
        </span>
      </span>
      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}
