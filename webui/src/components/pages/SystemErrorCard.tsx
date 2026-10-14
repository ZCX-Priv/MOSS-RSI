// webui/src/components/pages/SystemErrorCard.tsx
// 模型请求失败「系统错误卡片」（图1 样式）：红卡片 + 固定标题 + 诊断按钮 + 可展开原始错误 + 统一 AI 回复操作栏。
// 历史恢复（refresh）与实时（WS error 事件）两条路径产出的 TaskMessage 都带 isError/errorDetail，渲染完全一致。

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleMinus, CircleX, ChevronDown, ChevronUp, Copy, RefreshCw, Stethoscope } from 'lucide-react';
import type { TaskMessage } from '@/types/api';

/** 统一 AI 回复操作栏：复制（每条回复结尾都有）+ 重新生成 / 诊断(Harness)（仅最新一段回复结尾）；常显以保证可发现性 */
export function MessageActions({
  content,
  onCopy,
  onRegenerate,
  regenerateDisabled,
  showRegenerate = true,
  showDiagnose = false,
  onDiagnose,
}: {
  content: string;
  onCopy?: (content: string) => void;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
  /** 是否展示「重新生成」按钮（仅最新一段回复结尾；默认展示） */
  showRegenerate?: boolean;
  /** 是否展示「诊断(Harness)」按钮（仅最新一段回复结尾；错误卡不展示） */
  showDiagnose?: boolean;
  /** 「诊断(Harness)」按钮点击：打开 Harness 缺陷诊断弹窗 */
  onDiagnose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-0.5 text-muted-foreground">
      <button
        type="button"
        title={t('task.messageCopy')}
        aria-label={t('task.messageCopy')}
        onClick={() => onCopy?.(content)}
        className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground"
      >
        <Copy className="size-3.5" />
      </button>
      {showRegenerate && (
        <button
          type="button"
          title={regenerateDisabled ? t('task.regenerateDisabled') : t('task.regenerateReply')}
          aria-label={t('task.regenerateReply')}
          disabled={regenerateDisabled}
          onClick={() => onRegenerate?.()}
          className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" />
        </button>
      )}
      {showDiagnose && (
        <button
          type="button"
          title={t('task.harnessDiagnoseTooltip')}
          aria-label={t('task.harnessDiagnoseTooltip')}
          onClick={() => onDiagnose?.()}
          className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground"
        >
          <Stethoscope className="size-3.5" />
        </button>
      )}
    </div>
  );
}

interface SystemErrorCardProps {
  message: TaskMessage;
  onCopy?: (content: string) => void;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
  /** 是否渲染底部操作栏（仅回复结尾；不在列表末尾的历史错误卡不显示） */
  showActions?: boolean;
  /** 是否展示「重新生成」按钮 */
  showRegenerate?: boolean;
  /** 点击「错误诊断」：打开 AI 错误诊断弹窗（入参为原始 provider 错误文本） */
  onDiagnose?: (errorDetail: string) => void;
}

export function SystemErrorCard({
  message,
  onCopy,
  onRegenerate,
  regenerateDisabled,
  showActions,
  showRegenerate,
  onDiagnose,
}: SystemErrorCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detail = message.errorDetail ?? message.content;

  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 text-sm text-foreground">{t('task.systemErrorTitle')}</span>
        <button
          type="button"
          onClick={() => onDiagnose?.(detail)}
          className="flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/15"
        >
          <Stethoscope className="size-3.5" />
          {t('task.errorDiagnose')}
        </button>
        <button
          type="button"
          title={expanded ? t('task.errorCollapse') : t('task.errorExpand')}
          aria-label={expanded ? t('task.errorCollapse') : t('task.errorExpand')}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-destructive/80 transition-colors hover:bg-destructive/15"
        >
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 rounded border border-border bg-black/20 p-2 font-mono text-xs whitespace-pre-wrap break-all text-foreground">
          {detail || t('task.errorDiagnoseEmpty')}
        </div>
      )}
      {showActions && (
        <div className="mt-1.5 flex items-center justify-between">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <CircleMinus className="size-3 shrink-0" />
            {t('task.abnormalInterrupt')}
          </span>
          <MessageActions
            content={detail}
            onCopy={onCopy}
            onRegenerate={onRegenerate}
            regenerateDisabled={regenerateDisabled}
            showRegenerate={showRegenerate}
          />
        </div>
      )}
    </div>
  );
}
