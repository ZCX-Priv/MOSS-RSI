// src/modules/tools/shared/skill-registry.ts
// Skill 注册表（icon 扩展）。
//
// 两种格式（~/.moss/skills/ 下）：
//   1. 目录式（标准）：<name>/SKILL.md（frontmatter: name/description/allowed-tools?/icon?）
//      + scripts/ + references/ + assets/（渐进披露 L3，LLM 经 read 工具按需读取）
//   2. 单文件（兼容旧格式）：<name>.md（frontmatter + body）
// 播种/升级：包内 skills/ 与 ~/.moss/skills/ 逐文件哈希对比——用户未改的文件自动升级，
// 用户改过的文件保留；manifest v2 记录逐文件指纹（兼容旧版字符串数组）。
// 启用/禁用：config.skills[name].enabled（缺省启用），listEnabled()/isEnabled() 实时读取。
// 热重载：递归监听用户目录，目录级增量重载。

import { createHash } from 'node:crypto';
import { t } from '../../../core/i18n';
import { stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ConfigService, Environment, EventBus, Logger } from '../../../core/types';
import { ServiceNames } from '../../../core/types';
import { splitFrontMatter } from './frontmatter';

/** 旧常量保留，值等于 ServiceNames.SKILL_REGISTRY，向后兼容 */
export const SKILL_REGISTRY_SERVICE = ServiceNames.SKILL_REGISTRY;

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md body / 单文件 body（prompt 模板，可能含 {{placeholder}} 占位符） */
  prompt: string;
  /** 来源文件绝对路径（目录式 = SKILL.md；单文件 = .md 本身） */
  sourceFile?: string;
  /** 目录式 skill 的根目录（单文件为 undefined） */
  dir?: string;
  /** 扩展：图标（Lucide kebab-case 名，或 .svg 文件名——相对 skill 目录） */
  icon?: string;
  /** 标准字段：激活时建议允许的工具列表（提示性约束） */
  allowedTools?: string[];
  /** 附属文件清单（references/scripts/assets 下相对路径；LLM 按需 read） */
  files?: string[];
}

/**
 * 热重载结果：
 *   reloaded  —— 内容有变化，已替换并需要通知订阅方
 *   unchanged —— 语义内容未变（touch/附件变更/幽灵事件），无需重复通知
 *   conflict  —— 同名的另一个来源已占用，保留先注册者
 */
export type SkillReloadResult = 'reloaded' | 'unchanged' | 'conflict';

export interface SkillRegistry {
  register(skill: Skill): void;
  unregister(name: string): void;
  get(name: string): Skill | null;
  list(): Skill[];
  /** 启用状态（实时读 config.skills[name].enabled，缺省 true） */
  isEnabled(name: string): boolean;
  /**
   * 重新扫描用户技能目录；返回本次新增/变化的技能名。
   * 供安装等外部写入后立即生效（不依赖 fs.watch 的 300ms 防抖）。
   */
  rescan(): string[];
  /**
   * 替换某个来源文件对应的 skill（热重载用）。
   * 若新 skill 的 name 与已注册的同名 skill 冲突但 sourceFile 不同，则返回 conflict（旧优先）。
   */
  reloadBySourceFile(sourceFile: string, skill: Skill): SkillReloadResult;
  /** 移除指定来源文件对应的 skill（文件删除时调用）；返回被移除的 skill 名，未注册返回 null */
  removeBySourceFile(sourceFile: string): string | null;
}

/** 语义指纹：注册表实际使用的字段（附件内容变化不改变指纹，附件增删会体现在 files 列表中） */
function skillSignature(skill: Skill): string {
  return JSON.stringify({
    name: skill.name,
    description: skill.description,
    prompt: skill.prompt,
    icon: skill.icon ?? '',
    allowedTools: skill.allowedTools ?? [],
    files: skill.files ?? [],
  });
}

