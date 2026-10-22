// webui/src/components/shared/ConfirmPromptCard.tsx
// 确认卡片：渲染 safety 模块决策为 ask 的工具调用（terminal/write/edit/delete/MCP 等），
// 提供「允许 / 始终允许(本会话|全局) / 拒绝」三级按钮，调用 replyConfirm 打通链路。
// confirm 不进入 message.toolCalls（走独立 WS 事件 → store.pendingConfirms），故需独立渲染。
// 样式与 AskPromptCard 一致，保证视觉统一。

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, Check, X, Loader2, ChevronDown, Infinity as InfinityIcon, Clock3 } from 'lucide-react';
import type { PendingConfirm } from '../../types/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useTask } from '../../hooks/useTask';

interface ConfirmPromptCardProps {
  confirm: PendingConfirm;
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

export function ConfirmPromptCard({ confirm, className }: ConfirmPromptCardProps) {
  const { t } = useTranslation();
  const { replyConfirm } = useTask();
  const [sending, setSending] = useState(false);

  const handle = (ok: boolean, remember?: 'session' | 'global') => {
    if (sending) return;
    setSending(true);
    // replyConfirm 同步发送 WS tool.confirm.reply（含 remember 级别）并 removePendingConfirm，
    // 本组件随 store 变化自动卸载，无需额外清理
    replyConfirm(confirm.sessionId, confirm.toolCallId, ok, remember);
  };

  const detailsText = formatDetails(confirm.toolName, confirm.details);

  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border border-amber-500/40 bg-amber-50/50 p-3 shadow-sm dark:bg-amber-950/20',
        className,
      )}
    >
      {/* 头部 */}
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="size-3.5 text-amber-600" />
        <span className="text-xs font-medium text-foreground">
          {t('task.confirmTitle')}
          {confirm.toolName ? ` · ${confirm.toolName}` : ''}
        </span>
      </div>
      {/* 提示文案 */}
      <p className="whitespace-pre-wrap text-sm text-foreground">{confirm.question}</p>
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
      {confirm.ruleSuggestion && (
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock3 className="size-3 shrink-0" />
            <span>
              {t('task.confirmRulePreview')}
              <code className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                {confirm.ruleSuggestion}
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
        {confirm.ruleSuggestion && (
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
