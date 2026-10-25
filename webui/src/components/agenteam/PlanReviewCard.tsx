// webui/src/components/agenteam/PlanReviewCard.tsx
// 团队计划审批卡片：phase=staged 时置顶展示。
// 成员规划 + 任务 DAG 预览 + 批准/驳回按钮。

import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ClipboardCheck, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { buildMemberAvatarSeeds, fallbackAvatarSeed } from '../../lib/agenteam-avatars';
import { HumationAvatar } from './HumationAvatar';
import type { Agenteam } from '../../types/api';

interface PlanReviewCardProps {
  team: Agenteam;
  onApprove: () => Promise<void>;
  onDiscard: () => Promise<void>;
}

export const PlanReviewCard = memo(function PlanReviewCard({ team, onApprove, onDiscard }: PlanReviewCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'approve' | 'discard' | null>(null);
  // 成员头像唯一分配（避开四个模板固定头像）
  const avatarSeeds = useMemo(
    () => buildMemberAvatarSeeds(team.members, team.id),
    [team.members, team.id],
  );

  const handleApprove = async () => {
    setBusy('approve');
    try {
      await onApprove();
    } finally {
      setBusy(null);
    }
  };

  const handleDiscard = async () => {
    setBusy('discard');
    try {
      await onDiscard();
    } finally {
      setBusy(null);
    }
  };

  const awaitingFeedback = team.planReviewState === 'awaiting_feedback';

  return (
    <div className={cn('rounded-lg border px-3 py-2.5', awaitingFeedback ? 'border-amber-500/50 bg-amber-500/5' : 'border-primary/40 bg-primary/5')}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <ClipboardCheck className="size-3.5 text-primary" />
        {t('agenteam.planReview')}
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {awaitingFeedback ? t('agenteam.discardHint') : t('agenteam.planReviewHint')}
      </p>

      {/* 成员规划 */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {team.members
          .filter((m) => m.status !== 'removed')
          .map((m) => (
            <span
              key={m.id}
              className="flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-[11px]"
            >
              <HumationAvatar
                seed={avatarSeeds.get(m.name) ?? fallbackAvatarSeed(m.agentId, m.name)}
                size={16}
              />
              {m.name}
              {m.role && <span className="text-muted-foreground">·{m.role}</span>}
            </span>
          ))}
      </div>

      {/* 任务预览 */}
      <ScrollArea className="mt-2 max-h-32">
        <div className="space-y-0.5 pr-1">
          {team.tasks.map((task) => (
            <div key={task.id} className="flex items-center gap-1.5 text-[11px]">
              <span className="font-mono text-[10px] text-muted-foreground">{task.id}</span>
              <span className="truncate text-foreground">{task.subject}</span>
              {task.dependencies.length > 0 && (
                <span className="shrink-0 text-muted-foreground">← {task.dependencies.join(',')}</span>
              )}
              {task.assignee && (
                <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  {task.assignee}
                </span>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* 操作 */}
      <div className="mt-2.5 flex gap-2">
        <Button size="xs" disabled={busy !== null || awaitingFeedback} onClick={handleApprove}>
          <CheckCircle2 className="size-3.5" />
          {t('agenteam.approve')}
        </Button>
        <Button size="xs" variant="outline" disabled={busy !== null} onClick={handleDiscard}>
          <XCircle className="size-3.5" />
          {t('agenteam.discard')}
        </Button>
      </div>
    </div>
  );
});
