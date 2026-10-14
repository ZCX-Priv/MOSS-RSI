import { useEffect, useRef, useState, useCallback, memo, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  MessageCirclePlus,
  Blocks,
  AlarmClock,
  ListChecks,
  Search,
  MoreHorizontal,
  Pencil,
  Trash2,
  ArrowLeft,
  GripVertical,
  Check,
  CheckCheck,
  X,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  CircleAlert,
  Activity,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  defaultDropAnimationSideEffects,
  pointerWithin,
  closestCenter,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import type { OverlayType } from '../../types';
import type { TaskItem, TaskGroup } from '../../types/api';
import { useStore } from '../../store';
import {
  Sidebar as UISidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { UserMenu } from '../overlays/UserMenu';
import { ConfirmDialog } from '../overlays/ConfirmDialog';
import { useTasks } from '../../hooks/useTasks';
import { api } from '../../api/http';
import { settingsNavItems, settingsSearchIndex } from '../pages/SettingsPage';

/** DragOverlay 回落动画：轻快归位，active 原位保持半透明占位 */
const dropAnimation: DropAnimation = {
  duration: 220,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.35' } } }),
};

interface SidebarProps {
  onOpenOverlay: (overlay: OverlayType) => void;
}

export function Sidebar({ onOpenOverlay }: SidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { tasks, taskGroups, updateTask, deleteTask, reorderTasks, createTaskGroup, updateTaskGroup, deleteTaskGroup, reload, loadMore, hasMore, loadingMore } = useTasks();
  const isSettingsRoute = pathname.startsWith('/settings');
  const [settingsSearch, setSettingsSearch] = useState('');
  const { isMobile, setOpenMobile } = useSidebar();

  // 移动端点击导航后关闭 Sheet 抽屉，避免 z-50 遮罩持续覆盖屏幕
  const closeMobile = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  // 任务行操作（useCallback 稳定引用：TaskRow memo 的浅比较依赖）
  const handleTaskNavigate = useCallback(
    (id: string) => {
      closeMobile();
      navigate(`/task/${id}`);
    },
    [closeMobile, navigate],
  );
  const handleTaskRename = useCallback((tk: TaskItem) => {
    setRenameTitle(tk.title);
    setRenameTask(tk);
  }, []);
  const handleTaskDelete = useCallback((id: string) => {
    setDeleteTaskId(id);
  }, []);

  // 任务项操作状态
  const [renameTask, setRenameTask] = useState<TaskItem | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);

  // 分组管理状态：受控折叠 + 新建/重命名/删除
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const g of taskGroups) initial[g.id] = g.expanded ?? true;
    return initial;
  });
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [renameGroup, setRenameGroup] = useState<TaskGroup | null>(null);
  const [renameGroupName, setRenameGroupName] = useState('');
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null);
  // 删除分组时是否连同组内所有任务一并删除（否则任务迁回默认分组）
  const [deleteGroupAlsoTasks, setDeleteGroupAlsoTasks] = useState(false);

  const toggleGroup = (groupId: string) => {
    setGroupExpanded((prev) => ({ ...prev, [groupId]: !(prev[groupId] ?? true) }));
  };

  const handleCreateGroup = async () => {
    if (newGroupName.trim()) {
      await createTaskGroup(newGroupName.trim());
      setNewGroupName('');
    }
    setNewGroupOpen(false);
  };

  const handleRenameGroup = async () => {
    if (renameGroup && renameGroupName.trim()) {
      await updateTaskGroup(renameGroup.id, { name: renameGroupName.trim() });
      setRenameGroup(null);
    }
  };

  /** 删除后若活跃任务已不存在（被删），回到"新建任务"页（与侧边栏"新任务"按钮行为一致） */
  const goHomeIfTaskGone = (activeIdBefore: string | null) => {
    if (!activeIdBefore) return;
    if (useStore.getState().tasks.some((t) => t.id === activeIdBefore)) return;
    useStore.getState().setActiveSession(null);
    useStore.getState().setActiveTaskId(null);
    navigate('/task');
  };

  const handleDeleteGroup = async () => {
    if (deleteGroupId) {
      // 勾选：连组内任务（含 session 文件）一并删除；未勾选：组内任务迁回默认分组
      const activeBefore = useStore.getState().activeTaskId;
      await deleteTaskGroup(deleteGroupId, 'default', deleteGroupAlsoTasks);
      setDeleteGroupId(null);
      goHomeIfTaskGone(activeBefore);
    }
  };

  const handleRename = async () => {
    if (renameTask && renameTitle.trim()) {
      await updateTask(renameTask.id, { title: renameTitle.trim() });
      setRenameTask(null);
    }
  };

  // 管理模式（批量选择 + 拖拽排序/移组）：仅管理模式下允许拖拽
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // 拖拽草稿态：onDragStart 快照任务列表，拖动期间以其为渲染数据源（跨组实时预览）；
  // 提交时按草稿落定位置持久化，取消（Esc）直接丢弃草稿即完整回滚
  const [draftTasks, setDraftTasks] = useState<TaskItem[] | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const displayTasks = draftTasks ?? tasks;
  const activeDragTask = activeDragId ? (displayTasks.find((t) => t.id === activeDragId) ?? null) : null;
  // 折叠分组自动展开定时器（拖拽悬停组标题 ~350ms 后展开）
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearExpandTimer = useCallback(() => {
    if (expandTimerRef.current !== null) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearExpandTimer, [clearExpandTimer]);

  const visibleTaskIds = tasks.map((t) => t.id);
  const allSelected = visibleTaskIds.length > 0 && visibleTaskIds.every((id) => selectedIds.has(id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(visibleTaskIds));
  };

  const handleBatchDelete = async () => {
    // 逐个直调 API + 本地移除，最后统一刷新（避免 N 次全量加载；同时感知空文件夹分组的自动销毁）
    const activeBefore = useStore.getState().activeTaskId;
    for (const id of selectedIds) {
      try {
        await api.deleteTask(id);
        useStore.getState().removeTask(id);
      } catch (err) {
        console.warn('batch deleteTask failed:', err);
      }
    }
    setSelectedIds(new Set());
    setBatchDeleteOpen(false);
    // 删除广播已实时同步侧边栏；仅在广播不可用（WS 未连接）时兜底全量刷新
    if (useStore.getState().wsStatus !== 'open') await reload();
    goHomeIfTaskGone(activeBefore);
  };

  // 碰撞检测：指针下有任务（sortable item）时优先任务（保证组内/跨组精确落点）；
  // 若指针落在让位缝隙（任务已 transform 平移，rect 不再包含指针）而命中组容器，
  // 则在该组内按中心距离吸附最近任务，避免误判整组导致落点错置组首/组尾；
  // 组标题 droppable 保留（折叠组悬停展开 / 落组首）
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const isTaskId = (id: unknown) => {
      const s = String(id);
      return !s.startsWith('group:') && !s.startsWith('group-header:');
    };
    const pointerCollisions = pointerWithin(args);
    const taskCollision = pointerCollisions.find((c) => isTaskId(c.id) && c.id !== args.active.id);
    if (taskCollision) return [taskCollision];
    const groupCollision = pointerCollisions.find((c) => String(c.id).startsWith('group:'));
    if (groupCollision) {
      const groupId = String(groupCollision.id).slice('group:'.length);
      const groupTaskContainers = args.droppableContainers.filter(
        (c) =>
          isTaskId(c.id) &&
          c.id !== args.active.id &&
          (c.data.current as { groupId?: string } | undefined)?.groupId === groupId,
      );
      if (groupTaskContainers.length > 0) {
        return closestCenter({ ...args, droppableContainers: groupTaskContainers });
      }
      return [groupCollision]; // 空组：保持组容器落点
    }
    return pointerCollisions;
  }, []);

  // 拖拽全程共享的落点解析（与 sortable 让位预览同一套 arrayMove 语义：落点 = over 所在位置）：
  // over 为任务 → 占据其位置；over 为组容器 → 组末尾；over 为组标题 → 组首
  const resolveInsertion = useCallback(
    (source: TaskItem[], activeId: string, overId: string): { groupId: string; index: number } | null => {
      if (overId.startsWith('group:')) {
        const groupId = overId.slice('group:'.length);
        return { groupId, index: source.filter((t) => t.groupId === groupId && t.id !== activeId).length };
      }
      if (overId.startsWith('group-header:')) {
        return { groupId: overId.slice('group-header:'.length), index: 0 };
      }
      const overTask = source.find((t) => t.id === overId);
      if (!overTask || overTask.id === activeId) return null;
      const members = source.filter((t) => t.groupId === overTask.groupId && t.id !== activeId);
      return { groupId: overTask.groupId, index: members.findIndex((t) => t.id === overId) };
    },
    [],
  );

  // 把 active 任务按落点插入扁平列表（其余任务相对顺序不变；渲染按 groupId 过滤，仅需保证组内顺序）
  const placeTask = useCallback(
    (source: TaskItem[], activeId: string, overId: string): TaskItem[] | null => {
      const activeTask = source.find((t) => t.id === activeId);
      const target = resolveInsertion(source, activeId, overId);
      if (!activeTask || !target) return null;
      const rest = source.filter((t) => t.id !== activeId);
      const members = rest.filter((t) => t.groupId === target.groupId);
      const moved = { ...activeTask, groupId: target.groupId };
      if (members.length === 0) return [...rest, moved];
      if (target.index <= 0) {
        const at = rest.findIndex((t) => t.id === members[0].id);
        return [...rest.slice(0, at), moved, ...rest.slice(at)];
      }
      if (target.index >= members.length) {
        const at = rest.findIndex((t) => t.id === members[members.length - 1].id);
        return [...rest.slice(0, at + 1), moved, ...rest.slice(at + 1)];
      }
      const at = rest.findIndex((t) => t.id === members[target.index].id);
      return [...rest.slice(0, at), moved, ...rest.slice(at)];
    },
    [resolveInsertion],
  );

  const handleDragStart = ({ active }: DragStartEvent) => {
    // 快照为草稿（浅拷贝，避免拖动期间的乐观移动改脏 store）
    setDraftTasks(useStore.getState().tasks.map((t) => ({ ...t })));
    setActiveDragId(String(active.id));
  };

  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const overId = String(over.id);
    // 悬停折叠组标题：短延时自动展开（防闪烁），展开后即可落入组内精确位置
    if (overId.startsWith('group-header:')) {
      const groupId = overId.slice('group-header:'.length);
      if (!(groupExpanded[groupId] ?? true) && expandTimerRef.current === null) {
        expandTimerRef.current = setTimeout(() => {
          setGroupExpanded((prev) => ({ ...prev, [groupId]: true }));
          expandTimerRef.current = null;
        }, 350);
      }
    } else {
      clearExpandTimer();
    }
    // 跨组：把 active 乐观移入目标组的 over 位置（arrayMove 语义），触发目标组实时让位预览；
    // 同组交由 sortable 自身 transform 预览，dragEnd 以同一语义落序
    const activeId = String(active.id);
    setDraftTasks((prev) => {
      if (!prev) return prev;
      const current = prev.find((t) => t.id === activeId);
      if (!current) return prev;
      const target = resolveInsertion(prev, activeId, overId);
      if (!target || target.groupId === current.groupId) return prev;
      const next = placeTask(prev, activeId, overId);
      if (!next) return prev;
      // 顺序未变则不触发重渲染
      const unchanged = next.length === prev.length && next.every((t, i) => t.id === prev[i].id);
      return unchanged ? prev : next;
    });
  };

  const handleDragCancel = () => {
    clearExpandTimer();
    setActiveDragId(null);
    setDraftTasks(null); // 丢弃草稿即完整回滚到拖动前状态
  };

  // 统一拖拽结束：草稿已定精确落点——同组 reorderTasks；跨组 updateTask 移组 + 目标组完整序列 reorderTasks
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    clearExpandTimer();
    setActiveDragId(null);
    const draft = draftTasks;
    const state = useStore.getState();
    const activeId = String(active.id);
    const original = state.tasks.find((t) => t.id === activeId);
    if (!over || !draft || !original) {
      setDraftTasks(null);
      return;
    }
    // 在草稿上落定最终位置（arrayMove 语义，与拖动中的让位预览严格一致，保证落点=预览点）
    const overId = String(over.id);
    let final = draft;
    if (overId.startsWith('group:') || overId.startsWith('group-header:')) {
      // 组容器 → 组末尾；组标题 → 组首
      final = placeTask(draft, activeId, overId) ?? draft;
    } else if (overId !== activeId) {
      const overTask = draft.find((t) => t.id === overId);
      if (overTask) {
        // 极少数情况（最后一次 onDragOver 未触发）先保证 active 已在目标组
        const staged =
          draft.find((t) => t.id === activeId)?.groupId === overTask.groupId
            ? draft
            : (placeTask(draft, activeId, overId) ?? draft);
        // 落点 = over 在组内的索引（含 active 的序列上做 arrayMove，同 sortable 预览）
        const members = staged.filter((t) => t.groupId === overTask.groupId);
        const from = members.findIndex((t) => t.id === activeId);
        const to = members.findIndex((t) => t.id === overId);
        if (from !== -1 && to !== -1 && from !== to) {
          const reordered = arrayMove(members, from, to);
          const queue = [...reordered];
          final = staged.map((t) => (t.groupId === overTask.groupId ? queue.shift()! : t));
        } else {
          final = staged;
        }
      }
    }
    setDraftTasks(null);

    const movedTask = final.find((t) => t.id === activeId)!;
    const groupChanged = movedTask.groupId !== original.groupId;
    const idsOf = (list: TaskItem[], groupId: string) =>
      list.filter((t) => t.groupId === groupId).map((t) => t.id).join(',');
    const orderChanged = idsOf(final, movedTask.groupId) !== idsOf(state.tasks, movedTask.groupId);
    // 无实际变化（拖回原位）：不写 store 也不请求后端
    if (!groupChanged && !orderChanged) return;

    // 归一化目标组 order 字段后乐观更新（避免松手回弹闪烁；后端返回后再校正）
    final.filter((t) => t.groupId === movedTask.groupId).forEach((t, idx) => {
      t.order = idx;
    });
    useStore.getState().setTasks(final);

    void (async () => {
      if (groupChanged) {
        // 跨组：先移组（后端搬移 session 文件），再把目标组完整序列写入精确位置
        const moved = await updateTask(activeId, { groupId: movedTask.groupId });
        if (!moved) {
          await reload(); // 持久化失败：全量刷新校正
          return;
        }
      }
      const targetIds = final.filter((t) => t.groupId === movedTask.groupId).map((t) => t.id);
      const reordered = await reorderTasks(targetIds);
      if (!reordered) await reload(); // 持久化失败：全量刷新校正
    })();
  };

  const navItems: {
    icon: typeof MessageCirclePlus;
    labelKey: string;
    page: string;
    action?: 'new-task';
  }[] = [
    { icon: MessageCirclePlus, labelKey: 'sidebar.newTask', page: 'home', action: 'new-task' },
    { icon: Blocks, labelKey: 'sidebar.pluginLibrary', page: 'plugins' },
    { icon: AlarmClock, labelKey: 'sidebar.automation', page: 'automation' },
  ];

  const settingsSearchResults = settingsSearch.trim()
    ? settingsSearchIndex
        .map((item) => {
          const navItem = settingsNavItems.find((n) => n.id === item.section);
          return {
            ...item,
            label: t(item.labelKey),
            description: item.descriptionKey ? t(item.descriptionKey) : '',
            sectionLabel: navItem ? t(navItem.labelKey) : '',
            SectionIcon: navItem?.Icon,
          };
        })
        .filter((item) => {
          const q = settingsSearch.toLowerCase();
          return (
            item.label.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q) ||
            item.sectionLabel.toLowerCase().includes(q)
          );
        })
    : null;

  return (
    <>
    <UISidebar collapsible="icon">
      {/* Header: 品牌 + 折叠按钮 */}
      <SidebarHeader>
        {isSettingsRoute ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={t('settings.backToApp')}
                onClick={() => { closeMobile(); navigate('/task'); }}
              >
                <ArrowLeft className="size-4" />
                <span>{t('settings.backToApp')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : (
          <div className="flex items-center justify-between gap-2 px-1 py-1">
            <div className="flex min-w-0 items-center gap-2 group-data-[collapsible=icon]:hidden">
              <img src="/MOSS.png" alt="MOSS" className="size-6 shrink-0 rounded-md" />
              <span className="truncate text-sm font-semibold">MOSS</span>
            </div>
            <SidebarTrigger className="shrink-0 group-data-[collapsible=icon]:mx-auto" />
          </div>
        )}
      </SidebarHeader>

      {/* 导航 */}
      <SidebarContent className="overflow-hidden">
        {isSettingsRoute ? (
          <SidebarGroup className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-2 pb-1 group-data-[collapsible=icon]:hidden">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder={t('settings.searchPlaceholder')}
                  value={settingsSearch}
                  onChange={(e) => setSettingsSearch(e.target.value)}
                  className="h-8 pl-8 text-sm"
                />
              </div>
            </div>
            <SidebarGroupContent className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
              <SidebarMenu>
                {settingsSearchResults ? (
                  settingsSearchResults.length > 0 ? (
                    settingsSearchResults.map((result) => (
                      <SidebarMenuItem key={`${result.section}-${result.labelKey}`}>
                        <button
                          className="flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm hover:bg-sidebar-accent-hover hover:text-sidebar-accent-foreground h-8"
                          onClick={() => {
                            closeMobile();
                            navigate(`/settings/${result.section}`);
                            setSettingsSearch('');
                          }}
                        >
                          {result.SectionIcon && <result.SectionIcon className="size-4 shrink-0" />}
                          <span className="flex-1 truncate">{result.label}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{result.sectionLabel}</span>
                        </button>
                      </SidebarMenuItem>
                    ))
                  ) : (
                    <li className="px-2 py-4 text-center text-xs text-muted-foreground">
                      {t('settings.noResults')}
                    </li>
                  )
                ) : (
                  settingsNavItems.map((item) => {
                    // 前缀匹配（带尾斜杠）：子路由（如 /settings/context/rules、/settings/provider/search）下仍高亮
                    const isActive =
                      pathname === `/settings/${item.id}` ||
                      pathname.startsWith(`/settings/${item.id}/`);
                    const label = t(item.labelKey);
                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={isActive}
                          tooltip={label}
                          onClick={() => { closeMobile(); navigate(`/settings/${item.id}`); }}
                        >
                          <item.Icon className="size-4" />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
          <>
        <SidebarGroup className="shrink-0">
          <SidebarMenu>
            {navItems.map((item) => {
              const Icon = item.icon;
              const label = t(item.labelKey);
              const isActive =
                (item.action === 'new-task' && pathname === '/') ||
                (`/${item.page}` === pathname && !item.action);
              return (
                <SidebarMenuItem key={item.labelKey}>
                  <SidebarMenuButton
                    isActive={isActive}
                    tooltip={label}
                    onClick={() => {
                      closeMobile();
                      if (item.action === 'new-task') {
                        useStore.getState().setActiveTaskId(null);
                        useStore.getState().setActiveSession(null);
                        navigate('/task');
                      } else {
                        navigate(`/${item.page}`);
                      }
                    }}
                  >
                    <Icon className="size-4" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {/* 任务列表（折叠时隐藏） */}
        <SidebarGroup className="flex min-h-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
          <div className="shrink-0 flex items-center justify-between px-2 pb-1">
            <SidebarGroupLabel className="h-auto p-0">{t('sidebar.taskList')}</SidebarGroupLabel>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                title={t('sidebar.newGroup')}
                onClick={() => setNewGroupOpen(true)}
              >
                <FolderPlus />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title={t('sidebar.manage')}
                onClick={() => { setManageMode((v) => !v); setSelectedIds(new Set()); }}
                className={cn(manageMode && 'bg-muted text-foreground')}
              >
                <ListChecks />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title={t('common.search')}
                onClick={() => onOpenOverlay('search')}
              >
                <Search />
              </Button>
            </div>
          </div>
          <SidebarGroupContent className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
            {manageMode && (
              <div className="flex items-center gap-1 px-2 pb-1">
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={toggleSelectAll}>
                  <CheckCheck className="size-3.5" />
                  {allSelected ? t('sidebar.deselectAll') : t('sidebar.selectAll')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                  disabled={selectedIds.size === 0}
                  onClick={() => setBatchDeleteOpen(true)}
                >
                  <Trash2 className="size-3.5" />
                  {t('sidebar.deleteSelected')}
                </Button>
                <div className="ml-auto flex items-center gap-1">
                  {selectedIds.size > 0 && (
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                      {selectedIds.size}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={t('sidebar.exitManage')}
                    onClick={() => { setManageMode(false); setSelectedIds(new Set()); }}
                  >
                    <X />
                  </Button>
                </div>
              </div>
            )}
            <SidebarMenu>
              {/* 单一顶层 DndContext：任务可跨组拖拽（同组精确排序 / 异组精确插入悬停位置）；
                  measuring Always 保证跨容器拖动时目标组测量准确、让位动画平滑 */}
              <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
              {taskGroups
                // 默认分组为空时隐藏整个条目（常驻分组，持有任务才显示）；
                // 拖动期间以草稿 displayTasks 为渲染源（跨组实时预览）
                .filter((group) => group.id !== 'default' || displayTasks.some((task) => task.groupId === 'default'))
                .map((group) => {
                const groupTasks = displayTasks.filter((task) => task.groupId === group.id);
                const groupTaskIds = groupTasks.map((t) => t.id);
                const expanded = groupExpanded[group.id] ?? true;
                const GroupIcon = expanded ? FolderOpen : Folder;
                // 默认分组为常驻分组：文案固定且随语言本地化
                const groupLabel = group.id === 'default' ? t('sidebar.defaultGroup') : group.name;
                return (
                  <Collapsible
                    key={group.id}
                    open={expanded}
                    onOpenChange={() => toggleGroup(group.id)}
                    className="anim-list animate-in fade-in duration-150"
                  >
                    <SidebarMenuItem>
                      {/* 组标题 droppable：拖拽悬停折叠组标题可延时自动展开 */}
                      <GroupHeaderDrop groupId={group.id}>
                      <div className="group/group-item relative">
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton>
                            <GroupIcon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate pr-6">{groupLabel}</span>
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        {group.id !== 'default' && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="absolute right-0 top-1/2 z-10 size-6 -translate-y-1/2 opacity-0 transition-opacity group-hover/group-item:opacity-100 data-[state=open]:opacity-100"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <MoreHorizontal className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" side="bottom" sideOffset={4} collisionPadding={8}>
                              <DropdownMenuItem
                                onSelect={() => { setRenameGroupName(group.name); setRenameGroup(group); }}
                              >
                                <Pencil className="size-3.5" />
                                {t('sidebar.renameGroup')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => { setDeleteGroupAlsoTasks(false); setDeleteGroupId(group.id); }}
                              >
                                <Trash2 className="size-3.5" />
                                {t('sidebar.deleteGroup')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                      </GroupHeaderDrop>
                      <CollapsibleContent>
                        {/* 组级 droppable：拖入组内任意位置（含空白/空组）即移入该组 */}
                        <GroupDropZone groupId={group.id} empty={groupTasks.length === 0}>
                          <SidebarMenuSub className="mr-0 pr-0">
                            <SortableContext items={groupTaskIds} strategy={verticalListSortingStrategy}>
                              {groupTasks.map((task) => (
                                <TaskRow
                                  key={task.id}
                                  task={task}
                                  manageMode={manageMode}
                                  isSelected={selectedIds.has(task.id)}
                                  onToggleSelect={toggleSelect}
                                  onNavigate={handleTaskNavigate}
                                  onRename={handleTaskRename}
                                  onDelete={handleTaskDelete}
                                />
                              ))}
                            </SortableContext>
                          </SidebarMenuSub>
                        </GroupDropZone>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              })}
              {/* 浮起卡片：跟随指针，松手后回落动画归位 */}
              <DragOverlay dropAnimation={dropAnimation}>
                {activeDragTask ? <TaskDragCard task={activeDragTask} /> : null}
              </DragOverlay>
              </DndContext>
              {/* 滚动加载哨兵：任务超过首页 100 条（hasMore）时，滚到底部附近自动追加下一页。
                  IntersectionObserver 不依赖具体滚动容器（shadcn 内层），rootMargin 提前触发 */}
              {hasMore && (
                <ListLoadMoreSentinel onVisible={() => void loadMore()} loading={loadingMore} />
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
          </>
        )}
      </SidebarContent>

      {/* Footer: 资源管理器 + 用户菜单（设置）同组；样式与设置入口对齐；设置模式下隐藏 */}
      {!isSettingsRoute && (
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                className="gap-2"
                tooltip={t('sidebar.resourceManager')}
                isActive={pathname === '/system-monitor'}
                onClick={() => {
                  closeMobile();
                  navigate('/system-monitor');
                }}
              >
                <Activity className="size-4" />
                <div className="flex min-w-0 flex-col gap-0 leading-none group-data-[collapsible=icon]:hidden">
                  <span className="truncate text-sm font-medium">{t('sidebar.resourceManager')}</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <UserMenu />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
    </UISidebar>

    {/* 新建分组弹窗 */}
    <Dialog open={newGroupOpen} onOpenChange={setNewGroupOpen}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('sidebar.newGroup')}</DialogTitle>
          <DialogDescription>{t('sidebar.newGroupDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreateGroup();
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setNewGroupOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleCreateGroup()} disabled={!newGroupName.trim()}>
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* 重命名分组弹窗 */}
    <Dialog open={!!renameGroup} onOpenChange={(o) => !o && setRenameGroup(null)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('sidebar.renameGroup')}</DialogTitle>
          <DialogDescription>{t('sidebar.renameGroupDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            autoFocus
            value={renameGroupName}
            onChange={(e) => setRenameGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRenameGroup();
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRenameGroup(null)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleRenameGroup()} disabled={!renameGroupName.trim()}>
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* 删除分组确认弹窗：可选连组内任务一并删除，或迁回默认分组 */}
    <AlertDialog
      open={!!deleteGroupId}
      onOpenChange={(o) => {
        if (!o) setDeleteGroupId(null);
      }}
    >
      <AlertDialogContent size="md">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <CircleAlert className="size-5 shrink-0 translate-y-0.5 text-destructive" />
            <div className="flex flex-col gap-1">
              <AlertDialogTitle>{t('sidebar.deleteGroup')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('sidebar.deleteGroupDesc')}{' '}
                {deleteGroupAlsoTasks ? t('sidebar.deleteGroupPurgeDesc') : t('sidebar.deleteGroupMoveDesc')}
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogBody>
          <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm select-none">
            <Checkbox
              checked={deleteGroupAlsoTasks}
              onCheckedChange={(v) => setDeleteGroupAlsoTasks(v === true)}
            />
            {t('sidebar.deleteGroupAlsoDeleteTasks')}
          </label>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleDeleteGroup();
            }}
            className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
          >
            {t('sidebar.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* 重命名弹窗 */}
    <Dialog open={!!renameTask} onOpenChange={(o) => !o && setRenameTask(null)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('sidebar.renameTask')}</DialogTitle>
          <DialogDescription>{t('sidebar.renameTaskDesc')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRename();
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRenameTask(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void handleRename()}
            disabled={!renameTitle.trim()}
          >
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* 删除确认弹窗 */}
    <ConfirmDialog
      open={!!deleteTaskId}
      onOpenChange={(o) => !o && setDeleteTaskId(null)}
      title={t('sidebar.deleteTask')}
      description={t('sidebar.deleteTaskDesc')}
      variant="danger"
      confirmText={t('sidebar.delete')}
      cancelText={t('common.cancel')}
      onConfirm={async () => {
        if (deleteTaskId) {
          const activeBefore = useStore.getState().activeTaskId;
          await deleteTask(deleteTaskId);
          goHomeIfTaskGone(activeBefore);
        }
        setDeleteTaskId(null);
      }}
    />

    {/* 批量删除确认弹窗 */}
    <ConfirmDialog
      open={batchDeleteOpen}
      onOpenChange={(o) => !o && setBatchDeleteOpen(false)}
      title={t('sidebar.batchDeleteTask')}
      description={t('sidebar.batchDeleteTaskDesc', { count: selectedIds.size })}
      variant="danger"
      confirmText={t('sidebar.delete')}
      cancelText={t('common.cancel')}
      onConfirm={handleBatchDelete}
    />
    </>
  );
}

interface TaskRowProps {
  task: TaskItem;
  manageMode: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onNavigate: (id: string) => void;
  onRename: (task: TaskItem) => void;
  onDelete: (id: string) => void;
}

/** 任务行（memo：props 不变即跳过重渲——流式期间 store 高频更新时列表保持静止） */
const TaskRow = memo(function TaskRow({
  task,
  manageMode,
  isSelected,
  onToggleSelect,
  onNavigate,
  onRename,
  onDelete,
}: TaskRowProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  // 仅管理模式可拖拽（disabled 时 listeners 不激活，普通模式彻底不可拖）；
  // data.groupId 供碰撞检测在让位缝隙中按组吸附最近任务
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !manageMode,
    data: { groupId: task.groupId },
  });
  // 状态指示器：运行中（转圈）/ 出错（红警示），空闲不显示；WS 事件流驱动
  const sid = task.sessionId ?? task.id;
  const generating = useStore((s) => s.generatingBySession[sid] ?? false);
  const errored = useStore((s) => s.errorBySession[sid] ?? false);
  // 仅垂直拖拽：剥离 x 分量（列表语义，跨组也是纵向移入）
  const restrictedTransform = transform ? { ...transform, x: 0 } : null;
  // 被拖行原位作占位（半透明 + 虚线框），DragOverlay 浮起卡片跟随指针
  const style: CSSProperties = {
    transform: CSS.Transform.toString(restrictedTransform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };

  if (manageMode) {
    return (
      <li
        ref={setNodeRef}
        style={style}
        className={cn(
          'group/menu-item relative group/item flex w-full min-w-0 items-center gap-1.5',
          isDragging && 'rounded-md outline-2 outline-dashed outline-primary-strong/40',
        )}
      >
        <button
          type="button"
          onClick={() => onToggleSelect(task.id)}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
            isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
          )}
        >
          {isSelected && <Check className="size-3" />}
        </button>
        <button
          type="button"
          onClick={() => onToggleSelect(task.id)}
          className="flex h-8 min-w-0 flex-1 items-center overflow-hidden rounded-md px-2 text-left text-sm hover:bg-sidebar-accent-hover hover:text-sidebar-accent-foreground"
        >
          <span className="truncate">{task.title}</span>
        </button>
        <button
          type="button"
          aria-label={t('sidebar.dragHandle')}
          className="flex size-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
      </li>
    );
  }

  return (
    <li ref={setNodeRef} style={style} className="group/menu-item relative group/item">
      <SidebarMenuButton
        isActive={pathname === `/task/${task.id}`}
        onClick={() => onNavigate(task.id)}
      >
        <span className="truncate pr-5">{task.title}</span>
      </SidebarMenuButton>
      {/* 普通模式不提供拖拽手柄：仅管理模式（列表管理按钮）下可拖拽排序/移组 */}
      {/* 状态指示器：运行中/出错时常显，hover 时被菜单按钮覆盖；标题 pr-5 为其预留空间 */}
      <span
        className="pointer-events-none absolute right-0.25 top-1/2 z-[5] flex size-4 -translate-y-1/2 items-center justify-center"
        aria-label={generating ? t('sidebar.statusRunning') : errored ? t('sidebar.statusError') : undefined}
      >
        {generating ? (
          <Loader2 className="size-3.5 animate-spin text-primary-strong" />
        ) : errored ? (
          <CircleAlert className="size-3.5 text-destructive" />
        ) : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              'absolute top-1/2 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover/item:opacity-100 data-[state=open]:opacity-100',
              // 运行中/出错：状态指示器常显占右侧 1~17px，三点左移至 right-5（20px）避免叠在圆圈上；
              // 空闲：指示器不显示，三点贴边仅内收 2px（right-0.5，rem 自适应字号）
              generating || errored ? 'right-5' : 'right-0.5',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" sideOffset={4} collisionPadding={8}>
          <DropdownMenuItem onSelect={() => onRename(task)}>
            <Pencil className="size-3.5" />
            {t('sidebar.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(task.id)}>
            <Trash2 className="size-3.5" />
            {t('sidebar.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
});

/**
 * 组级 droppable 容器：把分组任务列表区域注册为 drop 目标（id = `group:<groupId>`），
 * 拖入组内任意位置（任务上/空白处/空组）均触发移组；悬停时高亮提示可放置。
 */
function GroupDropZone({ groupId, empty, children }: { groupId: string; empty: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${groupId}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-md -mx-1 px-1 transition-colors',
        // 空组给最小放置高度，保证拖拽可命中
        empty && 'min-h-8',
        isOver && 'bg-primary-strong/10',
      )}
    >
      {children}
    </div>
  );
}

/** 组标题 droppable：拖拽悬停折叠组标题时配合短延时自动展开；悬停展开组标题等价于移到组首 */
function GroupHeaderDrop({ groupId, children }: { groupId: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group-header:${groupId}` });
  return (
    <div ref={setNodeRef} className={cn('rounded-md transition-colors', isOver && 'bg-primary-strong/10')}>
      {children}
    </div>
  );
}

/**
 * 滚动加载哨兵：进入视口（列表滚到底部附近）即触发追加下一页。
 * IntersectionObserver 不依赖具体滚动容器（滚动发生在 shadcn Sidebar 内层）；
 * rootMargin 提前 300px 触发，滚动到底前页面已在加载。
 */
function ListLoadMoreSentinel({ onVisible, loading }: { onVisible: () => void; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loading) onVisible();
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible, loading]);
  return (
    <div ref={ref} className="flex items-center justify-center py-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
    </div>
  );
}

/** DragOverlay 浮起卡片：与普通任务行样式一致（无拖拽图标），加阴影反馈；宽度对齐侧边栏行宽 */
function TaskDragCard({ task }: { task: TaskItem }) {
  return (
    <div className="flex h-8 w-[calc(var(--sidebar-width,16rem)_-_4rem)] cursor-grabbing items-center rounded-md border border-border bg-sidebar-accent px-2 text-sm shadow-lg">
      <span className="truncate">{task.title}</span>
    </div>
  );
}
