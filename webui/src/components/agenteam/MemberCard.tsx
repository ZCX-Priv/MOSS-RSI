// webui/src/components/agenteam/MemberCard.tsx
// 专家团成员卡片：Humation 头像 + 角色徽章 + 状态点 + 当前任务 + 会话跳转。

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fallbackAvatarSeed } from '../../lib/agenteam-avatars';
import { HumationAvatar } from './HumationAvatar';
import type { TeamMember, TeamTask } from '../../types/api';

interface MemberCardProps {
  member: TeamMember;
  /** 该成员当前进行中的任务（working 时显示） */
  activeTask?: TeamTask;
  /** 团队级唯一头像 seed（由 buildMemberAvatarSeeds 分配；缺省回退旧的 agentId/name 规则） */
  avatarSeed?: string;
  compact?: boolean;
}

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-emerald-500',
  working: 'bg-blue-500 animate-pulse',
  removed: 'bg-muted-foreground/40',
};

export const MemberCard = memo(function MemberCard({ member, activeTask, avatarSeed, compact }: MemberCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const seed = avatarSeed ?? fallbackAvatarSeed(member.agentId, member.name);

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2',
        member.status === 'removed' && 'opacity-50',
      )}
    >
      <HumationAvatar seed={seed} size={compact ? 28 : 36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{member.name}</span>
          {member.role && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
              {member.role}
            </span>
          )}
          <span
            className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[member.status] ?? 'bg-muted-foreground/40')}
            title={t(`agenteam.memberStatus.${member.status}`)}
          />
        </div>
        {member.status === 'working' ? (
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 shrink-0 animate-spin" />
            <span className="truncate">
              {activeTask ? activeTask.subject : t(`agenteam.memberStatus.working`)}
            </span>
          </div>
        ) : (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {member.agentId ? member.agentId : t('agenteam.customPrompt')}
          </div>
        )}
      </div>
      {member.sessionId && member.status !== 'removed' && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          title={t('agenteam.viewSession')}
          onClick={() => navigate(`/task/${member.sessionId}`)}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      )}
    </div>
  );
});
