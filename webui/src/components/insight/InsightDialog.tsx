// webui/src/components/insight/InsightDialog.tsx
// 通用 AI 诊断/解读弹窗（链路式流式）：固定高度、内部滚动、移动端自适应。
// 一个弹窗对应一次独立生成（kind = cause | harness | resource），三者互不影响。

import type { ReactNode } from 'react';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InsightChain } from '@/components/insight/InsightChain';
import { useInsightStream } from '@/hooks/useInsightStream';
import type { InsightKind } from '@/types/api';

interface InsightDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 弹窗标题（已 i18n） */
  title: string;
  kind: InsightKind;
  sessionId?: string;
  /** 错误原文（仅 kind='cause' 需要；缺省时 harness 只基于任务流链路 + 日志） */
  providerError?: string;
  /** 标题前缀图标（可选） */
  icon?: ReactNode;
}

export function InsightDialog({
  open,
  onOpenChange,
  title,
  kind,
  sessionId,
  providerError,
  icon,
}: InsightDialogProps) {
  const stream = useInsightStream({ kind, active: open, sessionId, providerError });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 固定高度：不随内容增长（h 与 max-h 一致，桌面端固定 600px） */}
      <DialogContent size="xl" className="h-[80dvh] sm:h-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            {icon}
            {title}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <InsightChain state={stream} onRerun={stream.rerun} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
