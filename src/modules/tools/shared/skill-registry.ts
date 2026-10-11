// src/modules/tools/shared/skill-registry.ts
// Skill 注册表（greet/icon 扩展）。
//
// 两种格式（~/.moss/skills/ 下）：
//   1. 目录式（标准）：<name>/SKILL.md（frontmatter: name/description/allowed-tools?/greet?/icon?）
//      + scripts/ + references/ + assets/（渐进披露 L3，LLM 经 read 工具按需读取）
//   2. 单文件（兼容旧格式）：<name>.md（frontmatter + body）
// 首次启动播种：包内 skills/ 递归复制到 ~/.moss/skills/（仅当目标目录不存在时）。
// 启用/禁用：config.skills[name].enabled（缺省启用），listEnabled()/isEnabled() 实时读取。
// 热重载：递归监听用户目录，目录级增量重载。

import { t } from '../../../core/i18n';
import { stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
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
  /** 扩展：切入模式后的欢迎语 */
  greet?: string;
  /** 扩展：图标（Lucide kebab-case 名，或 .svg 文件名——相对 skill 目录） */
  icon?: string;
  /** 标准字段：激活时建议允许的工具列表（提示性约束） */
  allowedTools?: string[];
  /** 附属文件清单（references/scripts/assets 下相对路径；LLM 按需 read） */
  files?: string[];
}

export interface SkillRegistry {
  register(skill: Skill): void;
  unregister(name: string): void;
  get(name: string): Skill | null;
  list(): Skill[];
  /** 启用状态（实时读 config.skills[name].enabled，缺省 true） */
  isEnabled(name: string): boolean;
  /**
   * 替换某个来源文件对应的 skill（热重载用）。
   * 若新 skill 的 name 与已注册的同名 skill 冲突但 sourceFile 不同，则跳过（旧优先）。
   */
  reloadBySourceFile(sourceFile: string, skill: Skill): void;
  /** 移除指定来源文件对应的 skill（文件删除时调用） */
  removeBySourceFile(sourceFile: string): void;
}

