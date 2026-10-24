// src/modules/tools/use_command/registry.ts
// Command 注册表（自定义斜杠命令，~/.moss/commands/<name>.md 单文件体系）。
//
// 格式：文件名（去 .md 扩展）即命令名（^[a-z][a-z0-9-]*$）；
// frontmatter：description / argument-hint / icon（均可选）；body 为 prompt 模板（可含 $ARGUMENTS）。
// 启用/禁用：config.commands[name].enabled（缺省启用），isEnabled() 实时读取。
// 热重载：watch 目录（单层），文件增删改即时重载/移除，广播 resources:changed。
// 与 skill（~/.moss/skills/，持久内容型）区分：command 是一次性注入的提示词模板。

import { t } from '../../../core/i18n';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService, Environment, EventBus, Logger } from '../../../core/types';
import { splitFrontMatter } from '../shared/frontmatter';

/** 命令名合法性（与 skill 命名规则一致） */
export const COMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface Command {
  /** 命令名（= 文件名去扩展名） */
  name: string;
  description: string;
  /** 参数提示（菜单展示，如 "[issue-number]"） */
  argumentHint?: string;
  /** Lucide 图标名（kebab-case） */
  icon?: string;
  /** prompt 模板（可含 $ARGUMENTS 占位符） */
  prompt: string;
  /** 来源文件绝对路径 */
  sourceFile: string;
}

/**
 * 热重载结果：
 *   reloaded  —— 内容有变化，已替换并需要通知订阅方
 *   unchanged —— 语义内容未变（touch/幽灵事件），无需重复通知
 *   conflict  —— 同名的另一个来源已占用，保留先注册者
 */
export type CommandReloadResult = 'reloaded' | 'unchanged' | 'conflict';

export interface CommandRegistry {
  register(cmd: Command): void;
  unregister(name: string): void;
  get(name: string): Command | null;
  list(): Command[];
  /** 启用状态（实时读 config.commands[name].enabled，缺省 true） */
  isEnabled(name: string): boolean;
  /** 热重载：文件存在则替换，不存在则移除 */
  reloadBySourceFile(sourceFile: string, cmd: Command): CommandReloadResult;
  /** 移除指定来源对应的 command；返回被移除的命令名，未注册返回 null */
  removeBySourceFile(sourceFile: string): string | null;
}

/** 语义指纹：注册表实际使用的字段 */
function commandSignature(cmd: Command): string {
  return JSON.stringify({
    name: cmd.name,
    description: cmd.description,
    argumentHint: cmd.argumentHint ?? '',
    icon: cmd.icon ?? '',
    prompt: cmd.prompt,
  });
}

class CommandRegistryImpl implements CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private readonly fileIndex = new Map<string, string>();
  /** sourceFile -> 最近一次注册的语义指纹（过滤未变化的重复事件） */
  private readonly signatures = new Map<string, string>();
  private configReader: ((name: string) => boolean) | null = null;

  register(cmd: Command): void {
    const existing = this.commands.get(cmd.name);
    if (existing?.sourceFile) {
      this.fileIndex.delete(existing.sourceFile);
      this.signatures.delete(existing.sourceFile);
    }
    this.commands.set(cmd.name, cmd);
    this.fileIndex.set(cmd.sourceFile, cmd.name);
    this.signatures.set(cmd.sourceFile, commandSignature(cmd));
  }

  unregister(name: string): void {
    const existing = this.commands.get(name);
    if (existing) {
      this.fileIndex.delete(existing.sourceFile);
      this.signatures.delete(existing.sourceFile);
    }
    this.commands.delete(name);
  }

  get(name: string): Command | null {
    return this.commands.get(name) ?? null;
  }

  list(): Command[] {
    return Array.from(this.commands.values());
  }

  isEnabled(name: string): boolean {
    return this.configReader ? this.configReader(name) : true;
  }

  setEnabledReader(reader: (name: string) => boolean): void {
    this.configReader = reader;
  }

  reloadBySourceFile(sourceFile: string, cmd: Command): CommandReloadResult {
    // 同名 command 若已被其他来源占用，保留先注册的（此处不能先删旧条目，否则会丢失原 command）
    const existing = this.commands.get(cmd.name);
    if (existing && existing.sourceFile !== sourceFile) return 'conflict';
    const oldName = this.fileIndex.get(sourceFile);
    if (oldName && oldName !== cmd.name) {
      this.commands.delete(oldName);
      this.fileIndex.delete(sourceFile);
      this.signatures.delete(sourceFile);
    }
    const signature = commandSignature(cmd);
    const unchanged = this.signatures.get(sourceFile) === signature;
    this.commands.set(cmd.name, cmd);
    this.fileIndex.set(sourceFile, cmd.name);
    this.signatures.set(sourceFile, signature);
    return unchanged ? 'unchanged' : 'reloaded';
  }

  removeBySourceFile(sourceFile: string): string | null {
    const name = this.fileIndex.get(sourceFile);
    this.signatures.delete(sourceFile);
    if (!name) return null;
    this.commands.delete(name);
    this.fileIndex.delete(sourceFile);
    return name;
  }
}

// ============================================================================
// 同步 fs 封装（初始化路径避免异步复杂性；Bun 与 Node 均提供）
// ============================================================================

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

function fileExists(path: string): boolean {
  try {
    return nodeFs.existsSync(path);
  } catch {
    return false;
  }
}

