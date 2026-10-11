// src/modules/agent/task-store.ts
// 任务持久化存储（v4 体系）：
//   ~/.moss/task.json                            总管：分组定义 + task↔session 索引（调度入口）
//   ~/.moss/tasks/<groupId>/task.json            组内任务元信息（TaskItem[]）
//   ~/.moss/tasks/<groupId>/<sessionId>.json     组内各任务的消息历史（由 SessionStore 写入）
// TaskItem.id 即 sessionId（简化模型，1 task ↔ 1 session）
// 旧版单文件 tasks.json + sessions/ 目录在启动时一次性迁移并删除（可重入/幂等）。

import { t } from '../../core/i18n';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { readJsonStore, writeJsonStore } from '../filesys/store-io';
import type { Environment, Logger } from '../../core/types';

export interface TaskItem {
  id: string;
  title: string;
  groupId: string;
  createdAt: string;
  updatedAt: string;
  active?: boolean;
  /** 关联的 sessionId（task.id 即 sessionId） */
  sessionId?: string;
  /** 分组内排序权重（小→前）；缺失视为最后，回退 createdAt 倒序 */
  order?: number;
}

export interface TaskGroup {
  id: string;
  name: string;
  expanded?: boolean;
  taskCount?: number;
  /** 分组来源：folder = 按工作目录自动创建（空时自动销毁）；manual = 手动新建（允许空状态）。旧数据无该字段视为 manual */
  source?: 'folder' | 'manual';
  /** 相对存储目录（tasks/ 下），缺省 = safeGroupId(id)。用于 agenteam 的 agenteam/<teamId> 嵌套布局 */
  dir?: string;
  /** 隐藏分组：其会话不出现在侧边栏列表（subagent / agenteam 衍生会话），但可经面板/卡片进入 */
  hidden?: boolean;
}

/** 总管 task.json 结构 */
interface TaskRootStore {
  /** 数据版本：4 = 分散存储体系（总管 + 按组目录） */
  version?: number;
  groups: TaskGroup[];
  /** taskId → { groupId, sessionId }（调度索引：不读组文件即可解析归属） */
  index: Record<string, { groupId: string; sessionId: string }>;
}

/** 旧版单文件结构（仅迁移时读取） */
interface LegacyTaskStore {
  version?: number;
  groups: TaskGroup[];
  tasks: TaskItem[];
}

const DEFAULT_GROUP_ID = 'default';
const DEFAULT_GROUP_NAME = '默认任务';
/** 组内任务元信息文件名（与根总管 task.json 同名，不同层级） */
const GROUP_TASKS_FILE = 'task.json';

