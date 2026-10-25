// webui/src/components/agenteam/MessageFeed.tsx
// 专家团消息流：Humation 头像时间线（from → to + content + 时间戳）。

import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { fallbackAvatarSeed } from '../../lib/agenteam-avatars';
import { HumationAvatar } from './HumationAvatar';
import type { TeamMessage } from '../../types/api';

interface MessageFeedProps {
  messages: TeamMessage[];
  members: Array<{ name: string; agentId?: string }>;
  /** 成员名 → 团队级唯一头像 seed */
  avatarSeeds?: ReadonlyMap<string, string>;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export const MessageFeed = memo(function MessageFeed({ messages, members, avatarSeeds }: MessageFeedProps) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const prevCount = useRef(0);

  useEffect(() => {
    if (messages.length !== prevCount.current) {
      prevCount.current = messages.length;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [messages.length]);

  if (messages.length === 0) {
    return <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t('agenteam.messages')}</div>;
  }

  return (
    <div className="space-y-2 px-1">
      {messages.map((msg) => {
        const fromMember = members.find((m) => m.name === msg.from);
        const isCaptain = msg.from === 'captain';
        const isUser = msg.from === 'user';
        const seed = fromMember
          ? (avatarSeeds?.get(fromMember.name) ?? fallbackAvatarSeed(fromMember.agentId, fromMember.name))
          : msg.from;
        return (
          <div key={msg.id} className="flex gap-2">
            {isUser ? (
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                Me
              </span>
            ) : (
              <HumationAvatar seed={isCaptain ? 'captain' : seed} size={24} />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className={cn('text-[11px] font-medium', isCaptain ? 'text-primary' : 'text-foreground')}>
                  {msg.from}
                </span>
                <span className="text-[10px] text-muted-foreground">→ {msg.to}</span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                  {formatTime(msg.ts)}
                </span>
              </div>
              <div className="mt-0.5 whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1 text-[11px] leading-relaxed text-foreground">
                {msg.content}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
});
