// webui/src/components/shared/TodoProgressCard.tsx
// Todo 进度卡片：展示进度头部 + 三态动画图标。
// 两种变体：sidebar（侧边栏，无关闭按钮）和 inline（任务流内，带关闭按钮）。
// 两侧共享同一 store 数据源，WS 推送时天然同步。

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, Circle, Loader2, ListTodo, ChevronDown } from 'lucide-react';
import type { TodoItem } from '../../types/api';
import { cn } from '@/lib/utils';

interface TodoProgressCardProps {
  todos: TodoItem[];
  /** inline 变体显示关闭按钮，sidebar 变体不显示 */
  variant?: 'sidebar' | 'inline';
  onClose?: () => void;
  className?: string;
}

export function TodoProgressCard({
  todos,
  variant = 'sidebar',
  onClose,
  className,
}: TodoProgressCardProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  const total = todos.length;
  const completed = todos.filter((item) => item.status === 'completed').length;

  // sidebar 空状态
  if (total === 0 && variant === 'sidebar') {
    return (
      <div className={cn('flex flex-col gap-2 p-4', className)}>
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <ListTodo className="size-3.5 text-muted-foreground" />
          <span>{t('task.todo')}</span>
        </div>
        <span className="text-xs text-muted-foreground">{t('task.noTodos')}</span>
      </div>
    );
  }

  // inline 空状态：不渲染
  if (total === 0 && variant === 'inline') return null;

  const isInline = variant === 'inline';

  return (
    <div
      className={cn(
        'flex flex-col gap-2.5',
        'min-h-0 overflow-hidden',
        // sidebar: 限高 240px，避免挤占 Context Section
        !isInline && 'max-h-60',
        // inline: 限高 320px，避免在任务流中过长
        isInline && 'max-h-80',
        isInline &&
          'rounded-lg border border-border bg-card p-3 shadow-sm',
        !isInline && 'p-4',
        className,
      )}
    >
      {/* 头部：进度计数 + 关闭按钮 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <ListTodo className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">
            {completed}/{total} {t('task.todoCompleted')}
          </span>
        </div>
        {isInline && (
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={collapsed ? t('task.todoExpand') : t('task.todoCollapse')}
            aria-expanded={!collapsed}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
          </button>
        )}
      </div>

      {/* 任务列表（inline 折叠时隐藏） */}
      {(!isInline || !collapsed) && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
          {todos.map((item) => (
            <TodoRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 单个任务行（导出供中控岛 todo 模块直接渲染裸条目） */
export function TodoRow({ item }: { item: TodoItem }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {item.status === 'completed' && (
        <CircleCheck className="size-4 shrink-0 text-emerald-500" />
      )}
      {item.status === 'in_progress' && (
        <Loader2 className="size-4 shrink-0 animate-spin text-primary-strong" />
      )}
      {item.status === 'pending' && (
        <Circle className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span
        className={cn(
          'min-w-0 break-words text-xs',
          item.status === 'completed' && 'text-muted-foreground line-through',
          item.status === 'in_progress' && 'font-medium text-foreground',
          item.status === 'pending' && 'text-muted-foreground',
        )}
      >
        {item.text}
      </span>
    </div>
  );
}
