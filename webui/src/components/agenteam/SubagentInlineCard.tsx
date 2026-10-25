// webui/src/components/agenteam/SubagentInlineCard.tsx
// 对话流内 Subagent 卡片：固定头像 + 角色名 + 状态徽章 + 树形任务描述。
// 可手动展开：展开后内联展示该 subagent 的「微缩任务流」（AgentTaskFlow）+ 最终报告。
// 「打开完整任务页」常驻卡片底部（运行/完成都显示），入口永久可用。
// 运行期会话 id 由 parentToolCallId 精确绑定（lib/subagent-sessions.ts），同模板并发不串台。

import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, CircleCheck, CircleX, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStore } from '../../store';
import { MarkdownRenderer } from '../../render';
import { getSubagentSession, subscribeSubagentSession } from '../../lib/subagent-sessions';
import { templateAvatarSeed } from '../../lib/agenteam-avatars';
import { HumationAvatar } from './HumationAvatar';
import { AgentTaskFlow } from './AgentTaskFlow';
import type { ToolCall } from '../../types/api';

interface SubagentInlineCardProps {
  /** 模板 agentId（如 agent_explorer） */
  template: string;
  /** 任务描述 */
  task: string;
  /** 触发本次子代理的工具调用 id（用于精确关联实时事件，避免同模板并发串台） */
  toolCallId?: string;
  /** 工具调用状态（generating/executing=运行中；done=完成；缺省按完成处理） */
  status?: ToolCall['status'];
  /** 工具结果文本（完成后展示最终报告） */
  resultText?: string;
  /** 工具结果是否错误 */
  isError?: boolean;
}

/** agent(mode=subagent) 结果文本固定前缀（中/英文构建都兼容），剥离后为最终报告正文 */
const SUBAGENT_PREFIX = /^(?:子代理已完成|Subagent finished) \([^)]*\):\n*/;
/** 结果文本中的子代理会话 id（用于展开微缩任务流） */
const SUBAGENT_SESSION = /session=([0-9a-zA-Z_-]+)/;

export const SubagentInlineCard = memo(function SubagentInlineCard({
  template,
  task,
  toolCallId,
  status,
  resultText,
  isError,
}: SubagentInlineCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const running = status === 'generating' || status === 'executing';

  // 注册表显示名（如"探索专家"），查不到回落模板 id
  const agentName = useStore((s) => s.agents.find((a) => a.id === template)?.name);

  // 运行期会话 id：只认「父工具调用 id → 子代理 taskId」的精确绑定（不再按模板猜测）
  const [boundSessionId, setBoundSessionId] = useState<string | undefined>(() =>
    toolCallId ? getSubagentSession(toolCallId) : undefined,
  );
  useEffect(() => {
    if (!toolCallId) return;
    setBoundSessionId(getSubagentSession(toolCallId));
    return subscribeSubagentSession((id, sid) => {
      if (id === toolCallId) setBoundSessionId(sid);
    });
  }, [toolCallId]);

  const report = resultText?.replace(SUBAGENT_PREFIX, '') ?? '';
  const resultSessionId = resultText?.match(SUBAGENT_SESSION)?.[1] ?? null;
  // 过程会话 id：完成后结果文本里的 session 权威；运行中只认精确绑定
  const flowSessionId = resultSessionId ?? boundSessionId ?? null;
  // 缺参兜底：模板/任务缺失时仍渲染占位（名称回落 'subagent'），保证工具调用处不丢卡
  const displayName = agentName || template || 'subagent';
  const avatarSeed = templateAvatarSeed(template) ?? (template || 'subagent');

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
      {/* 行1：展开按钮（固定头像 + 角色名 + 状态徽章） */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex min-w-0 items-center gap-2 text-left"
      >
        <HumationAvatar seed={avatarSeed} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{displayName}</div>
          {template && (
            <div className="truncate font-mono text-[10px] text-muted-foreground">{template}</div>
          )}
        </div>
        {/* 状态徽章 */}
        {running ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
            <Loader2 className="size-2.5 animate-spin" />
            {t('agenteam.card.running')}
          </span>
        ) : isError ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-500">
            <CircleX className="size-2.5" />
            {t('agenteam.taskStatus.failed')}
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-500">
            <CircleCheck className="size-2.5" />
            {t('agenteam.taskStatus.completed')}
          </span>
        )}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {/* 行2：树形任务描述 */}
      {task && (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 select-none text-muted-foreground/50">└</span>
          <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={task}>
            {task}
          </span>
        </div>
      )}

      {/* 展开：微缩任务流 + 最终报告 */}
      {expanded && (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
          <AgentTaskFlow sessionId={flowSessionId} running={running} showOpenButton={false} />
          {!running && report && (
            <div className="flex flex-col gap-1">
              <span className={cn('text-[11px] text-muted-foreground', isError && 'text-destructive')}>
                {isError ? t('task.errorResult') : t('agenteam.card.report')}
              </span>
              <div className="max-h-[300px] overflow-auto no-scrollbar text-xs">
                {isError ? (
                  <pre className="mono whitespace-pre-wrap break-all text-destructive">{report}</pre>
                ) : (
                  <MarkdownRenderer text={report} />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 常驻入口：运行中与完成后都显示（不依赖展开状态） */}
      {flowSessionId && (
        <button
          type="button"
          onClick={() => navigate(`/task/${flowSessionId}`)}
          className="flex items-center gap-1 self-start border-t border-border/60 pt-2 text-[11px] text-primary-strong transition-colors hover:text-primary"
        >
          <ExternalLink className="size-3" />
          {t('agenteam.card.openFullTask')}
        </button>
      )}
    </div>
  );
});