/** 解析 command 文件：<name>.md（文件名即命令名） */
function parseCommandFile(filePath: string): Command | null {
  const raw = readFileSync(filePath, 'utf8');
  const { frontMatter, body } = splitFrontMatter(raw);
  // 文件名（去扩展名）即命令名
  const seg = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const name = seg.replace(/\.md$/i, '');
  if (!COMMAND_NAME_RE.test(name)) return null;
  // 空 body 视为无效（与 routes/commands.ts 的 COMMAND_PROMPT_REQUIRED 一致）：
  // 避免热重载时把半写入的文件当成合法命令，覆盖掉旧模板
  if (!body.trim()) return null;
  const description = typeof frontMatter.description === 'string' ? frontMatter.description : '';
  const argumentHint =
    typeof frontMatter['argument-hint'] === 'string' && frontMatter['argument-hint']
      ? (frontMatter['argument-hint'] as string)
      : undefined;
  const icon = typeof frontMatter.icon === 'string' && frontMatter.icon ? frontMatter.icon : undefined;
  return {
    name,
    description,
    ...(argumentHint ? { argumentHint } : {}),
    ...(icon ? { icon } : {}),
    prompt: body.trim(),
    sourceFile: filePath,
  };
}

/**
 * 创建 Command 注册表：从 ~/.moss/commands/ 加载 <name>.md（目录不存在则创建）。
 * 递归监听目录实现热重载（单层文件结构，文件级增量）。
 */
export function createCommandRegistry(
  env: Environment,
  logger: Logger,
  eventBus: EventBus,
  config?: ConfigService,
): CommandRegistry {
  const reg = new CommandRegistryImpl();
  const dir = join(env.dataDir, 'commands');

  // 启用状态读取器（config.commands[name].enabled，缺省 true）
  if (config) {
    reg.setEnabledReader((name: string) => {
      try {
        const cfg = config.getAppConfig();
        return cfg.commands?.[name]?.enabled !== false;
      } catch {
        return true;
      }
    });
  }

  // 确保目录存在（纯用户自定义，无内置播种）
  try {
    nodeFs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.warn(t('tools.commandDirCreateFailed'), {
      error: err instanceof Error ? err.message : String(err),
    });
    return reg;
  }

  // 同步加载
  loadCommandsFromDirSync(reg, dir, logger);

  // 热重载监听
  startWatch(reg, dir, logger, eventBus).catch(err => {
    logger.debug(t('tools.commandDirWatchUnavailable'), {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return reg;
}

function loadCommandsFromDirSync(reg: CommandRegistry, dir: string, logger: Logger): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      const cmd = parseCommandFile(full);
      if (cmd) reg.reloadBySourceFile(full, cmd);
    } catch (err) {
      logger.warn(t('tools.loadCommandFailed', { file: full }), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 热重载事件聚合窗口（与 tools/skill/mcp 的 watcher 保持一致） */
const COMMAND_WATCH_DEBOUNCE_MS = 300;

/** watch 目录（单层）：文件增删改 → 防抖聚合后重载/移除对应 command */
async function startWatch(
  reg: CommandRegistry,
  dir: string,
  logger: Logger,
  eventBus: EventBus,
): Promise<void> {
  let watcher: FSWatcher;
  try {
    watcher = watch(dir);
  } catch (err) {
    logger.debug(t('tools.commandDirWatchUnavailable'), {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const notify = (name: string): void => {
    void eventBus.broadcast('resources:changed', { kind: 'command', name });
  };

  const reloadFile = (full: string): void => {
    try {
      if (!fileExists(full) || !full.endsWith('.md')) {
        // 仅当确实移除过注册项时才记日志/广播
        const removed = reg.removeBySourceFile(full);
        if (removed) {
          logger.info(t('tools.commandRemoved', { name: removed }), { file: full });
          notify(removed);
        }
        return;
      }
      const cmd = parseCommandFile(full);
      if (!cmd) {
        // 半写入/暂态无效内容：保留旧版本，等下一次事件修复（不能当作删除）
        logger.warn(t('tools.commandReloadInvalidSkipped', { file: full }));
        return;
      }
      const result = reg.reloadBySourceFile(full, cmd);
      if (result === 'reloaded') {
        logger.info(t('tools.commandReloaded', { name: cmd.name }), { file: full });
        notify(cmd.name);
      } else if (result === 'unchanged') {
        logger.debug(t('tools.commandReloadUnchanged', { name: cmd.name }), { file: full });
      } else {
        logger.debug(t('tools.commandReloadConflict', { name: cmd.name, file: full }));
      }
    } catch (err) {
      logger.warn(t('tools.reloadCommandFailed', { file: full }), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 同一文件的多个事件合并处理；删除后 300ms 内重建不会触发误移除
  const pending = new Set<string>();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    debounce = null;
    const files = Array.from(pending);
    pending.clear();
    for (const full of files) reloadFile(full);
  };

  watcher.on('change', (_eventType: string, filename: string | Buffer | null) => {
    if (filename === null || Buffer.isBuffer(filename)) return;
    const name: string = filename.replace(/\\/g, '/');
    if (!name || name.includes('/')) return; // 单层目录：忽略子路径事件
    if (name.startsWith('.') || !name.endsWith('.md')) return; // 隐藏文件/临时文件不参与
    pending.add(join(dir, name));
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(flush, COMMAND_WATCH_DEBOUNCE_MS);
  });
  // watcher 的 error 事件若无监听会抛出并终止进程
  watcher.on('error', (err: Error) => {
    logger.warn(t('tools.commandDirWatchUnavailable'), { error: err.message });
  });
}
