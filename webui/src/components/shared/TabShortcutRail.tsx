// webui/src/components/shared/TabShortcutRail.tsx
// 右侧快捷工具栏：竖直图标栏，一键展开右侧面板并打开/切换对应标签页。
// 只包含固定面板类型（不含 start / file）；移动端不渲染（右侧面板仍走 Sheet）。

import type { LucideIcon } from 'lucide-react';
import { Bot, FileDiff, Folder, List, SquareMousePointer, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { SidebarTabType } from '@/types/api';

/** 快捷栏可打开的固定面板类型 */
export type ShortcutTabType = Exclude<SidebarTabType, 'start' | 'file'>;

interface ShortcutItem {
  type: ShortcutTabType;
  /** 标签标题 i18n key */
  titleKey: string;
  Icon: LucideIcon;
}

/** 固定 6 项，顺序：摘要 / 文件 / 变更 / 电脑 / 智能体 / 终端 */
const TAB_SHORTCUTS: readonly ShortcutItem[] = [
  { type: 'summary', titleKey: 'task.taskSummary', Icon: List },
  { type: 'files', titleKey: 'task.files', Icon: Folder },
  { type: 'changes', titleKey: 'task.fileChanges', Icon: FileDiff },
  { type: 'computer', titleKey: 'computer.title', Icon: SquareMousePointer },
  { type: 'agents', titleKey: 'task.agents', Icon: Bot },
  { type: 'terminal', titleKey: 'terminal.title', Icon: Terminal },
];

interface TabShortcutRailProps {
  /** 当前活跃标签类型（用于高亮对应图标；file / start 不匹配任何图标） */
  activeType?: SidebarTabType;
  /** 点击图标：打开或切换到对应类型标签（宿主负责展开右侧面板） */
  onOpen: (type: ShortcutTabType, titleKey: string) => void;
}

export function TabShortcutRail({ activeType, onOpen }: TabShortcutRailProps) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t('task.tabShortcuts')}
      className="flex flex-col items-center gap-0.5 rounded-2xl border border-border bg-card/60 p-1 shadow-sm"
    >
      {TAB_SHORTCUTS.map(({ type, titleKey, Icon }) => {
        const active = activeType === type;
        const label = t(titleKey);
        return (
          <button
            key={type}
            type="button"
            title={label}
            aria-label={label}
            aria-current={active ? 'true' : undefined}
            onClick={() => onOpen(type, titleKey)}
            className={cn(
              'flex size-9 cursor-pointer items-center justify-center rounded-xl transition-colors',
              active
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <Icon className="size-[18px]" strokeWidth={1.75} />
          </button>
        );
      })}
    </nav>
  );
}