class SkillRegistryImpl implements SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  /** sourceFile -> skill name 索引（热重载定位用） */
  private readonly fileIndex = new Map<string, string>();

  register(skill: Skill): void {
    const existing = this.skills.get(skill.name);
    if (existing?.sourceFile) {
      this.fileIndex.delete(existing.sourceFile);
    }
    this.skills.set(skill.name, skill);
    if (skill.sourceFile) {
      this.fileIndex.set(skill.sourceFile, skill.name);
    }
  }

  unregister(name: string): void {
    const existing = this.skills.get(name);
    if (existing?.sourceFile) {
      this.fileIndex.delete(existing.sourceFile);
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

  reloadBySourceFile(sourceFile: string, skill: Skill): void {
    const oldName = this.fileIndex.get(sourceFile);
    // 若文件曾注册过且 name 变了，先移除旧的
    if (oldName && oldName !== skill.name) {
      this.skills.delete(oldName);
      this.fileIndex.delete(sourceFile);
    }
    // 同名 skill 若已被其他来源占用，保留先注册的
    const existing = this.skills.get(skill.name);
    if (existing && existing.sourceFile !== sourceFile) {
      // 名称冲突，跳过（先注册者优先）
      return;
    }
    this.skills.set(skill.name, skill);
    this.fileIndex.set(sourceFile, skill.name);
  }

  removeBySourceFile(sourceFile: string): void {
    const name = this.fileIndex.get(sourceFile);
    if (name) {
      this.skills.delete(name);
      this.fileIndex.delete(sourceFile);
    }
  }
}

/**
 * 逐 skill 播种（带 manifest）：把包内 skills/ 下未播种过的目录式 skill 复制到 ~/.moss/skills/。
 * - manifest（~/.moss/skills/.seed-manifest.json）记录已播种的 skill 名；
 *   已记录（含用户后来删除的）永不补种，未记录的新内置 skill（如版本升级新增）会补种。
 * - 用户目录已存在同名 skill 时不覆盖（保留用户修改），仅补记 manifest。
 * - 播种失败不阻断启动，仅记录日志。
 */
const SEED_MANIFEST_FILE = '.seed-manifest.json';

function seedBuiltinSkills(builtinDir: string, userDir: string, logger: Logger): void {
  try {
    // 内置目录不存在（开发模式异常）：无种子可播
    let builtinEntries: string[];
    try {
      builtinEntries = readdirSync(builtinDir);
    } catch {
      return;
    }
    // 确保用户目录存在
    try {
      nodeFs.statSync(userDir);
    } catch {
      nodeFs.mkdirSync(userDir, { recursive: true });
    }

    // 读取播种 manifest（不存在视为空）
    let seeded: string[] = [];
    try {
      const raw = nodeFs.readFileSync(join(userDir, SEED_MANIFEST_FILE), 'utf8') as string;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        seeded = parsed.filter((n): n is string => typeof n === 'string');
      }
    } catch {
      // 首次播种（manifest 不存在）
    }

    let changed = false;
    for (const entry of builtinEntries) {
      // 仅处理目录式内置 skill（<name>/SKILL.md）
      const builtinSkillDir = join(builtinDir, entry);
      try {
        if (!statSync(builtinSkillDir).isDirectory()) continue;
        if (!fileExists(join(builtinSkillDir, 'SKILL.md'))) continue;
      } catch {
        continue;
      }
      // 已播种过（含用户删除后不再补种）
      if (seeded.includes(entry)) continue;
      const targetDir = join(userDir, entry);
      try {
        if (!fileExists(targetDir)) {
          nodeFs.cpSync(builtinSkillDir, targetDir, { recursive: true });
          logger.info(t('tools.seededSkill', { name: entry }), {});
        }
        // 用户目录已有同名（用户自建）：不覆盖，仅记录
        seeded.push(entry);
        changed = true;
      } catch (err) {
        logger.warn(t('tools.seedSkillFailed', { file: entry }), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (changed) {
      try {
        nodeFs.writeFileSync(
          join(userDir, SEED_MANIFEST_FILE),
          JSON.stringify(seeded, null, 2),
          'utf8',
        );
      } catch (err) {
        logger.warn(t('tools.seedManifestWriteFailed'), {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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

  // 启动热重载监听（异步，不阻塞初始化）
  startWatch(reg, userDir, logger, eventBus).catch(err => {
    logger.debug(t('tools.skillWatchFailed'), {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return reg;
}

/** 同步从目录加载：目录式（<name>/SKILL.md）优先，兼容单文件 .md */
function loadSkillsFromDirSync(reg: SkillRegistry, dir: string, logger: Logger): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
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
          if (skill) reg.reloadBySourceFile(skillMd, skill);
        }
      } else if (st.isFile() && entry.endsWith('.md')) {
        // 兼容单文件 skill
        const skill = parseSkillFile(full, undefined);
        if (skill) reg.reloadBySourceFile(full, skill);
      }
    } catch (err) {
      logger.warn(t('tools.loadSkillFailed', { file: full }), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 解析 skill 文件（SKILL.md 或单文件 .md）：YAML front-matter + Markdown body。
 * front-matter：name（必填）、description（可选）、allowed-tools（可选，逗号分隔）、
 * greet（可选，切入欢迎语）、icon（可选，Lucide 名或 .svg 文件名）。
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
  const greet = typeof frontMatter.greet === 'string' && frontMatter.greet ? frontMatter.greet : undefined;
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
    ...(greet ? { greet } : {}),
    ...(icon ? { icon } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(dir ? { files: collectSkillFiles(dir) } : {}),
  };
}

/** 收集目录式 skill 的附属文件（references/scripts/assets 下，相对 skill 目录） */
function collectSkillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const sub of ['references', 'scripts', 'assets']) {
    const subDir = join(dir, sub);
    let entries: string[];
    try {
      entries = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(subDir, entry);
      try {
        if (statSync(full).isFile()) {
          out.push(`${sub}/${entry}`);
        }
      } catch {
        // 跳过
      }
    }
  }
  return out.sort();
}

function fileExists(path: string): boolean {
  try {
    return nodeFs.existsSync(path);
  } catch {
    return false;
  }
}

/** 启动 fs.watch 递归监听用户 skills 目录，实现热重载（目录级增量） */
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
      if (fileExists(full)) {
        const skill = parseSkillFile(full, isDirSkill ? join(full, '..') : undefined);
        if (skill) {
          reg.reloadBySourceFile(full, skill);
          logger.info(t('tools.skillReloaded', { name: skill.name }), { file: full });
          notify(skill.name);
          return;
        }
      }
      reg.removeBySourceFile(full);
      logger.info(t('tools.skillRemoved', { file: full }));
      notify(basename(full));
    } catch (err) {
      logger.warn(t('tools.reloadSkillFailed', { file: full }), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
    if (filename === null || Buffer.isBuffer(filename)) return;
    const name: string = filename.replace(/\\/g, '/');
    if (!name) return;
    // 忽略附属文件内容变更对注册表的影响（files 清单在 SKILL.md 重载时刷新；
    // 但新增/删除附属文件也应刷新清单——统一触发所属 skill 目录重载）
    const segs = name.split('/');
    if (segs.length === 1) {
      // 根层：单文件 .md 或 skill 目录本身的创建/删除/重命名
      if (name.endsWith('.md')) {
        const full = join(dir, name);
        // 同名目录式 skill 优先：先查 <basename>/SKILL.md
        const base = name.replace(/\.md$/i, '');
        const dirSkillMd = join(dir, base, 'SKILL.md');
        if (fileExists(dirSkillMd)) {
          reloadPath(dirSkillMd, true);
        } else {
          reloadPath(full, false);
        }
      } else {
        // 目录事件：尝试加载 <name>/SKILL.md，不存在则移除该 skill
        const skillMd = join(dir, name, 'SKILL.md');
        reloadPath(skillMd, true);
      }
    } else {
      // 子路径事件：目录式 skill 内部变更 → 重载该 skill 的 SKILL.md
      const skillDir = segs[0];
      const skillMd = join(dir, skillDir, 'SKILL.md');
      reloadPath(skillMd, true);
    }
  });
}

function basename(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const parts = norm.split('/');
  const last = parts[parts.length - 1];
  return last.replace(/\.md$/i, '').replace(/\/SKILL$/i, '');
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
