// webui/src/components/pages/settings/browser-shared.tsx
// 浏览器三模式设置页共享布局件：分区 / 行 / 格式化 / 安装状态徽章。

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type { BrowserInstallerState } from '@/types/api';

export function Section({
  title,
  desc,
  action,
  children,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {action}
      </div>
      {desc && <div className="text-xs text-muted-foreground">{desc}</div>}
      <div className="mt-2 flex min-w-0 flex-col rounded-lg border border-border px-4">{children}</div>
    </section>
  );
}

export function Row({ children, last = false }: { children: ReactNode; last?: boolean }) {
  return (
    <div
      className={
        last
          ? 'flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between'
          : 'flex min-w-0 flex-col gap-2 border-b border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between'
      }
    >
      {children}
    </div>
  );
}

export function formatClock(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '—';
  }
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function installerBadgeVariant(
  state: BrowserInstallerState,
): 'default' | 'secondary' | 'destructive' {
  if (state === 'installed' || state === 'already' || state === 'reloaded') return 'default';
  if (state === 'failed') return 'destructive';
  return 'secondary';
}

/** 安装状态徽章（安装器列表共用） */
export function InstallerBadge({ state }: { state: BrowserInstallerState }) {
  const { t } = useTranslation();
  return (
    <Badge variant={installerBadgeVariant(state)}>
      {t(`settings.browser.installerState.${state}`)}
    </Badge>
  );
}