class SkillRegistryImpl implements SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  /** sourceFile -> skill name 索引（热重载定位用） */
  private readonly fileIndex = new Map<string, string>();
  /** sourceFile -> 最近一次注册的语义指纹（过滤未变化的重复事件） */
  private readonly signatures = new Map<string, string>();

  register(skill: Skill): void {
    const existing = this.skills.get(skill.name);
    if (existing?.sourceFile) {
      this.fileIndex.delete(existing.sourceFile);
      this.signatures.delete(existing.sourceFile);
    }
    this.skills.set(skill.name, skill);
    if (skill.sourceFile) {
      this.fileIndex.set(skill.sourceFile, skill.name);
      this.signatures.set(skill.sourceFile, skillSignature(skill));
    }
  }

  unregister(name: string): void {
    const existing = this.skills.get(name);
    if (existing?.sourceFile) {
      this.fileIndex.delete(existing.sourceFile);
      this.signatures.delete(existing.sourceFile);
    }
    this.skills.delete(name);
  }

  get(name: string): Skill | null {
    return this.skills.get(name) ?? null;
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  isEnabled(name: string): boolean {
    // 由构造时注入的 configReader 读取（避免循环依赖：registry 构造早于 config 加载完成时回退 true）
    return this.configReader ? this.configReader(name) : true;
  }

  private configReader: ((name: string) => boolean) | null = null;

  /** 注入启用状态读取器（createSkillRegistry 中设置） */
  setEnabledReader(reader: (name: string) => boolean): void {
    this.configReader = reader;
  }

  /** 重扫实现（createSkillRegistry 中注入，持有用户目录与广播通道） */
  private rescanFn: (() => string[]) | null = null;

  setRescanFn(fn: () => string[]): void {
    this.rescanFn = fn;
  }

  rescan(): string[] {
    return this.rescanFn ? this.rescanFn() : [];
  }

  reloadBySourceFile(sourceFile: string, skill: Skill): SkillReloadResult {
    // 同名 skill 若已被其他来源占用，保留先注册的（此处不能先删旧条目，否则会丢失原 skill）
    const existing = this.skills.get(skill.name);
    if (existing && existing.sourceFile !== sourceFile) {
      return 'conflict';
    }
    const oldName = this.fileIndex.get(sourceFile);
    // 文件曾注册过且 name 变了，先移除旧的
    if (oldName && oldName !== skill.name) {
      this.skills.delete(oldName);
      this.fileIndex.delete(sourceFile);
      this.signatures.delete(sourceFile);
    }
    const signature = skillSignature(skill);
    const unchanged = this.signatures.get(sourceFile) === signature;
    this.skills.set(skill.name, skill);
    this.fileIndex.set(sourceFile, skill.name);
    this.signatures.set(sourceFile, signature);
    return unchanged ? 'unchanged' : 'reloaded';
  }

  removeBySourceFile(sourceFile: string): string | null {
    const name = this.fileIndex.get(sourceFile);
    this.signatures.delete(sourceFile);
    if (!name) return null;
    this.skills.delete(name);
    this.fileIndex.delete(sourceFile);
    return name;
  }
}

/**
 * Skill 播种 manifest（v2）：逐文件内容指纹。
 * - 记录每个内置 skill 上次播种的 relpath → sha256。
 * - userOwned=true：用户自建/改版，永不覆盖。
 * - 兼容旧版字符串数组（v1）：迁移时以目标目录当前内容为基线。
 */
const SEED_MANIFEST_FILE = '.seed-manifest.json';

interface SkillSeedEntry {
  userOwned?: boolean;
  files: Record<string, string>;
}

interface SkillSeedManifest {
  version: 2;
  skills: Record<string, SkillSeedEntry>;
}

/** 文件内容 sha256；读取失败返回 null */
function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(nodeFs.readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** 递归枚举目录下所有文件（跳过隐藏项、node_modules） */
function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = nodeFs.readdirSync(dir) as string[];
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
      const full = join(dir, name);
      try {
        const st = nodeFs.statSync(full) as { isDirectory(): boolean; isFile(): boolean };
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) out.push(full);
      } catch {
        // 单项失败忽略
      }
    }
  };
  walk(root);
  return out;
}

/** 目录内容指纹（relpath posix → sha256） */
function hashDir(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const full of listFilesRecursive(root)) {
    const rel = relative(root, full).split(sep).join('/');
    const hash = sha256File(full);
    if (hash) files[rel] = hash;
  }
  return files;
}

