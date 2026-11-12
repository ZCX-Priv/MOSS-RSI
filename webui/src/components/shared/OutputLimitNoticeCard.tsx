// webui/src/components/shared/OutputLimitNoticeCard.tsx
// 消息流「输出长度触顶」提示卡：finishReason==='length' 时插入消息流，
// 说明本次生成被模型输出 token 上限截断（思考与回复共用该预算），附「继续生成」按钮。

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Scissors, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const OutputLimitNoticeCard = memo(function OutputLimitNoticeCard({
  notice,
  onContinue,
  disabled,
}: {
  notice: { maxTokens?: number };
  /** 点击「继续生成」：复用现有发送流程发送"继续" */
  onContinue?: () => void;
  /** 生成中禁用按钮（防并发 run） */
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex justify-center py-1">
      <div className="w-full max-w-2xl rounded-lg border border-dashed border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Scissors className="size-3.5 shrink-0 text-warning" />
          <span className="font-medium text-foreground">
            {t('task.outputLimitTitle')}
            {typeof notice.maxTokens === 'number' && notice.maxTokens > 0 && (
              <span className="ml-1 tabular-nums">({notice.maxTokens})</span>
            )}
          </span>
        </div>
        <p className="mt-1 leading-relaxed">{t('task.outputLimitDesc')}</p>
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
              {t('task.outputLimitContinue')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
