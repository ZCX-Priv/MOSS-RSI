// webui/src/components/shared/MaxTurnsNoticeCard.tsx
// 消息流轮数触顶提示卡：达到 agent.maxTurns 上限时插入消息流，
// 说明上限与上下文保留状态，附「继续执行」按钮（发送"继续"起新 run，轮数重新计数）。

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const MaxTurnsNoticeCard = memo(function MaxTurnsNoticeCard({
  notice,
  onContinue,
  disabled,
}: {
  notice: { maxTurns: number };
  /** 点击「继续执行」：复用现有发送流程发送"继续" */
  onContinue?: () => void;
  /** 生成中禁用按钮（防并发 run） */
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex justify-center py-1">
      <div className="w-full max-w-2xl rounded-lg border border-dashed border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Gauge className="size-3.5 shrink-0 text-warning" />
          <span className="font-medium text-foreground">
            {t('task.maxTurnsTitle')}
            {notice.maxTurns > 0 && <span className="ml-1 tabular-nums">({notice.maxTurns})</span>}
          </span>
        </div>
        <p className="mt-1 leading-relaxed">
          {t('task.maxTurnsDesc', { maxTurns: notice.maxTurns > 0 ? notice.maxTurns : '' })}
        </p>
        {onContinue && (
          <div className="mt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={onContinue}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <Play className="size-3" />
              {t('task.maxTurnsContinue')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
