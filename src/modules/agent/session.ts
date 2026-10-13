// src/modules/agent/session.ts
// 会话状态与历史存储（上下文视图构建/裁剪/配对修复已迁入 context 引擎）。
// 持久化：每个 session 存为 ~/.moss/tasks/<dir>/<sessionId>.json（相对目录由
// TaskStore 总管索引解析，engine 注入 resolveSessionDir；支持 subagent、agenteam/<teamId>
// 等嵌套目录），启动时全量加载到内存。

import { t } from '../../core/i18n';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { safeSessionId, writeJsonStore } from '../filesys/store-io';
import type { AgentMessage, RunStats } from '../contracts';
import type { TodoItem } from '../tools/todo/shared/store';
import type { PermissionMode } from '../safety/types';
import type { Environment, Logger } from '../../core/types';
import type { CompactionRecord, EnvContextInfo, SessionContextTelemetry, SessionMemoryState, SessionRulesState } from '../context/types';

/** 上下文文件轨迹（与前端 ContextFile 对齐） */
export interface ContextFile {
  path: string;
  tokens?: number;
  reason?: 'read' | 'edit' | 'write' | 'grep' | 'glob' | 'delete' | 'move' | 'copy';
  /** 运行时存在性标记（engine 出口校验磁盘后附加；不持久化，前端据此显示灰色删除线） */
  missing?: boolean;
}

export interface ActiveSkill {
  /** skill 名称（内容运行时从 skill 注册表按 name 解析，不持久化全文） */
  name: string;
  /**
   * 注入位置：
   *   - system：内容拼接在系统提示词后（首次激活）
   *   - message：内容作为 skill-inject system 消息锚定在切换消息后（切换激活）
   */
  mode: 'system' | 'message';
}

/** 旧格式 session 记录（含已废弃的全量提示词字段），仅用于加载时的类型窄化与主动清理检测 */
interface LegacySessionRecord {
  systemPrompt?: string;
  activeSkill?: { name?: string; mode?: 'system' | 'message'; content?: string };
  /** 旧单槽撤回窗口（现用 lastTruncations 栈，加载时自动包装） */
  lastTruncation?: TruncationInfo;
}

export interface Session {
  id: string;
  /** 任务历史（不含系统提示词，仅 user/assistant/tool；skill-inject 的 system 消息只存单行占位标题，全文运行时从注册表解析） */
  messages: AgentMessage[];
  /** 创建时间 */
  createdAt: string;
  /** 最后活跃时间 */
  updatedAt: string;
  /** 累计 token 用量（估算） */
  totalTokens: number;
  /** 上下文文件轨迹（read/edit/write/grep/glob 工具累积），随 session 持久化 */
  contextFiles: ContextFile[];
  /** 最近一次 run 的工作目录（相对路径的存在性校验与归一化匹配基准；旧记录无此字段时回退 process.cwd()） */
  lastCwd?: string;
  /** 当前激活的 skill 模式（会话级持久；/ 菜单触发） */
  activeSkill?: ActiveSkill;
  /** 会话级权限模式（ask/auto/skip；前端 PermissionModeSelector 切换，随 run 持久化，刷新恢复） */
  permissionMode?: PermissionMode;
  /** 环境上下文锚定信息（context 引擎：会话首条 env-context 消息的生成时间/日期快照） */
  envContext?: EnvContextInfo;
  /** 压缩历史（context 引擎：每次压缩的记录，含摘要全文；前端压缩卡片数据源） */
  compactions?: CompactionRecord[];
  /** 持久化上下文遥测（context 引擎：真实 usage + 命中样本；重启恢复侧边栏/指标栏数据） */
  contextTelemetry?: SessionContextTelemetry;
  /** 规则引擎注入状态（paths 规则去重水位；随 session 落盘） */
  rulesState?: SessionRulesState;
  /** 记忆引擎状态（L1 注入标记 / 召回去重 / 蒸馏水位；随 session 落盘） */
  memoryState?: SessionMemoryState;
  /** 最近一次 run 的运行统计（run 级口径：每次发送消息重置；中控台指标栏刷新恢复用） */
  lastRunStats?: RunStats;
  /** 消息撤回（截断）恢复窗口栈（尾部为最近窗口；支持连续撤回后按栈序逐层恢复） */
  lastTruncations?: TruncationInfo[];
  /**
   * 会话级消息序号（单调递增；每 turn 消耗一个，用于生成 `<sessionId>#<msgSeq>`）。
   * 刻意独立于 messages.length：压缩折叠 / 撤回恢复 / healDanglingToolCalls 都会中部
   * splice 使 length 回落，用它派生 id 会与历史已落盘的 id 相撞（前端错位替换的根因）。
   * 首次访问时由 nextMsgSeq 按历史最大 # 后缀惰性初始化。
   */
  msgSeq?: number;
}

