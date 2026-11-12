// webui/src/components/shared/ConnectionStatusTag.tsx
// 连接状态胶囊（中控岛 chips 行最左侧，「空闲/运行中」状态的右边）：
// 把 WS 连接 / 重连 / 会话恢复过程以标签形式呈现，替代原输入框上方常驻状态条。
//
// 状态覆盖（状态机与原 ConnectionStatusBar 一致）：
// - 正在连接（首次建连）/ 已连接（弱化显示，不抢注意力）
// - 已断开，正在重连（第 N 次；倒计时秒数放 title，胶囊内嵌「立即重试」小按钮）
// - 连接已恢复（断开后重连成功，短暂提示 3s 后回归「已连接」）
// - 正在恢复会话状态（订阅 + 拉取快照 + 恢复半截回复）
//
// 性能：局部 state + 500ms tick（仅在重连中计时），不触碰消息区渲染。

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, CircleCheck, Loader2, RefreshCw, Wifi } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStore } from '../../store';
import { wsClient } from '../../api/ws';

/** 「已恢复」提示的显示时长 */
const RESTORED_HINT_MS = 3000;

interface ConnectionStatusTagProps {
  /** 当前会话 id（用于读取该会话的「状态恢复中」标记；空串 = 空白页） */
  sessionId: string;
}

export function ConnectionStatusTag({ sessionId }: ConnectionStatusTagProps) {
  const { t } = useTranslation();
  const status = useStore((s) => s.wsStatus);
  const attempt = useStore((s) => s.wsReconnectAttempt);
  const nextRetryAt = useStore((s) => s.wsNextRetryAt);
  const restoredSeq = useStore((s) => s.wsRestoredSeq);
  const restoring = useStore((s) => s.wsRestoringBySession[sessionId] ?? false);
  /** 尾部同步中（catchUpTail：一轮结束 / 重连对齐拉取服务端正式消息） */
  const syncing = useStore((s) => s.syncingBySession[sessionId] ?? false);

  /** 重连倒计时（本地 tick，仅在需要时运行） */
  const [now, setNow] = useState(() => Date.now());
  /** 最近一次「已恢复」提示的过期时间 */
  const [restoredUntil, setRestoredUntil] = useState(0);
  const lastRestoredSeqRef = useRef(restoredSeq);

  // 恢复提示：restoredSeq 递增一次 → 显示 3s
  useEffect(() => {
    if (restoredSeq === lastRestoredSeqRef.current) return;
    lastRestoredSeqRef.current = restoredSeq;
    setRestoredUntil(Date.now() + RESTORED_HINT_MS);
  }, [restoredSeq]);

  // 倒计时 tick：只在「有下次重试时间」或「恢复提示未过期」时运行
  const needTick = nextRetryAt !== null || restoredUntil > 0;
  useEffect(() => {
    if (!needTick) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [needTick]);

  const secondsLeft =
    nextRetryAt !== null ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : null;

  // ---- 派生展示态 ----
  let tone: 'ok' | 'busy' | 'warn' = 'ok';
  let icon = <Wifi className="size-3.5 shrink-0" />;
  let text = t('conn.connected');
  /** 完整详情（含倒计时秒数）：放 title 悬停提示 */
  let detail = text;

  if (restoring) {
    tone = 'busy';
    icon = <Loader2 className="size-3.5 shrink-0 animate-spin" />;
    text = t('conn.restoringSession');
    detail = text;
  } else if (syncing) {
    // 尾部补齐中（一轮结束 / 重连对齐）：本地草稿 → 服务端正式消息的同步过程
    tone = 'busy';
    icon = <Loader2 className="size-3.5 shrink-0 animate-spin" />;
    text = t('conn.syncing');
    detail = text;
  } else if (status === 'open') {
    if (restoredUntil > now) {
      tone = 'ok';
      icon = <CircleCheck className="size-3.5 shrink-0" />;
      text = t('conn.restored');
      detail = text;
    } else {
      detail = text;
    }
  } else if (status === 'connecting' && attempt === 0) {
    tone = 'busy';
    icon = <Loader2 className="size-3.5 shrink-0 animate-spin" />;
    text = t('conn.connecting');
    detail = text;
  } else if (status === 'connecting') {
    tone = 'warn';
    icon = <Loader2 className="size-3.5 shrink-0 animate-spin" />;
    text = t('conn.reconnecting', { count: attempt });
    detail = t('conn.disconnectedRetry', { count: attempt, seconds: secondsLeft ?? 0 });
  } else {
    // closed / error
    tone = 'warn';
    icon = <CircleAlert className="size-3.5 shrink-0" />;
    text = t('conn.disconnected');
    detail =
      secondsLeft !== null && attempt > 0
        ? t('conn.disconnectedRetry', { count: attempt, seconds: secondsLeft })
        : text;
  }

  const showRetry = status !== 'open' && !restoring && !syncing;

  return (
    <div
      className={cn(
        'inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
        tone === 'ok' && 'border-border bg-transparent text-muted-foreground',
        tone === 'busy' && 'border-primary-strong/40 bg-primary-strong/5 text-primary-strong',
        tone === 'warn' && 'border-warning/50 bg-warning/10 text-warning',
      )}
      role="status"
      aria-live="polite"
      title={detail}
    >
      {icon}
      <span className="max-w-[10rem] truncate">{text}</span>
      {showRetry && (
        <button
          type="button"
          onClick={() => wsClient.retryNow()}
          title={t('conn.retryNow')}
          aria-label={t('conn.retryNow')}
          className="flex size-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="size-3" />
        </button>
      )}
    </div>
  );
}