/** 读取 manifest：兼容旧版字符串数组；损坏/缺失视为空 */
function readSkillSeedManifest(manifestPath: string): SkillSeedManifest {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (Array.isArray(raw)) {
      const skills: Record<string, SkillSeedEntry> = {};
      for (const name of raw) {
        if (typeof name === 'string') skills[name] = { files: {} };
      }
      return { version: 2, skills };
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as { version?: unknown; skills?: unknown };
      if (obj.version === 2 && obj.skills && typeof obj.skills === 'object') {
        const skills: Record<string, SkillSeedEntry> = {};
        for (const [name, value] of Object.entries(obj.skills as Record<string, unknown>)) {
          if (!value || typeof value !== 'object') continue;
          const entry = value as { userOwned?: unknown; files?: unknown };
          const files: Record<string, string> = {};
          if (entry.files && typeof entry.files === 'object') {
            for (const [rel, hash] of Object.entries(entry.files as Record<string, unknown>)) {
              if (typeof hash === 'string') files[rel] = hash;
            }
          }
          skills[name] = entry.userOwned === true ? { userOwned: true, files } : { files };
        }
        return { version: 2, skills };
      }
    }
  } catch {
    // 缺失/损坏：视为空 manifest
  }
  return { version: 2, skills: {} };
}

/**
 * 逐 skill 播种（v2 哈希 manifest）：把包内 skills/ 同步到 ~/.moss/skills/。
 * - 新 skill：目标缺失则全量复制；目标已存在且内容与内置一致则接管，否则视为用户自建。
 * - 已有 skill：逐文件比较；目标 == 上次播种指纹 → 用户未改 → 升级；否则保留用户改动。
 * - 用户删除过的 skill（manifest 有记录、目标目录缺失）不补种。
 * - 目标存在但 manifest 无记录且与内置不一致 → userOwned=true，永不覆盖。
 * - 播种失败不阻断启动，仅记录日志。
 */
