// UI/src/hooks/useTasks.ts
// 任务 hook：分组全量 + 分组任务按需加载（组内分页）；WS 广播实时同步（后端 task.created/updated/deleted/changed/reordered）。
// 加载模型：
//   首载 → GET /api/task-groups 拿全量分组（标题 / taskCount），再按需拉「展开中」的分组任务；
//   展开某分组 → ensureGroupLoaded（组内第 1 页）；组内底部哨兵 → loadMoreGroup（组内续载）；
//   全量快照（WS tasks.changed / tasks.reordered、PUT reorder 响应、无参 GET /api/tasks）→ applyFullTaskSnapshot。
// 重连后的兜底刷新由 useWebSocket 负责（restored 时全量快照）。

import { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { api } from '../api/http';
import { withRetry } from '../lib/retry';
import type { TaskItem } from '../types/api';

/** 分组内每页条数（组内分页；典型分组远小于此值，一页即加载完） */
const TASKS_PAGE_SIZE = 100;

export function useTasks() {
  const setTaskGroups = useStore((s) => s.setTaskGroups);
  const resetGroupTasks = useStore((s) => s.resetGroupTasks);
  const patchGroupTasksMeta = useStore((s) => s.patchGroupTasksMeta);
  const setGroupTasks = useStore((s) => s.setGroupTasks);
  const applyFullTaskSnapshot = useStore((s) => s.applyFullTaskSnapshot);

  /** 加载某分组第 1 页（已加载或加载中则跳过） */
  const ensureGroupLoaded = useCallback(
    async (groupId: string): Promise<void> => {
      const meta = useStore.getState().groupTasksMeta[groupId];
      if (meta?.loaded || meta?.loading) return;
      patchGroupTasksMeta(groupId, { loading: true });
      try {
        const { tasks, page } = await api.listTasksInGroup(groupId, { limit: TASKS_PAGE_SIZE });
        setGroupTasks(
          groupId,
          tasks,
          {
            loaded: true,
            loading: false,
            hasMore: page?.hasMore ?? false,
            total: page?.total ?? tasks.length,
          },
          'replace',
        );
      } catch (err) {
        console.warn('ensureGroupLoaded failed:', err);
        // 保留未加载态，下次展开/重载可重试
        patchGroupTasksMeta(groupId, { loading: false });
      }
    },
    [patchGroupTasksMeta, setGroupTasks],
  );

  /** 续载某分组下一页（组内分页；offset = 该组已物化任务数） */
  const loadMoreGroup = useCallback(
    async (groupId: string): Promise<void> => {
      const st = useStore.getState();
      const meta = st.groupTasksMeta[groupId];
      if (!meta || meta.loading || !meta.hasMore) return;
      patchGroupTasksMeta(groupId, { loading: true });
      const offset = st.tasks.filter((t) => t.groupId === groupId).length;
      try {
        const { tasks, page } = await api.listTasksInGroup(groupId, {
          limit: TASKS_PAGE_SIZE,
          offset,
        });
        setGroupTasks(
          groupId,
          tasks,
          {
            loaded: true,
            loading: false,
            hasMore: page?.hasMore ?? false,
            total: page?.total ?? offset + tasks.length,
          },
          'append',
        );
      } catch (err) {
        console.warn('loadMoreGroup failed:', err);
        patchGroupTasksMeta(groupId, { loading: false });
      }
    },
    [patchGroupTasksMeta, setGroupTasks],
  );

  /**
   * 把每个分组补全到「无更多」（进入管理模式 / 拖拽前调用）。
   * 拖拽排序依赖「分组内完整有序 id 序列」，只加载部分会写坏 order。
   */
  const ensureAllGroupsLoaded = useCallback(async (): Promise<void> => {
    const groups = useStore.getState().taskGroups;
    await Promise.all(
      groups.map(async (g) => {
        await ensureGroupLoaded(g.id);
        while (useStore.getState().groupTasksMeta[g.id]?.hasMore) {
          await loadMoreGroup(g.id);
        }
      }),
    );
  }, [ensureGroupLoaded, loadMoreGroup]);

  const load = useCallback(async () => {
    // 首载：分组全量 + 展开中的分组任务按需预载。
    // withRetry：后端内核启动窗口内 agent 引擎未就绪会返回 503，退避重试后无需刷新即可自愈。
    try {
      const { groups } = await withRetry(() => api.listTaskGroups());
      setTaskGroups(groups);
      resetGroupTasks();
      const expanded = useStore.getState().taskGroupExpanded;
      void Promise.all(
        groups
          .filter((g) => (expanded[g.id] ?? true) && (g.taskCount ?? 0) > 0)
          .map((g) => ensureGroupLoaded(g.id)),
      );
      return;
    } catch {
      // 后端 tasks 路由未就绪，降级到 session 适配
    }

    // 降级：api.listSessions() 适配为 TaskItem[]（attempts 取小值：到达此处多为路由缺失而非瞬时故障）
    try {
      const { sessions } = await withRetry(() => api.listSessions(), { attempts: 2 });
      const tasks: TaskItem[] = sessions.map((s) => ({
        id: s.id,
        title: `任务 ${s.id.slice(-6)}`,
        groupId: 'default',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        sessionId: s.id,
      }));
      // 默认分组
      setTaskGroups([{ id: 'default', name: '默认', expanded: true }]);
      applyFullTaskSnapshot(tasks);
    } catch (err) {
      // 后端未启动，静默
      console.warn('useTasks load failed:', err);
    }
  }, [setTaskGroups, resetGroupTasks, ensureGroupLoaded, applyFullTaskSnapshot]);

  useEffect(() => {
    void load();
  }, [load]);

  const createTask = useCallback(
    async (title: string, groupId?: string) => {
      try {
        const task = await api.createTask(title, groupId);
        useStore.getState().addTask(task);
        return task;
      } catch (err) {
        console.warn('createTask failed:', err);
        return null;
      }
    },
    [],
  );

  const updateTask = useCallback(async (id: string, patch: { title?: string; groupId?: string }) => {
    try {
      const sourceGroupId = useStore.getState().tasks.find((t) => t.id === id)?.groupId;
      const task = await api.updateTask(id, patch);
      useStore.getState().updateTask(id, task);
      // 移组后源组可能作为空文件夹分组被后端销毁：后端已广播最新分组列表，
      // 广播不可用（WS 未连接）时才兜底重拉
      if (patch.groupId !== undefined && sourceGroupId && sourceGroupId !== task.groupId) {
        if (useStore.getState().wsStatus !== 'open') await load();
      }
      return task;
    } catch (err) {
      console.warn('updateTask failed:', err);
      return null;
    }
  }, [load]);

  const deleteTask = useCallback(async (id: string) => {
    try {
      await api.deleteTask(id);
      useStore.getState().removeTask(id);
      // 后端已广播 task.deleted + task-groups.changed（含空分组自动销毁）→ 无需重拉；
      // 仅在广播不可用（WS 未连接）时兜底刷新，避免列表与后端漂移
      if (useStore.getState().wsStatus !== 'open') await load();
    } catch (err) {
      console.warn('deleteTask failed:', err);
    }
  }, [load]);

  const reorderTasks = useCallback(async (taskIds: string[]) => {
    try {
      // 响应为「全量可见任务」→ 走全量快照（物化全部 + 全部组标记已加载）
      const { tasks } = await api.reorderTasks(taskIds);
      useStore.getState().applyFullTaskSnapshot(tasks);
      return tasks;
    } catch (err) {
      console.warn('reorderTasks failed:', err);
      return null;
    }
  }, []);

  const createTaskGroup = useCallback(async (name: string) => {
    try {
      const group = await api.createTaskGroup(name);
      useStore.getState().addTaskGroup(group);
      return group;
    } catch (err) {
      console.warn('createTaskGroup failed:', err);
      return null;
    }
  }, []);

  const updateTaskGroup = useCallback(async (id: string, patch: { name?: string }) => {
    try {
      const group = await api.updateTaskGroup(id, patch);
      if (group) {
        useStore.getState().updateTaskGroup(id, group);
      }
      return group;
    } catch (err) {
      console.warn('updateTaskGroup failed:', err);
      return null;
    }
  }, []);

  const deleteTaskGroup = useCallback(async (id: string, moveTasksTo?: string, deleteTasks?: boolean) => {
    try {
      await api.deleteTaskGroup(id, moveTasksTo, deleteTasks);
      useStore.getState().removeTaskGroup(id);
      // 组内任务可能被迁移/批量删除：后端已广播完整任务+分组快照；WS 不可用时兜底重拉
      if (useStore.getState().wsStatus !== 'open') await load();
    } catch (err) {
      console.warn('deleteTaskGroup failed:', err);
    }
  }, [load]);

  return {
    tasks: useStore((s) => s.tasks),
    taskGroups: useStore((s) => s.taskGroups),
    activeTaskId: useStore((s) => s.activeTaskId),
    /** 各分组任务加载态（按需加载 + 组内分页） */
    groupTasksMeta: useStore((s) => s.groupTasksMeta),
    reload: load,
    /** 加载某分组第 1 页（展开时按需调用，幂等） */
    ensureGroupLoaded,
    /** 续载某分组下一页（组内哨兵触发） */
    loadMoreGroup,
    /** 补全所有分组到「无更多」（进入管理模式 / 拖拽前调用） */
    ensureAllGroupsLoaded,
    createTask,
    updateTask,
    deleteTask,
    reorderTasks,
    createTaskGroup,
    updateTaskGroup,
    deleteTaskGroup,
  };
}