/** 组目录名清洗：UUID 与 'default' 均满足；防 `../` 等路径穿越 */
function safeGroupId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * 相对目录清洗：按 `/`（或 `\`）分段清洗，每段仅保留 [a-zA-Z0-9_-]，
 * 丢弃空段（含 `.`/`..`），防路径穿越。用于嵌套分组目录（如 `agenteam/<teamId>`）。
 */
function safeRelDir(dir: string): string {
  return dir
    .split(/[\\/]+/)
    .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter((s) => s.length > 0)
    .join('/');
}

export class TaskStore {
  /** 总管：~/.moss/task.json */
  private readonly rootPath: string;
  /** 旧版单文件：~/.moss/tasks.json（迁移源，迁移后删除） */
  private readonly legacyPath: string;
  /** 任务根目录：~/.moss/tasks */
  private readonly tasksDir: string;
  /** 旧版会话目录：~/.moss/sessions（迁移源，迁移后删除） */
  private readonly legacySessionsDir: string;
  private readonly logger: Logger;
  private groups!: TaskGroup[];
  private index!: Record<string, { groupId: string; sessionId: string }>;
  /** groupId → 该组任务列表 */
  private readonly tasksByGroup = new Map<string, TaskItem[]>();

  constructor(env: Environment, logger: Logger) {
    this.rootPath = join(env.dataDir, 'task.json');
    this.legacyPath = join(env.dataDir, 'tasks.json');
    this.tasksDir = join(env.dataDir, 'tasks');
    this.legacySessionsDir = join(env.dataDir, 'sessions');
    this.logger = logger;
    this.migrateFromLegacy();
    this.load();
  }

  // ==========================================================================
  // 任务 CRUD
  // ==========================================================================

  listTasks(): TaskItem[] {
    return this.allTasks()
      .map(tk => ({ ...tk }))
      .sort((a, b) => {
        const oa = a.order ?? Number.MAX_SAFE_INTEGER;
        const ob = b.order ?? Number.MAX_SAFE_INTEGER;
        if (oa !== ob) return oa - ob;
        // order 相同（含均缺失）时回退 createdAt 倒序
        return b.createdAt.localeCompare(a.createdAt);
      });
  }

  getTask(id: string): TaskItem | null {
    const task = this.findTask(id);
    return task ? { ...task } : null;
  }

  /**
   * 查询 taskId 的存储相对目录（供 SessionStore 解析 session 文件路径）。
   * 普通组 = 组目录名；嵌套组（如 agenteam/<teamId>）= group.dir。未知返回 null。
   */
  getDirOf(taskId: string): string | null {
    const gid = this.index[taskId]?.groupId;
    if (!gid) return null;
    return this.dirOf(gid);
  }

  /** 分组相对存储目录：group.dir（清洗）优先，否则 safeGroupId(id) */
  private dirOf(groupId: string): string {
    const g = this.groups.find((x) => x.id === groupId);
    const cleaned = g?.dir ? safeRelDir(g.dir) : '';
    if (cleaned) return cleaned;
    return safeGroupId(groupId) || DEFAULT_GROUP_ID;
  }

  createTask(title: string, groupId?: string, id?: string): TaskItem {
    const now = new Date().toISOString();
    // 前端可预分配会话 id（乐观导航：点发送即刻进入任务页，task.id 即 sessionId）。
    // 传入且未被占用则沿用；缺失或与已有任务冲突时回退新 UUID（绝不覆盖已有任务）。
    const taskId = id && !this.findTask(id) ? id : crypto.randomUUID();
    const gid = this.validGroupId(groupId) ?? DEFAULT_GROUP_ID;
    const groupTasks = this.tasksByGroup.get(gid) ?? [];
    // 新任务置于分组顶部：取分组内现有最小 order - 1（无任务时 0）
    const nextOrder = groupTasks.length
      ? Math.min(...groupTasks.map(tk => tk.order ?? Number.MAX_SAFE_INTEGER)) - 1
      : 0;
    const task: TaskItem = {
      id: taskId,
      title: title || '新任务',
      groupId: gid,
      createdAt: now,
      updatedAt: now,
      sessionId: taskId, // task.id 即 sessionId
      order: nextOrder,
    };
    groupTasks.push(task);
    this.tasksByGroup.set(gid, groupTasks);
    this.index[taskId] = { groupId: gid, sessionId: taskId };
    this.saveGroupTasks(gid);
    this.saveRoot();
    this.logger.debug(t('agent.taskCreated', { id: taskId }), { title, groupId: gid });
    return { ...task };
  }

  updateTask(id: string, patch: { title?: string; groupId?: string }): TaskItem | null {
    const task = this.findTask(id);
    if (!task) return null;
    const oldGid = task.groupId;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.groupId !== undefined && this.validGroupId(patch.groupId) && patch.groupId !== oldGid) {
      // 移动分组：从旧组移除、加入新组，并同步搬移磁盘上的 session 文件。
      // 搬移失败（源文件存在但 renameSync 异常）时回滚内存状态，保证索引与文件不错位
      const newGid = patch.groupId;
      const oldOrder = task.order;
      const oldList = this.tasksByGroup.get(oldGid) ?? [];
      this.tasksByGroup.set(oldGid, oldList.filter(tk => tk.id !== id));
      task.groupId = newGid;
      // 移入置顶：order = 新组内最小 order - 1（空组为 0），与 createTask/touchTask 语义一致
      const newGroupOrders = (this.tasksByGroup.get(newGid) ?? [])
        .map(tk => tk.order ?? Number.MAX_SAFE_INTEGER);
      task.order = newGroupOrders.length ? Math.min(...newGroupOrders) - 1 : 0;
      const newList = this.tasksByGroup.get(newGid) ?? [];
      newList.push(task);
      this.tasksByGroup.set(newGid, newList);
      const moveResult = this.moveSessionFile(id, oldGid, newGid);
      if (moveResult === 'failed') {
        // 回滚：任务留在原组（title 更新保留），索引/组列表/顺序恢复
        this.tasksByGroup.set(newGid, (this.tasksByGroup.get(newGid) ?? []).filter(tk => tk.id !== id));
        task.groupId = oldGid;
        task.order = oldOrder;
        const rollbackList = this.tasksByGroup.get(oldGid) ?? [];
        rollbackList.push(task);
        this.tasksByGroup.set(oldGid, rollbackList);
        this.index[id] = { groupId: oldGid, sessionId: task.sessionId ?? id };
        this.logger.warn(t('agent.taskStoreCleanupFailed'), { taskId: id, reason: 'move rolled back' });
      } else {
        // moved / absent（新会话未落盘）均视为成功：absent 时文件由后续 saveSession 按新索引写
        this.index[id] = { groupId: newGid, sessionId: task.sessionId ?? id };
      }
      this.saveGroupTasks(oldGid);
      this.saveGroupTasks(newGid);
      this.saveRoot();
      // 移出后源组若为空文件夹分组则自动销毁
      this.pruneEmptyFolderGroups();
    } else {
      this.saveGroupTasks(oldGid);
    }
    task.updatedAt = new Date().toISOString();
    this.saveGroupTasks(task.groupId);
    return { ...task };
  }

  /**
   * 任务活跃置顶：更新 updatedAt；若非组内最前，将 order 改为组内（除自身）最小 order - 1。
   * task.id 即 sessionId，engine 在每次用户消息时调用。任务不存在返回 null。
   */
  touchTask(id: string): TaskItem | null {
    const task = this.findTask(id);
    if (!task) return null;
    task.updatedAt = new Date().toISOString();
    const groupTasks = this.tasksByGroup.get(task.groupId) ?? [];
    const minOther = groupTasks
      .filter(tk => tk.id !== id)
      .reduce((min, tk) => Math.min(min, tk.order ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    if (task.order === undefined || task.order >= minOther) {
      task.order = minOther - 1;
    }
    this.saveGroupTasks(task.groupId);
    return { ...task };
  }

  deleteTask(id: string): boolean {
    const task = this.findTask(id);
    if (!task) return false;
    const gid = task.groupId;
    this.tasksByGroup.set(gid, (this.tasksByGroup.get(gid) ?? []).filter(tk => tk.id !== id));
    delete this.index[id];
    this.saveGroupTasks(gid);
    this.saveRoot();
    // 删除后源组若为空文件夹分组则自动销毁
    this.pruneEmptyFolderGroups();
    return true;
  }

  /**
   * 按给定 id 顺序重写对应任务的 order（0,1,2...）。
   * 通常入参为某分组内的全部任务 id，重排后组内顺序即入参顺序。
   * 任一 id 不存在则整体失败、不写入。返回是否全部命中。
   */
  reorderTasks(taskIds: string[]): boolean {
    const idToTask = new Map(this.allTasks().map(tk => [tk.id, tk]));
    for (const id of taskIds) {
      if (!idToTask.has(id)) return false;
    }
    // 拖拽只改顺序，不污染 updatedAt（updatedAt 语义 = 最近活跃，由 touchTask 维护）
    const dirtyGroups = new Set<string>();
    taskIds.forEach((id, idx) => {
      const task = idToTask.get(id)!;
      task.order = idx;
      dirtyGroups.add(task.groupId);
    });
    for (const gid of dirtyGroups) this.saveGroupTasks(gid);
    return true;
  }

  /** 按标题搜索任务（大小写不敏感子串匹配） */
  searchTasks(query: string): TaskItem[] {
    const q = query.toLowerCase();
    return this.allTasks()
      .filter(tk => tk.title.toLowerCase().includes(q))
      .map(tk => ({ ...tk }));
  }

  // ==========================================================================
  // 分组 CRUD
  // ==========================================================================

  listGroups(): TaskGroup[] {
    // 附带 taskCount
    return this.groups.map(g => ({
      ...g,
      taskCount: (this.tasksByGroup.get(g.id) ?? []).length,
    }));
  }

  createGroup(
    name: string,
    source?: 'folder' | 'manual',
    opts?: { id?: string; dir?: string; hidden?: boolean },
  ): TaskGroup {
    const id = opts?.id ?? crypto.randomUUID();
    const group: TaskGroup = {
      id,
      name: name || '新分组',
      expanded: true,
      ...(source ? { source } : {}),
      ...(opts?.dir ? { dir: opts.dir } : {}),
      ...(opts?.hidden ? { hidden: true } : {}),
    };
    this.groups.push(group);
    this.tasksByGroup.set(id, []);
    this.saveRoot();
    return { ...group, taskCount: 0 };
  }

  updateGroup(id: string, patch: { name?: string }): TaskGroup | null {
    const group = this.groups.find(g => g.id === id);
    if (!group) return null;
    if (patch.name !== undefined) group.name = patch.name;
    this.saveRoot();
    return { ...group, taskCount: (this.tasksByGroup.get(id) ?? []).length };
  }

  deleteGroup(id: string, opts?: { moveTasksTo?: string; deleteTasks?: boolean }): boolean {
    // 不允许删除默认分组
    if (id === DEFAULT_GROUP_ID) return false;
    const idx = this.groups.findIndex(g => g.id === id);
    if (idx === -1) return false;
    // 目录需在分组定义被移除前解析（dirOf 依赖 groups）；删除后 dirOf 会回退为 safeGroupId(id)
    const dir = this.dirOf(id);

    // 连任务一起删：清索引与组列表，整组目录（task.json + session 文件）一并物理删除。
    // session 文件已由 engine 层先于本方法逐个删除（依赖 index 定位），此处 rmSync 兜底清理残留
    if (opts?.deleteTasks) {
      for (const task of this.tasksByGroup.get(id) ?? []) {
        delete this.index[task.id];
      }
      this.tasksByGroup.delete(id);
      this.groups.splice(idx, 1);
      this.saveRoot();
      try {
        rmSync(join(this.tasksDir, dir), { recursive: true, force: true });
      } catch (err) {
        this.logger.warn(t('agent.taskStoreCleanupFailed'), {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.pruneEmptyParentDirs(dir);
      return true;
    }

    // 迁移任务到目标分组或默认分组（组文件 + session 文件一并搬移）
    const targetGroup = this.validGroupId(opts?.moveTasksTo) ? opts!.moveTasksTo! : DEFAULT_GROUP_ID;
    const moving = this.tasksByGroup.get(id) ?? [];
    const targetList = this.tasksByGroup.get(targetGroup) ?? [];
    const now = new Date().toISOString();
    let failedMoves = 0;
    for (const task of moving) {
      task.groupId = targetGroup;
      task.updatedAt = now;
      targetList.push(task);
      this.index[task.id] = { groupId: targetGroup, sessionId: task.sessionId ?? task.id };
      // 搬移失败保留索引原指向（回退本任务的组归属，与磁盘物理位置保持一致）
      const moveResult = this.moveSessionFile(task.id, id, targetGroup);
      if (moveResult === 'failed') {
        failedMoves++;
        task.groupId = id;
        this.index[task.id] = { groupId: id, sessionId: task.sessionId ?? task.id };
      }
    }
    // 搬移失败的任务回退后仍留在原组列表（不随组删除）
    const failedTasks = targetList.filter(tk => tk.groupId === id);
    this.tasksByGroup.set(targetGroup, targetList.filter(tk => tk.groupId !== id));
    this.tasksByGroup.set(id, failedTasks);
    if (this.tasksByGroup.get(id)!.length === 0) {
      this.tasksByGroup.delete(id);
    }
    this.groups.splice(idx, 1);
    this.saveGroupTasks(targetGroup);
    if (failedMoves === 0) this.saveGroupTasks(id);
    this.saveRoot();
    // 仅在全部 session 文件搬移成功时清理旧组目录；失败时保留（防物理删除未搬走的
    // session JSON），残留文件由 SessionStore.loadAll 错位自愈在下次启动归位
    if (failedMoves === 0) {
      try {
        rmSync(join(this.tasksDir, dir), { recursive: true, force: true });
      } catch (err) {
        this.logger.warn(t('agent.taskStoreCleanupFailed'), {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.pruneEmptyParentDirs(dir);
    } else {
      this.logger.warn(t('agent.taskStoreCleanupFailed'), {
        dir: id,
        reason: `${failedMoves} session files failed to move; directory kept`,
      });
    }
    return true;
  }

  /**
   * 销毁空的自动分组：source='folder'（按工作目录自动创建）或 hidden=true
   * （subagent / agenteam 衍生分组，须"跑过才建"、无任务即消失）且无任务。
   * 任务移出/删除后即时调用；load 时兜底清理「创建后从未有任务」的残留空组。
   * 普通手动分组（manual / 旧数据无 source）与默认分组不在清理范围。
   */
  private pruneEmptyFolderGroups(): void {
    const doomed = this.groups.filter(
      g =>
        (g.source === 'folder' || g.hidden === true) &&
        (this.tasksByGroup.get(g.id) ?? []).length === 0,
    );
    if (doomed.length === 0) return;
    // 目录须在分组定义移除前解析（dirOf 依赖 groups）
    const doomedDirs = doomed.map(g => ({ id: g.id, dir: this.dirOf(g.id) }));
    this.groups = this.groups.filter(g => !doomed.find(d => d.id === g.id));
    for (const { id, dir } of doomedDirs) {
      this.tasksByGroup.delete(id);
      try {
        rmSync(join(this.tasksDir, dir), { recursive: true, force: true });
      } catch (err) {
        this.logger.warn(t('agent.taskStoreCleanupFailed'), {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.pruneEmptyParentDirs(dir);
    }
    this.saveRoot();
  }

  /**
   * 删除嵌套分组目录（如 `agenteam/<teamId>`）后，自内向外尝试移除变为空的父目录
   * （如 `agenteam`）；非空/被占用即停止向上。空目录用 rmdirSync（规避 Bun on Windows
   * 的 rmSync(recursive:false) EFAULT 先例）。
   */
  private pruneEmptyParentDirs(dir: string): void {
    const segs = dir.split('/');
    for (let i = segs.length - 1; i >= 1; i--) {
      const parent = segs.slice(0, i).join('/');
      try {
        rmdirSync(join(this.tasksDir, parent));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
          this.logger.warn(t('agent.taskStoreCleanupFailed'), {
            dir: parent,
            error: code ?? String(err),
          });
        }
        return; // 父目录非空/不存在：停止向上
      }
    }
  }

  // ==========================================================================
  // 旧数据迁移（一次性、可重入/幂等）
  // ==========================================================================

  /**
   * 旧版（v3 及更早）：~/.moss/tasks.json（groups+tasks 单文件）+ ~/.moss/sessions/<sid>.json。
   * 迁移顺序：写各组 task.json → 写总管 task.json → 搬 sessions → 删 tasks.json → 删 sessions/。
   * 任一步中断后重启可续跑：组文件/总管重写幂等；session 目标已存在则删源；
   * sessions/ 目录仅在清空后删除；tasks.json 最后删除。
   */
  private migrateFromLegacy(): void {
    try {
      if (existsSync(this.legacyPath) && !existsSync(this.rootPath)) {
        const legacy = readJsonStore<Partial<LegacyTaskStore>>(
          this.legacyPath,
          {} as Partial<LegacyTaskStore>,
          this.logger,
        );
        if (Array.isArray(legacy.groups) && Array.isArray(legacy.tasks)) {
          const groups = [...legacy.groups];
          if (!groups.find(g => g.id === DEFAULT_GROUP_ID)) {
            groups.unshift({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, expanded: true });
          }
          const byGroup = new Map<string, TaskItem[]>();
          for (const task of legacy.tasks) {
            const gid = groups.find(g => g.id === task.groupId) ? task.groupId : DEFAULT_GROUP_ID;
            const list = byGroup.get(gid) ?? [];
            list.push({ ...task, groupId: gid });
            byGroup.set(gid, list);
          }
          for (const [gid, tasks] of byGroup) {
            writeJsonStore(join(this.tasksDir, safeGroupId(gid), GROUP_TASKS_FILE), tasks);
          }
          const index: TaskRootStore['index'] = {};
          for (const [gid, tasks] of byGroup) {
            for (const task of tasks) {
              index[task.id] = { groupId: gid, sessionId: task.sessionId ?? task.id };
            }
          }
          const root: TaskRootStore = { version: 4, groups, index };
          writeJsonStore(this.rootPath, root);
          this.logger.info(t('agent.taskStoreMigrated', { count: legacy.tasks.length }));
        }
      }
      this.migrateLegacySessions();
      // sessions/ 已清理但 tasks.json 仍残留（异常中断）：数据已在总管+组文件，直接删除
      if (existsSync(this.legacyPath) && !existsSync(this.legacySessionsDir)) {
        unlinkSync(this.legacyPath);
      }
    } catch (err) {
      // 迁移失败不阻断启动：下次启动重试（幂等）
      this.logger.warn(t('agent.taskStoreMigrationFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 搬移旧 sessions/<sid>.json → tasks/<groupId>/<sid>.json；全部完成后删除旧目录 */
  private migrateLegacySessions(): void {
    if (!existsSync(this.legacySessionsDir)) return;
    // 迁移需总管 index 就绪；总管缺失时无法定组，留待下次启动（migrateFromLegacy 前半段已写）
    if (!existsSync(this.rootPath)) return;
    const root = readJsonStore<Partial<TaskRootStore>>(this.rootPath, {} as Partial<TaskRootStore>, this.logger);
    const index = root.index ?? {};
    const entries = readdirSync(this.legacySessionsDir);
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const sid = name.slice(0, -'.json'.length);
      const gid = safeGroupId(index[sid]?.groupId ?? DEFAULT_GROUP_ID);
      const src = join(this.legacySessionsDir, name);
      const destDir = join(this.tasksDir, gid);
      const dest = join(destDir, name);
      try {
        if (existsSync(dest)) {
          // 上次迁移中断残留：目标已在位，删源即完成
          unlinkSync(src);
        } else {
          mkdirSync(destDir, { recursive: true });
          renameSync(src, dest);
        }
      } catch (err) {
        this.logger.warn(t('agent.taskStoreMigrationFailed'), {
          file: name,
          error: err instanceof Error ? err.message : String(err),
        });
        return; // 有失败即中止本轮，保留旧目录下次续迁
      }
    }
    // 全部搬空：删除旧目录与旧 tasks.json
    // 注意：Bun on Windows 的 rmSync(recursive:false, force:true) 触发 EFAULT bug，空目录删除用 rmdirSync
    try {
      rmdirSync(this.legacySessionsDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(t('agent.taskStoreCleanupFailed'), {
          dir: this.legacySessionsDir,
          error: code ?? String(err),
        });
      }
      return; // 目录非空或被占用：保留，下次续跑
    }
    if (existsSync(this.legacyPath)) unlinkSync(this.legacyPath);
  }

  // ==========================================================================
  // 持久化
  // ==========================================================================

  /** 加载总管 + 扫描各组 task.json，以文件为真相源自愈索引 */
  private load(): void {
    const root = readJsonStore<Partial<TaskRootStore>>(this.rootPath, {} as Partial<TaskRootStore>, this.logger);
    this.groups = Array.isArray(root.groups) ? [...root.groups] : [];
    if (!this.groups.find(g => g.id === DEFAULT_GROUP_ID)) {
      this.groups.unshift({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, expanded: true });
    }
    this.index = root.index && typeof root.index === 'object' ? { ...root.index } : {};
    this.tasksByGroup.clear();

    // 扫描分组目录中的 task.json（以磁盘目录为准，单文件损坏自动 .corrupt 留档跳过）：
    //   一级 tasks/<d1>/task.json（普通组）
    //   二级 tasks/<d1>/<d2>/task.json（嵌套组，如 agenteam/<teamId>）
    if (existsSync(this.tasksDir)) {
      for (const entry of readdirSync(this.tasksDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const d1 = safeGroupId(entry.name);
        if (!d1) continue;
        this.loadGroupDir(d1);
        for (const sub of readdirSync(join(this.tasksDir, entry.name), { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const d2 = safeGroupId(sub.name);
          if (!d2) continue;
          this.loadGroupDir(`${d1}/${d2}`);
        }
      }
    }
    // 确保每个分组都有任务列表
    for (const g of this.groups) {
      if (!this.tasksByGroup.has(g.id)) this.tasksByGroup.set(g.id, []);
    }

    // 自愈索引：文件为准补缺、删悬空；有变化回写
    let dirty = false;
    for (const [gid, tasks] of this.tasksByGroup) {
      for (const tk of tasks) {
        if (!this.index[tk.id]) {
          this.index[tk.id] = { groupId: gid, sessionId: tk.sessionId ?? tk.id };
          dirty = true;
        } else if (this.index[tk.id].groupId !== gid) {
          this.index[tk.id] = { groupId: gid, sessionId: tk.sessionId ?? tk.id };
          dirty = true;
        }
      }
    }
    for (const id of Object.keys(this.index)) {
      if (!this.findTask(id)) {
        delete this.index[id];
        dirty = true;
      }
    }
    if (dirty) this.saveRoot();
    // 启动兜底：清理「创建后从未有任务」的残留空文件夹分组
    this.pruneEmptyFolderGroups();
  }

  /**
   * 读取某相对目录（tasks/<relDir>）下的组任务文件。
   * 无 task.json 视为非分组目录（如 agenteam 父目录）：跳过且不补占位分组。
   */
  private loadGroupDir(relDir: string): void {
    const file = join(this.tasksDir, relDir, GROUP_TASKS_FILE);
    if (!existsSync(file)) return;
    const tasks = readJsonStore<TaskItem[]>(file, [] as TaskItem[], this.logger)
      .filter(tk => typeof tk?.id === 'string');
    const group = this.groupByDir(relDir);
    // 目录即归属：修正任务 groupId 与目录不一致的脏数据
    for (const tk of tasks) tk.groupId = group.id;
    this.tasksByGroup.set(group.id, tasks);
  }

  /**
   * 按相对目录定位分组定义；缺失则补占位分组（保留 dir，保证路径可复现）。
   * 磁盘目录无对应分组定义（分组定义被手删）时避免任务不可见。
   */
  private groupByDir(relDir: string): TaskGroup {
    const found = this.groups.find(g => this.dirOf(g.id) === relDir);
    if (found) return found;
    const placeholder: TaskGroup = {
      id: safeGroupId(relDir) || relDir,
      name: relDir,
      expanded: true,
      dir: relDir,
    };
    this.groups.push(placeholder);
    return placeholder;
  }

  /** 写总管 task.json（分组定义 + task↔session 索引） */
  private saveRoot(): void {
    try {
      const root: TaskRootStore = { version: 4, groups: this.groups, index: this.index };
      writeJsonStore(this.rootPath, root);
    } catch (err) {
      this.logger.error(t('agent.saveTasksFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 写组文件 tasks/<dir>/task.json（dir 由分组定义解析，支持嵌套目录） */
  private saveGroupTasks(groupId: string): void {
    try {
      writeJsonStore(
        join(this.tasksDir, this.dirOf(groupId), GROUP_TASKS_FILE),
        this.tasksByGroup.get(groupId) ?? [],
      );
    } catch (err) {
      this.logger.error(t('agent.saveTasksFailed'), {
        groupId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 搬移磁盘 session 文件 tasks/<fromDir>/<sid>.json → tasks/<toDir>/<sid>.json。
   *  返回三态：'moved' 成功搬移 / 'absent' 源不存在（新会话未落盘，非失败） / 'failed' 搬移异常 */
  private moveSessionFile(sessionId: string, fromGid: string, toGid: string): 'moved' | 'absent' | 'failed' {
    try {
      const sid = sessionId;
      const src = join(this.tasksDir, this.dirOf(fromGid), `${sid}.json`);
      if (!existsSync(src)) return 'absent';
      const destDir = join(this.tasksDir, this.dirOf(toGid));
      mkdirSync(destDir, { recursive: true });
      renameSync(src, join(destDir, `${sid}.json`));
      return 'moved';
    } catch (err) {
      this.logger.warn(t('agent.taskStoreCleanupFailed'), {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  }

  // ==========================================================================
  // 内部工具
  // ==========================================================================

  private allTasks(): TaskItem[] {
    const out: TaskItem[] = [];
    for (const list of this.tasksByGroup.values()) out.push(...list);
    return out;
  }

  private findTask(id: string): TaskItem | null {
    const gid = this.index[id]?.groupId;
    if (gid) {
      const task = (this.tasksByGroup.get(gid) ?? []).find(tk => tk.id === id);
      if (task) return task;
    }
    // 索引缺失兜底：线性查找（load 自愈后罕见）
    for (const list of this.tasksByGroup.values()) {
      const task = list.find(tk => tk.id === id);
      if (task) return task;
    }
    return null;
  }

  /** groupId 合法性：必须在分组定义中存在（防路径穿越与孤儿任务） */
  private validGroupId(groupId: string | undefined): string | null {
    if (!groupId) return null;
    return this.groups.find(g => g.id === groupId) ? groupId : null;
  }
}