/** 消息撤回（截断）恢复窗口：栈式存储，支持连续撤回多条消息后逐层恢复 */
export interface TruncationInfo {
  /** 截断起点时间戳（目标用户消息的 timestamp；恢复时仅清除该时刻之后的软删除） */
  truncatedBeforeTimestamp: string;
  /** 文件回滚产生的 rollback entry id 列表（file-history redo 备份） */
  rollbackEntryIds: string[];
}

/**
 * 相对目录清洗：按 `/`（或 `\`）分段清洗，每段仅保留 [a-zA-Z0-9_-]，
 * 丢弃空段（含 `.`/`..`），防路径穿越。与 TaskStore.safeRelDir 语义一致。
 */
function safeRelDir(dir: string): string {
  return dir
    .split(/[\\/]+/)
    .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter((s) => s.length > 0)
    .join('/');
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly logger: Logger;
  /** session 持久化根目录：~/.moss/tasks（session 文件按分组相对目录存于 tasks/<dir>/） */
  private readonly tasksDir: string;
  /** sessionId → 存储相对目录解析器（TaskStore 总管索引；未注入/未知返回 null → 兜底扫描/默认组） */
  private readonly resolveSessionDir: (sessionId: string) => string | null;

  // ========================================================================
  // 写盘降载（面向小时级长程任务）：消息级写入只标脏，防抖批量刷盘。
  // 原实现每条消息全量重写 session 文件 + fsync，长任务下写盘量 O(M²) 平方级增长；
  // 现改为 2s 防抖 + 10 条消息硬上限，崩溃窗口内丢失的尾部消息由
  // loadFromDisk 的悬挂 tool_calls 自愈兜底（防 provider 400）。
  // ========================================================================
  /** 脏 session 集：sessionId → { session, 脏期间新增消息数 } */
  private readonly dirtySessions = new Map<string, { session: Session; msgCount: number }>();
  /** 防抖刷盘定时器 */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** dispose 后不再走防抖（直接写盘） */
  private disposed = false;
  /** 防抖刷盘延迟（ms） */
  private static readonly FLUSH_DELAY_MS = 2000;
  /** 脏期间新增消息数硬上限（超限立即刷，限制崩溃丢失窗口） */
  private static readonly FLUSH_MSG_THRESHOLD = 10;

  constructor(
    env: Environment,
    logger: Logger,
    opts?: { resolveSessionDir?: (sessionId: string) => string | null },
  ) {
    this.logger = logger;
    this.tasksDir = join(env.dataDir, 'tasks');
    this.resolveSessionDir = opts?.resolveSessionDir ?? (() => null);
    this.loadAll();
  }

  /** 启动时全量加载所有 session 文件到内存（损坏文件跳过，目录不存在则跳过）。
   *  同时自愈存量错位文件：物理目录 ≠ 索引组时按索引搬移归位（历史 bug 修复后一次性迁移） */
  private loadAll(): void {
    try {
      if (!existsSync(this.tasksDir)) return;
      for (const entry of readdirSync(this.tasksDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const d1 = entry.name;
        const d1Abs = join(this.tasksDir, d1);
        // 一级：tasks/<d1>/*.json（组内 task.json 是任务元信息，其余 .json 文件名即 sessionId）
        for (const name of readdirSync(d1Abs)) {
          if (!name.endsWith('.json') || name === 'task.json') continue;
          this.loadOneSession(name, d1, `${d1}/${name}`);
        }
        // 二级：tasks/<d1>/<d2>/*.json（嵌套分组，如 agenteam/<teamId>）
        for (const sub of readdirSync(d1Abs, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const relDir = `${d1}/${sub.name}`;
          for (const name of readdirSync(join(d1Abs, sub.name))) {
            if (!name.endsWith('.json') || name === 'task.json') continue;
            this.loadOneSession(name, relDir, `${relDir}/${name}`);
          }
        }
      }
      this.logger.debug(t('agent.loadedSessions', { count: this.sessions.size }));
    } catch (err) {
      this.logger.warn(t('agent.scanSessionsDirFailed'), {
        dir: this.tasksDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 加载单个 session 文件：先错位自愈，再读入内存（失败仅告警） */
  private loadOneSession(fileName: string, physicalDir: string, displayPath: string): void {
    const sessionId = fileName.slice(0, -'.json'.length);
    this.healMisplacedFile(sessionId, physicalDir, fileName);
    if (!this.loadFromDisk(sessionId)) {
      this.logger.warn(t('agent.loadSessionFailed'), { file: displayPath });
    }
  }

  /** 错位文件搬移：物理目录 ≠ 索引目录且索引有效时，把文件搬到索引目录。失败仅告警不阻断启动 */
  private healMisplacedFile(sessionId: string, physicalDir: string, fileName: string): void {
    const indexedDir = this.resolveSessionDir(sessionId);
    if (!indexedDir) return; // 索引缺失（任务已删/孤儿文件）：保持原位
    const destDir = safeRelDir(indexedDir) || 'default';
    if (destDir === physicalDir) return;
    const src = join(this.tasksDir, physicalDir, fileName);
    const dest = join(this.tasksDir, destDir, fileName);
    try {
      if (existsSync(dest)) {
        this.logger.warn(t('agent.loadSessionFailed'), {
          file: `${physicalDir}/${fileName}`,
          reason: `dest exists: ${destDir}/${fileName}`,
        });
        return;
      }
      mkdirSync(join(this.tasksDir, destDir), { recursive: true });
      renameSync(src, dest);
      this.logger.info(t('agent.taskStoreMigrated', { count: 1 }), {
        sessionId,
        from: physicalDir,
        to: destDir,
      });
    } catch (err) {
      // 搬移失败保留原位：sessionFilePath 的磁盘扫描兜底仍可正确加载
      this.logger.warn(t('agent.taskStoreCleanupFailed'), {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 把单个 session 立即持久化到磁盘（store-io 统一原子写：tmp+fsync+rename+EXDEV 回退）。
   * 关键路径专用：run 结束 / 撤回 / 压缩持久化 / 启动迁移 / dispose 后写入 */
  private saveSessionNow(session: Session): void {
    try {
      writeJsonStore(this.sessionFilePath(session.id), session);
    } catch (err) {
      this.logger.error(t('agent.saveSessionFailed'), {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 防抖标脏：消息级写入（user/assistant/tool/contextFiles 等）只标记待写，
   * 由定时器（2s）或消息计数硬上限（10 条）统一刷盘 */
  private markDirty(session: Session): void {
    if (this.disposed) {
      this.saveSessionNow(session);
      return;
    }
    const cur = this.dirtySessions.get(session.id);
    if (cur) {
      cur.msgCount++;
      if (cur.msgCount >= SessionStore.FLUSH_MSG_THRESHOLD) {
        this.dirtySessions.delete(session.id);
        this.saveSessionNow(session);
        return;
      }
    } else {
      this.dirtySessions.set(session.id, { session, msgCount: 1 });
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushAllDirty();
      }, SessionStore.FLUSH_DELAY_MS);
    }
  }

  /** 批量刷盘：遍历所有脏 session 立即写盘（saveSessionNow 内部捕获错误） */
  private flushAllDirty(): void {
    if (this.dirtySessions.size === 0) return;
    for (const [id, entry] of Array.from(this.dirtySessions.entries())) {
      this.dirtySessions.delete(id);
      this.saveSessionNow(entry.session);
    }
  }

  /** 释放资源（engine.destroy 调用链）：停定时器并强制刷盘全部脏 session */
  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAllDirty();
  }

  /**
   * session 文件路径：tasks/<dir>/<sessionId>.json（dir 为分组相对存储目录，支持嵌套）。
   * 解析顺序：索引目录 → 若该目录已有文件则原地读写；否则磁盘扫描定位既有文件
   * （存量错位文件自愈：索引与物理位置不一致时按物理位置读写，下次 saveSession 归位）；
   * 磁盘无既有文件的新 session 直接落索引目录（避免错落 default/，保证 subagent/agenteam
   * 落盘到各自目录）。索引缺失时回退磁盘扫描 / 默认组。sessionId 经 safeSessionId 清洗防路径穿越。
   */
  private sessionFilePath(sessionId: string): string {
    const sid = safeSessionId(sessionId);
    const indexedDir = this.resolveSessionDir(sessionId);
    if (indexedDir) {
      const rel = safeRelDir(indexedDir) || 'default';
      const indexed = join(this.tasksDir, rel, `${sid}.json`);
      if (existsSync(indexed)) return indexed;
      const onDisk = this.findDirOnDisk(sid);
      return join(this.tasksDir, onDisk ?? rel, `${sid}.json`);
    }
    const diskDir = this.findDirOnDisk(sid);
    return join(this.tasksDir, diskDir ?? 'default', `${sid}.json`);
  }

  /** 兜底扫描：在分组目录（一级 / 二级嵌套）定位 <sid>.json 既有文件，返回相对目录名；未找到返回 null */
  private findDirOnDisk(sid: string): string | null {
    try {
      if (!existsSync(this.tasksDir)) return null;
      for (const entry of readdirSync(this.tasksDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const d1Abs = join(this.tasksDir, entry.name);
        if (existsSync(join(d1Abs, `${sid}.json`))) return entry.name;
        for (const sub of readdirSync(d1Abs, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          if (existsSync(join(d1Abs, sub.name, `${sid}.json`))) {
            return `${entry.name}/${sub.name}`;
          }
        }
      }
    } catch {
      // 扫描失败交由调用方回退默认组
    }
    return null;
  }

  /**
   * 从磁盘加载单个 session（启动 loadAll 与运行时冗余加载共用）。
   * 主动清理：检测到旧格式冗余（systemPrompt 字段 / activeSkill 固化全文 / skill-inject 全文消息）
   * 时先瘦身再立即原子重写文件，磁盘即时去除全量提示词。
   */
  private loadFromDisk(sessionId: string): Session | null {
    try {
      const filePath = this.sessionFilePath(sessionId);
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Session> & LegacySessionRecord;
      if (typeof parsed.id === 'string' && Array.isArray(parsed.messages)) {
        const legacySkill = parsed.activeSkill;
        const hasLegacySkillContent = typeof legacySkill?.content === 'string';
        // skill-inject 全文消息特征：含 `\n\n`（占位格式只有单行标题）
        const hasFullSkillInject = parsed.messages.some(
          m => m.role === 'system' && m.name === 'skill-inject' && m.content.includes('\n\n'),
        );
        const dirty =
          parsed.systemPrompt !== undefined || hasLegacySkillContent || hasFullSkillInject;
        // 瘦身：全文 → 单行占位标题 + metadata.skillName（全文运行时从注册表解析）
        if (hasFullSkillInject) {
          for (const m of parsed.messages) {
            if (m.role === 'system' && m.name === 'skill-inject' && m.content.includes('\n\n')) {
              const fallbackName = /^# Active Skill: (.+)$/.exec(m.content)?.[1];
              const skillName = legacySkill?.name ?? fallbackName ?? 'unknown';
              m.content = `# Active Skill: ${skillName}`;
              m.metadata = { ...(m.metadata ?? {}), skillName };
            }
          }
        }
        const session: Session = {
          id: parsed.id,
          messages: parsed.messages,
          createdAt: parsed.createdAt ?? new Date().toISOString(),
          updatedAt: parsed.updatedAt ?? new Date().toISOString(),
          totalTokens: parsed.totalTokens ?? 0,
          contextFiles: Array.isArray(parsed.contextFiles) ? parsed.contextFiles : [],
          ...(legacySkill?.name && legacySkill.mode
            ? { activeSkill: { name: legacySkill.name, mode: legacySkill.mode } }
            : {}),
          ...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
          ...(parsed.envContext ? { envContext: parsed.envContext } : {}),
          ...(Array.isArray(parsed.compactions) ? { compactions: parsed.compactions } : {}),
          ...(parsed.lastRunStats ? { lastRunStats: parsed.lastRunStats } : {}),
          ...(Array.isArray(parsed.lastTruncations)
            ? { lastTruncations: parsed.lastTruncations }
            : parsed.lastTruncation
              // 旧单对象格式兼容：包装为单元素数组（栈）
              ? { lastTruncations: [parsed.lastTruncation] }
              : {}),
          ...(typeof parsed.msgSeq === 'number' && Number.isFinite(parsed.msgSeq)
            ? { msgSeq: parsed.msgSeq }
            : {}),
        };
        // 崩溃自愈：防抖落盘窗口内进程崩溃可能丢尾部 tool 结果——补错误结果
        // 恢复 tool_use/tool_result 配对（否则 session 复用时 provider 报 HTTP 400）
        const healedCount = healDanglingToolCalls(session.messages);
        if (healedCount > 0) {
          this.logger.warn(t('agent.healedDanglingToolCalls', { count: healedCount }), { sessionId });
        }
        this.sessions.set(session.id, session);
        if (dirty || healedCount > 0) {
          // 重写瘦身：旧 systemPrompt 等废弃字段不再写入，自然消失；自愈结果同步落盘
          this.saveSessionNow(session);
        }
        return session;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 获取或创建会话（系统提示词不持久化，每次 run 由 engine 实时构建并拼接进发送视图） */
  getOrCreate(sessionId: string): Session {
    let session: Session | null = this.sessions.get(sessionId) ?? null;
    if (!session) {
      // 冗余保护：尝试从磁盘加载
      session = this.loadFromDisk(sessionId);
    }
    if (!session) {
      session = {
        id: sessionId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalTokens: 0,
        contextFiles: [],
      };
      this.sessions.set(sessionId, session);
      this.markDirty(session);
      this.logger.debug(t('agent.sessionCreated', { sessionId }));
    }
    return session;
  }

  get(sessionId: string): Session | null {
    let session = this.sessions.get(sessionId) ?? null;
    if (!session) {
      // 冗余保护：尝试从磁盘加载
      session = this.loadFromDisk(sessionId);
    }
    return session;
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.dirtySessions.delete(sessionId);
    try {
      const filePath = this.sessionFilePath(sessionId);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch (err) {
      this.logger.warn(t('agent.deleteSessionFailed'), {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ========================================================================
  // 上下文文件轨迹（供 WS context-updated 推送使用）
  // ========================================================================

  /** 追加/更新上下文文件轨迹（归一化匹配：相对/绝对形态指向同一文件视为同一条记录，更新 reason 不改 path） */
  addContextFile(sessionId: string, file: ContextFile): void {
    const session = this.get(sessionId);
    if (!session) return;
    const list = session.contextFiles;
    const base = session.lastCwd ?? process.cwd();
    const key = this.pathKey(file.path, base);
    const existing = list.find(f => this.pathKey(f.path, base) === key);
    if (existing) {
      existing.reason = file.reason;
    } else {
      // 显式字段拷贝：防止调用方传入的运行时字段（missing）被持久化进 session
      list.push({ path: file.path, reason: file.reason, tokens: file.tokens });
    }
    this.markDirty(session);
  }

  /**
   * move 迁移：轨迹中解析后等于 oldAbs 的记录（相对/绝对形态统一匹配）更新为新路径
   * （保持原记录的相对/绝对形态），reason 置 'move'；无匹配时新增新路径记录（旧版行为）。
   * 匹配多条（相对+绝对双形态并存）时合并为一条，防止旧路径残留被误判为丢失。
   */
  migrateContextFilesForMove(sessionId: string, oldAbs: string, newAbs: string): void {
    const session = this.get(sessionId);
    if (!session) return;
    const list = session.contextFiles;
    const base = session.lastCwd ?? process.cwd();
    const oldKey = this.pathKey(oldAbs, base);
    const matched = list.filter(f => this.pathKey(f.path, base) === oldKey);
    if (matched.length === 0) {
      list.push({ path: newAbs, reason: 'move' });
    } else {
      const first = matched[0];
      first.path = this.sameFormPath(first.path, newAbs, base);
      first.reason = 'move';
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] !== first && this.pathKey(list[i].path, base) === oldKey) {
          list.splice(i, 1);
        }
      }
    }
    this.markDirty(session);
  }

  /** 记录最近一次 run 的工作目录（变化时持久化；相对路径校验/匹配的基准） */
  setLastCwd(session: Session, cwd: string): void {
    if (!cwd || session.lastCwd === cwd) return;
    session.lastCwd = cwd;
    this.markDirty(session);
  }

  /** 路径归一化键：相对路径基于 base 解析为绝对路径；Windows 下大小写不敏感（对齐 roots.ts 先例） */
  private pathKey(p: string, base: string): string {
    try {
      const abs = isAbsolute(p) ? p : resolve(base, p);
      return process.platform === 'win32' ? abs.toLowerCase() : abs;
    } catch {
      return process.platform === 'win32' ? p.toLowerCase() : p;
    }
  }

  /** 形态保持：旧记录为相对路径且新绝对路径仍在 base 下时，新路径转相对形态；否则用绝对路径 */
  private sameFormPath(oldPath: string, newAbs: string, base: string): string {
    if (!isAbsolute(oldPath)) {
      try {
        const rel = relative(base, newAbs);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
      } catch {
        // 转换失败回退绝对路径
      }
    }
    return newAbs;
  }

  /** 获取某 session 的上下文文件列表 */
  getContextFiles(sessionId: string): ContextFile[] {
    const session = this.get(sessionId);
    return session ? [...session.contextFiles] : [];
  }

  /** 估算某 session 上下文文件的累计 token 数（粗略：path 长度 / 2） */
  estimateContextTokens(sessionId: string): number {
    const session = this.get(sessionId);
    if (!session) return 0;
    return session.contextFiles.reduce(
      (sum, f) => sum + Math.ceil((f.path.length + (f.tokens ?? 0)) / 2),
      0,
    );
  }

  /**
   * 添加用户消息。
   * @param attachments 附件绝对路径（为空/缺省时不写该字段，保持旧数据紧凑）
   * @param clientMessageId 前端生成的消息 id（前端据此与本地乐观副本对齐去重；缺省不写）
   */
  addUserMessage(
    session: Session,
    content: string,
    attachments?: string[],
    clientMessageId?: string,
  ): void {
    session.messages.push({
      role: 'user',
      content,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    this.markDirty(session);
  }

  /** 设置会话级权限模式（变化时持久化；引擎每次 run 解析后调用） */
  setPermissionMode(session: Session, mode: PermissionMode): void {
    if (session.permissionMode === mode) return;
    session.permissionMode = mode;
    session.updatedAt = new Date().toISOString();
    this.markDirty(session);
  }

  /** 写入最近一次 run 统计（不落盘，由调用方按需 persistSession） */
  setLastRunStats(session: Session, stats: RunStats): void {
    session.lastRunStats = stats;
  }

  /**
   * 消耗并返回下一个会话级消息序号（engine 逐 turn 取号，拼成 `<sessionId>#<msgSeq>`）。
   * 首次调用时做旧数据初始化：取「当前消息数」与「历史 messageId 的最大 # 后缀」的较大值，
   * 保证旧会话（`#<turn>` 每 run 从 1 计数留下的重复 id / `#<length+turn>` 时代的 id）
   * 之后的新 id 严格大于一切已存在的 id，永不回撞。
   */
  nextMsgSeq(session: Session): number {
    if (typeof session.msgSeq !== 'number' || !Number.isFinite(session.msgSeq) || session.msgSeq < 0) {
      let max = session.messages.length;
      for (const m of session.messages) {
        if (typeof m.messageId !== 'string') continue;
        const suffix = Number(m.messageId.split('#').pop());
        if (Number.isFinite(suffix) && suffix > max) max = suffix;
      }
      session.msgSeq = max;
    }
    session.msgSeq += 1;
    this.markDirty(session);
    return session.msgSeq;
  }

  /** 添加 assistant 消息（含可能的 tool_calls）；messageId = 本轮流式身份（`<sessionId>#<msgSeq>`） */
  addAssistantMessage(
    session: Session,
    content: string,
    toolCalls?: AgentMessage['toolCalls'],
    thinking?: string,
    messageId?: string,
    thinkingMs?: number,
  ): void {
    session.messages.push({
      role: 'assistant',
      content,
      toolCalls,
      thinking,
      messageId,
      ...(thinkingMs != null ? { thinkingMs } : {}),
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    this.markDirty(session);
  }

  /** 添加工具结果消息 */
  addToolMessage(
    session: Session,
    toolCallId: string,
    content: string,
    name?: string,
    extra?: { isError?: boolean; metadata?: Record<string, unknown>; images?: string[] },
  ): void {
    const images = extra?.images;
    session.messages.push({
      role: 'tool',
      content,
      toolCallId,
      name,
      isError: extra?.isError,
      metadata: extra?.metadata,
      ...(images && images.length > 0 ? { images } : {}),
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    this.markDirty(session);
  }

  // ========================================================================
  // 消息撤回（截断）与恢复（redo）
  // ========================================================================

  /**
   * 定位目标用户消息索引：
   * 1) timestamp 最接近 messageTimestamp（±5 分钟内）的未删除 user 消息；
   * 2) 回退：从后往前第一条 content 完全匹配的未删除 user 消息。
   * 找不到返回 -1。
   */
  locateUserMessage(session: Session, messageTimestamp: string, content: string): number {
    const target = Date.parse(messageTimestamp);
    let bestIdx = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    if (!Number.isNaN(target)) {
      for (let i = 0; i < session.messages.length; i++) {
        const m = session.messages[i];
        if (m.role !== 'user' || m.deletedAt) continue;
        if (!m.timestamp) continue;
        const delta = Math.abs(Date.parse(m.timestamp) - target);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIdx = i;
        }
      }
      if (bestIdx !== -1 && bestDelta <= 5 * 60 * 1000) return bestIdx;
    }
    // 回退：从后往前 content 精确匹配
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role !== 'user' || m.deletedAt) continue;
      if (m.content === content) return i;
    }
    return bestIdx !== -1 && bestDelta <= 5 * 60 * 1000 ? bestIdx : -1;
  }

  /**
   * 从目标用户消息起（含其后全部）标记软删除（索引基于 session.messages 全数组）。
   * 嵌套撤回：已在更早窗口中软删除的消息保持标记（deletedAt 不覆盖）。
   * @returns 被标记的消息数量（0 表示目标索引无效或无可删）
   */
  truncateFrom(session: Session, targetIndex: number): number {
    if (targetIndex < 0 || targetIndex >= session.messages.length) return 0;
    const now = new Date().toISOString();
    let count = 0;
    for (let i = targetIndex; i < session.messages.length; i++) {
      if (!session.messages[i].deletedAt) {
        session.messages[i].deletedAt = now;
        count++;
      }
    }
    if (count > 0) {
      session.updatedAt = now;
      this.saveSessionNow(session);
    }
    return count;
  }

  /**
   * 恢复单个截断窗口：仅清除该窗口起点时间戳之后的软删除标记（嵌套窗口内层保持撤回状态）。
   * 调用方（engine）负责先 pop lastTruncations 栈顶。
   * @returns 恢复的消息数量
   */
  restoreTruncatedWindow(session: Session, beforeTimestamp: string): number {
    const fromMs = Date.parse(beforeTimestamp);
    let restored = 0;
    for (const m of session.messages) {
      if (!m.deletedAt) continue;
      const ts = m.timestamp ? Date.parse(m.timestamp) : Number.NaN;
      // 窗口起点之前的消息属于更早的撤回窗口，保持软删除（时间不可解析时保守恢复：
      // 撤回场景目标消息必有 timestamp，此处仅防御脏数据）
      if (!Number.isNaN(fromMs) && !Number.isNaN(ts) && ts < fromMs) continue;
      m.deletedAt = undefined;
      restored++;
    }
    if (restored > 0) {
      session.updatedAt = new Date().toISOString();
      this.saveSessionNow(session);
    }
    return restored;
  }

  /** 公共持久化入口（供 engine 在 run 结束/截断后写入；立即落盘保证关键状态持久） */
  persistSession(session: Session): void {
    this.saveSessionNow(session);
  }

  /**
   * 把 todo 快照附加到包含该 toolCallId 的 assistant 消息上（持久化）。
   * 快照仅首次写入（undefined 时冻结）：保留该消息 todo 调用时刻的状态，
   * 后续变更（含全部完成后被清空为 []）不再覆盖，防止历史 todo 卡片消失。
   */
  attachTodoSnapshot(session: Session, toolCallId: string, todos: TodoItem[]): void {
    let wrote = false;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === toolCallId)) {
        if (m.todoSnapshot === undefined) {
          m.todoSnapshot = todos;
          wrote = true;
        }
        break;
      }
    }
    if (wrote) {
      session.updatedAt = new Date().toISOString();
      this.markDirty(session);
    }
  }
}

/**
 * 崩溃自愈：修复悬挂 tool_calls（assistant 带 toolCalls 但缺少对应 tool 结果消息）。
 * 场景：防抖落盘窗口内进程崩溃丢尾部消息 / 旧版中断未补结果。
 * 为每个缺失的 toolCall 补一条 isError 错误结果（紧跟所属 assistant 消息之后），
 * 恢复 tool_use/tool_result 配对，防 session 复用时 provider 报 HTTP 400。
 * @returns 补写的消息数
 */
function healDanglingToolCalls(messages: AgentMessage[]): number {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) answered.add(m.toolCallId);
  }
  const inserts: Array<{ index: number; msg: AgentMessage }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (answered.has(tc.id)) continue;
      answered.add(tc.id);
      inserts.push({
        index: i + 1,
        msg: {
          role: 'tool',
          toolCallId: tc.id,
          name: tc.name,
          content: 'Error: result lost due to crash (auto-healed)',
          isError: true,
          timestamp: m.timestamp ?? new Date().toISOString(),
        },
      });
    }
  }
  // 倒序插入保证索引稳定（同索引多条错误结果之间的相对顺序无意义）
  for (let k = inserts.length - 1; k >= 0; k--) {
    messages.splice(inserts[k].index, 0, inserts[k].msg);
  }
  return inserts.length;
}