function seedBuiltinSkills(builtinDir: string, userDir: string, logger: Logger): void {
  try {
    let builtinEntries: string[];
    try {
      builtinEntries = readdirSync(builtinDir);
    } catch {
      return;
    }

    try {
      nodeFs.statSync(userDir);
    } catch {
      nodeFs.mkdirSync(userDir, { recursive: true });
    }

    const manifestPath = join(userDir, SEED_MANIFEST_FILE);
    const manifest = readSkillSeedManifest(manifestPath);

    // 收集内置 skill 名单（仅含 SKILL.md 的目录）
    const builtinNames = new Set<string>();
    for (const entry of builtinEntries) {
      const dir = join(builtinDir, entry);
      try {
        if (statSync(dir).isDirectory() && fileExists(join(dir, 'SKILL.md'))) {
          builtinNames.add(entry);
        }
      } catch {
        // 单项失败忽略
      }
    }

    // v1 迁移：已记录但无指纹的条目，以目标当前内容为基线；
    // 已从内置目录移除的（如 brainstorming/tdd）标记 userOwned，永不覆盖。
    for (const [name, entry] of Object.entries(manifest.skills)) {
      if (Object.keys(entry.files).length > 0) continue;
      const targetDir = join(userDir, name);
      if (fileExists(targetDir)) {
        entry.files = hashDir(targetDir);
        if (!builtinNames.has(name)) entry.userOwned = true;
      }
    }

    let seeded = 0;
    let updated = 0;
    let preserved = 0;
    let skipped = 0;

    for (const entry of builtinEntries) {
      const builtinSkillDir = join(builtinDir, entry);
      try {
        if (!statSync(builtinSkillDir).isDirectory()) continue;
        if (!fileExists(join(builtinSkillDir, 'SKILL.md'))) continue;
      } catch {
        continue;
      }

      const targetDir = join(userDir, entry);
      const current = manifest.skills[entry];

      if (!fileExists(targetDir)) {
        // 用户删除过（manifest 有记录）→ 不补种
        if (current) {
          skipped++;
          continue;
        }
        nodeFs.cpSync(builtinSkillDir, targetDir, { recursive: true });
        manifest.skills[entry] = { files: hashDir(builtinSkillDir) };
        seeded++;
        logger.info(t('tools.seededSkill', { name: entry }), {});
        continue;
      }

      if (current?.userOwned) {
        preserved++;
        continue;
      }

      const builtinFiles = hashDir(builtinSkillDir);

      if (!current) {
        // 目标存在但 manifest 无记录：内容与内置一致则接管，否则视为用户自建
        const targetFiles = hashDir(targetDir);
        const same =
          Object.keys(builtinFiles).length > 0 &&
          Object.keys(builtinFiles).every(rel => targetFiles[rel] === builtinFiles[rel]);
        if (same) {
          manifest.skills[entry] = { files: builtinFiles };
          skipped++;
        } else {
          manifest.skills[entry] = { userOwned: true, files: targetFiles };
          preserved++;
        }
        continue;
      }

      // manifest 有记录：逐文件比较
      const oldFiles = current.files;
      let changed = false;
      for (const [rel, builtinHash] of Object.entries(builtinFiles)) {
        const targetFile = join(targetDir, ...rel.split('/'));
        const builtinFile = join(builtinSkillDir, ...rel.split('/'));
        const targetHash = sha256File(targetFile);
        if (targetHash === null) {
          // 目标文件缺失 → 从内置补齐
          nodeFs.mkdirSync(dirname(targetFile), { recursive: true });
          nodeFs.copyFileSync(builtinFile, targetFile);
          oldFiles[rel] = builtinHash;
          changed = true;
          continue;
        }
        if (targetHash === oldFiles[rel]) {
          // 用户未改 → 内置更新则覆盖
          if (targetHash !== builtinHash) {
            nodeFs.copyFileSync(builtinFile, targetFile);
            oldFiles[rel] = builtinHash;
            changed = true;
          }
          continue;
        }
        // 用户改过 → 保留，不更新该文件的基线
      }

      // 内置已删除的文件：停止跟踪；不删除用户目录中的文件（避免误删数据）
      for (const rel of Object.keys(oldFiles)) {
        if (builtinFiles[rel]) continue;
        const targetHash = sha256File(join(targetDir, ...rel.split('/')));
        if (targetHash !== null && targetHash === oldFiles[rel]) delete oldFiles[rel];
      }

      if (changed) updated++;
      else skipped++;
    }

    // 旧 manifest 中已不在内置目录、但仍在用户目录的条目：标记 userOwned，不补种
    for (const [name, entry] of Object.entries(manifest.skills)) {
      if (builtinNames.has(name)) continue;
      const targetDir = join(userDir, name);
      if (!fileExists(targetDir)) continue;
      entry.userOwned = true;
      if (Object.keys(entry.files).length === 0) entry.files = hashDir(targetDir);
    }

    try {
      nodeFs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch (err) {
      logger.warn(t('tools.seedManifestWriteFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('skills seed summary', { seeded, updated, preserved, skipped });
  } catch (err) {
    // 播种整体失败：不阻断启动
    logger.warn(t('tools.seedBuiltinSkillsFailed'), {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 创建 Skill 注册表：从 ~/.moss/skills/ 加载（目录式 SKILL.md + 兼容单文件 .md）。
 * 首次启动播种内置模板。递归监听用户目录实现热重载。
 */
export function createSkillRegistry(
  env: Environment,
  logger: Logger,
  eventBus: EventBus,
  config?: ConfigService,
): SkillRegistry {
  const reg = new SkillRegistryImpl();
  const builtinDir = join(env.packageRoot, 'skills');  // 仅作种子源
  const userDir = join(env.dataDir, 'skills');         // 唯一加载源

  // 启用状态读取器（config.skills[name].enabled，缺省 true）
  if (config) {
    reg.setEnabledReader((name: string) => {
      try {
        const cfg = config.getAppConfig();
        return cfg.skills?.[name]?.enabled !== false;
      } catch {
        return true;
      }
    });
  }

  // 首次启动播种：若 ~/.moss/skills 不存在，从内置目录递归复制
  seedBuiltinSkills(builtinDir, userDir, logger);

  // 同步加载（仅从用户目录）
  loadSkillsFromDirSync(reg, userDir, logger);

  // 安装等外部写入后可显式重扫：立即注册并广播 resources:changed（不依赖 watch 防抖）
  reg.setRescanFn(() => {
    const names = loadSkillsFromDirSync(reg, userDir, logger);
    for (const name of names) {
      void eventBus.broadcast('resources:changed', { kind: 'skill', name });
    }
    return names;
  });

  // 启动热重载监听（异步，不阻塞初始化）
  startWatch(reg, userDir, logger, eventBus).catch(err => {
    logger.debug(t('tools.skillWatchFailed'), {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return reg;
}

/** 同步从目录加载：目录式（<name>/SKILL.md）优先，兼容单文件 .md；返回本次新增/变化的技能名 */
function loadSkillsFromDirSync(reg: SkillRegistry, dir: string, logger: Logger): string[] {
  const changed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return changed;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: { isDirectory(): boolean; isFile(): boolean };
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    try {
      if (st.isDirectory()) {
        // 目录式 skill：<name>/SKILL.md
        const skillMd = join(full, 'SKILL.md');
        if (fileExists(skillMd)) {
          const skill = parseSkillFile(skillMd, full);
          if (skill && reg.reloadBySourceFile(skillMd, skill) === 'reloaded') {
            changed.push(skill.name);
          }
        }
      } else if (st.isFile() && entry.endsWith('.md')) {
        // 兼容单文件 skill
        const skill = parseSkillFile(full, undefined);
        if (skill && reg.reloadBySourceFile(full, skill) === 'reloaded') {
          changed.push(skill.name);
        }
      }
    } catch (err) {
      logger.warn(t('tools.loadSkillFailed', { file: full }), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return changed;
}

/**
 * 解析 skill 文件（SKILL.md 或单文件 .md）：YAML front-matter + Markdown body。
 * front-matter：name（必填）、description（可选）、allowed-tools（可选，逗号分隔）、
 * icon（可选，Lucide 名或 .svg 文件名）。
 * 目录式 skill 额外收集 references/scripts/assets 附属文件清单。
 */
function parseSkillFile(filePath: string, dir: string | undefined): Skill | null {
  const raw = readFileSync(filePath, 'utf8');
  const { frontMatter, body } = splitFrontMatter(raw);
  const name = frontMatter.name;
  if (!name || typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) {
    return null;
  }
  const description = typeof frontMatter.description === 'string' ? frontMatter.description : '';
  const icon = typeof frontMatter.icon === 'string' && frontMatter.icon ? frontMatter.icon : undefined;
  const allowedTools =
    typeof frontMatter['allowed-tools'] === 'string' && frontMatter['allowed-tools']
      ? (frontMatter['allowed-tools'] as string)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : undefined;
  return {
    name,
    description,
    prompt: body.trim(),
    sourceFile: filePath,
    ...(dir ? { dir } : {}),
    ...(icon ? { icon } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(dir ? { files: collectSkillFiles(dir) } : {}),
  };
}

/** 收集目录式 skill 的附属文件（递归；排除 SKILL.md、隐藏项与 node_modules） */
function collectSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
      const full = join(current, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          const rel = relative(dir, full).split(sep).join('/');
          if (rel !== 'SKILL.md') out.push(rel);
        }
      } catch {
        // 跳过
      }
    }
  };
  walk(dir);
  return out.sort().slice(0, 500);
}

function fileExists(path: string): boolean {
  try {
    return nodeFs.existsSync(path);
  } catch {
    return false;
  }
}

/** 热重载事件聚合窗口：Windows 下一次磁盘变更常被拆成多个 fs.watch 事件 */
const SKILL_WATCH_DEBOUNCE_MS = 300;

/** 事件路径是否属于应忽略的噪音（隐藏项 / node_modules / __pycache__） */
function isIgnoredRelPath(relPath: string): boolean {
  return relPath.split('/').some(
    seg => !seg || seg.startsWith('.') || seg === 'node_modules' || seg === '__pycache__',
  );
}

/** 启动 fs.watch 递归监听用户 skills 目录，实现热重载（防抖批量 + 语义指纹去重） */
async function startWatch(
  reg: SkillRegistry,
  dir: string,
  logger: Logger,
  eventBus: EventBus,
): Promise<void> {
  try {
    await stat(dir);
  } catch {
    // 目录不存在，跳过监听
    return;
  }
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { recursive: true });
  } catch (err) {
    logger.debug(t('tools.skillDirWatchUnavailable'), {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  /** 资源变更通知：广播给订阅方（前端 WS 刷新等） */
  function notify(name: string): void {
    void eventBus.broadcast('resources:changed', { kind: 'skill', name });
  }
  /** 重载一个 skill 来源（目录式 SKILL.md 或单文件 .md）；文件不存在则移除 */
  function reloadPath(full: string, isDirSkill: boolean): void {
    try {
      if (!fileExists(full)) {
        // 仅当确实移除过注册项时才记日志/广播，避免重复事件刷屏
        const removed = reg.removeBySourceFile(full);
        if (removed) {
          logger.info(t('tools.skillRemoved', { file: full }));
          notify(removed);
        }
        return;
      }
      const skill = parseSkillFile(full, isDirSkill ? join(full, '..') : undefined);
      if (!skill) {
        // 半写入/暂态无效内容：保留旧版本，等下一次事件修复（不能当作删除）
        logger.warn(t('tools.skillReloadInvalidSkipped', { file: full }));
        return;
      }
      const result = reg.reloadBySourceFile(full, skill);
      if (result === 'reloaded') {
        logger.info(t('tools.skillReloaded', { name: skill.name }), { file: full });
        notify(skill.name);
      } else if (result === 'unchanged') {
        logger.debug(t('tools.skillReloadUnchanged', { name: skill.name }), { file: full });
      } else {
        logger.debug(t('tools.skillReloadConflict', { name: skill.name, file: full }));
      }
    } catch (err) {
      logger.warn(t('tools.reloadSkillFailed', { file: full }), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 同一个 SKILL.md 的来源路径合并处理；删除后 300ms 内重建不会触发误移除
  const pending = new Map<string, boolean>();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    debounce = null;
    const entries = Array.from(pending);
    pending.clear();
    for (const [full, isDirSkill] of entries) reloadPath(full, isDirSkill);
  };
  const schedule = (full: string, isDirSkill: boolean): void => {
    pending.set(full, isDirSkill);
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(flush, SKILL_WATCH_DEBOUNCE_MS);
  };

  watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
    if (filename === null || Buffer.isBuffer(filename)) return;
    const name: string = filename.replace(/\\/g, '/');
    if (!name) return;
    const segs = name.split('/');
    if (segs.length === 1) {
      // 根层：单文件 .md 或 skill 目录本身的创建/删除/重命名
      if (isIgnoredRelPath(name)) return;
      if (name.endsWith('.md')) {
        const full = join(dir, name);
        // 同名目录式 skill 优先：先查 <basename>/SKILL.md
        const base = name.replace(/\.md$/i, '');
        const dirSkillMd = join(dir, base, 'SKILL.md');
        if (fileExists(dirSkillMd)) {
          schedule(dirSkillMd, true);
        } else {
          schedule(full, false);
        }
      } else {
        // 目录事件：尝试加载 <name>/SKILL.md，不存在则移除该 skill
        schedule(join(dir, name, 'SKILL.md'), true);
      }
    } else {
      // 子路径事件：目录式 skill 内部变更 → 重载该 skill 的 SKILL.md
      if (isIgnoredRelPath(name)) return;
      schedule(join(dir, segs[0], 'SKILL.md'), true);
    }
  });
  // watcher 的 error 事件若无监听会抛出并终止进程
  watcher.on('error', (err: Error) => {
    logger.warn(t('tools.skillDirWatchUnavailable'), { error: err.message });
  });
}

// ============================================================================
// 同步 fs 操作封装（避免在初始化路径中引入异步复杂性）
// ============================================================================
// Bun 与 Node 均提供同步 API；这里通过 require 拿到 node:fs 的同步版本。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFs = require('node:fs') as any;

function readdirSync(dir: string): string[] {
  return nodeFs.readdirSync(dir) as string[];
}

function statSync(path: string): { isDirectory(): boolean; isFile(): boolean } {
  return nodeFs.statSync(path) as { isDirectory(): boolean; isFile(): boolean };
}

function readFileSync(path: string, encoding: string): string {
  return nodeFs.readFileSync(path, encoding) as string;
}
