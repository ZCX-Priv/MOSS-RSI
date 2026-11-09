// webui/src/components/shared/ConfirmPromptCard.tsx
// 权限确认向导：把一个 session 内全部 pending confirm 合并为一张卡，逐条（一屏一项）处理，
// 支持左右切换顺序（1 / N）。三级操作（允许 / 始终允许(本会话|全局) / 拒绝）不变。
// 样式与 AskPromptCard 一致，保证视觉统一。

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ShieldAlert,
  Check,
  X,
  Loader2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Infinity as InfinityIcon,
  Clock3,
  FolderGit2,
} from 'lucide-react';
import type { PendingConfirm } from '../../types/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useTask } from '../../hooks/useTask';

interface ConfirmPromptCardProps {
  /** 同一 session 的全部待确认权限（按 createdAt 升序合并为一张向导） */
  confirms: PendingConfirm[];
  className?: string;
}

/** 格式化工具参数详情为可读字符串 */
function formatDetails(toolName: string, details: unknown): string {
  if (!details || typeof details !== 'object') return '';
  const d = details as Record<string, unknown>;
  // terminal 工具优先展示 command
  if (toolName === 'terminal' && typeof d.command === 'string') {
    const parts = [`$ ${d.command}`];
    if (typeof d.cwd === 'string') parts.push(`(cwd: ${d.cwd})`);
    return parts.join(' ');
  }
  // write/edit 展示 path
  if (typeof d.path === 'string') return d.path;
  // 通用：JSON 格式化（截断过长内容）
  try {
    const json = JSON.stringify(d, null, 2);
    return json.length > 500 ? json.slice(0, 500) + '\n...' : json;
  } catch {
    return '';
  }
}

export function ConfirmPromptCard({ confirms, className }: ConfirmPromptCardProps) {
  const { t } = useTranslation();
  const { replyConfirm } = useTask();
  const [sending, setSending] = useState(false);
  const [step, setStep] = useState(0);

  // 合并向导：固定按收到时间升序，步进顺序稳定
  const sorted = useMemo(
    () => [...confirms].sort((a, b) => a.createdAt - b.createdAt),
    [confirms],
  );

  // 当前项被处理（confirms 收缩）→ 收敛步进并复位提交态
  useEffect(() => {
    setSending(false);
    if (step > sorted.length - 1) setStep(Math.max(0, sorted.length - 1));
  }, [sorted.length, step]);

  const current = sorted[Math.min(step, Math.max(0, sorted.length - 1))];
  if (!current) return null;

  const handle = (ok: boolean, remember?: 'session' | 'project' | 'global') => {
    if (sending) return;
    setSending(true);
    replyConfirm(current.sessionId, current.toolCallId, ok, remember);
  };

  const detailsText = formatDetails(current.toolName, current.details);
  const total = sorted.length;
  const isFirst = step <= 0;
  const isLast = step >= total - 1;

  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border border-amber-500/40 bg-amber-50/50 p-3 shadow-sm dark:bg-amber-950/20',
        className,
      )}
    >
      {/* 头部：标题 + 权限来源 + 步骤进度 + 顺序切换 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <ShieldAlert className="size-3.5 shrink-0 text-amber-600" />
        <span className="shrink-0 text-xs font-medium text-foreground">
          {t('task.confirmTitle')}
          {current.toolName ? ` · ${current.toolName}` : ''}
        </span>
        {/* 权限来源：区分主会话与同时发起的多个子代理 */}
        {current.source?.kind === 'subagent' ? (
          <Badge
            variant="secondary"
            className="max-w-[10rem] shrink-0 truncate border border-primary/30 bg-primary/10 px-1.5 text-[10px] font-normal text-primary-strong"
            title={current.source.name ?? current.source.template}
          >
            {t('task.confirmSourceSubagent', {
              name: current.source.name ?? current.source.template ?? 'Subagent',
            })}
          </Badge>
        ) : (
          <Badge
            variant="secondary"
            className="shrink-0 border border-border px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            {t('task.confirmSourceMain')}
          </Badge>
        )}
        {total > 1 && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t('task.askStepOf', { current: step + 1, total })}
          </span>
        )}
        {total > 1 && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={isFirst || sending}
              title={t('task.askPrev')}
              aria-label={t('task.askPrev')}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
              disabled={isLast || sending}
              title={t('task.askNext')}
              aria-label={t('task.askNext')}
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
      {/* 提示文案 */}
      <p className="whitespace-pre-wrap text-sm text-foreground">{current.question}</p>
      {/* 参数详情 */}
      {detailsText && (
        <div className="rounded-md bg-muted/60 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('task.confirmDetails')}
          </div>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
            {detailsText}
          </pre>
        </div>
      )}
      {/* 「始终允许」规则预览（safety 模块生成的建议规则） */}
      {current.ruleSuggestion && (
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock3 className="size-3 shrink-0" />
            <span>
              {t('task.confirmRulePreview')}
              <code className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                {current.ruleSuggestion}
              </code>
            </span>
          </div>
        </div>
      )}
      {/* 允许 / 始终允许(下拉) / 拒绝 按钮组 */}
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => handle(false)}
          disabled={sending}
          className="h-8 shrink-0 gap-1"
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
          <span>{t('task.confirmCancel')}</span>
        </Button>
        {current.ruleSuggestion && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={sending}
                className="h-8 shrink-0 gap-1 pr-1.5"
                title={t('task.confirmAlwaysAllow')}
              >
                <InfinityIcon className="size-3.5" />
                <span>{t('task.confirmAlwaysAllow')}</span>
                <ChevronDown className="size-3 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" sideOffset={4} collisionPadding={8} className="min-w-[14rem] p-1">
              <DropdownMenuItem onSelect={() => handle(true, 'session')} className="gap-2 px-2 py-1.5">
                <Clock3 className="size-3.5 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm leading-tight">{t('task.confirmRememberSession')}</span>
                  <span className="text-[11px] leading-tight text-muted-foreground">
                    {t('task.confirmRememberSessionDesc')}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handle(true, 'project')} className="gap-2 px-2 py-1.5">
                <FolderGit2 className="size-3.5 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm leading-tight">{t('task.confirmRememberProject')}</span>
                  <span className="text-[11px] leading-tight text-muted-foreground">
                    {t('task.confirmRememberProjectDesc')}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handle(true, 'global')} className="gap-2 px-2 py-1.5">
                <InfinityIcon className="size-3.5 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm leading-tight">{t('task.confirmRememberGlobal')}</span>
                  <span className="text-[11px] leading-tight text-muted-foreground">
                    {t('task.confirmRememberGlobalDesc')}
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          size="sm"
          onClick={() => handle(true)}
          disabled={sending}
          className="h-8 shrink-0 gap-1"
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          <span>{t('task.confirmApprove')}</span>
        </Button>
      </div>
    </div>
  );
}
