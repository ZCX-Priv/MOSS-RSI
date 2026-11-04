// src/modules/tools/index.ts
// Tools 模块入口：注册 ToolRegistry + 内置工具 + Skill/Command 两注册表。
// 工具从 tools 目录的「tool.json + index.ts」结构加载，新增工具只需加目录。
// 支持配置热重载（enabled 变更即时生效）和文件级增量热重载（tool.json/index.ts 变更即时生效）。

import { t } from '../../core/i18n';
import type { Module, ModuleContext, } from '../../core/types';
import { ServiceNames } from '../../core/types';
import { join } from 'node:path';
import { existsSync, statSync, watch, mkdirSync, readdirSync, type FSWatcher } from 'node:fs';
import { ToolRegistryImpl } from './registry';
import { createSkillRegistry } from './shared/skill-registry';
import { createCommandRegistry } from './use_command/registry';
import { BUILTIN_TOOL_NAMES } from './manifest';
import { loadToolDescriptorsFromDir, loadToolFromDir, resolveBuiltinDir } from './loader';
import type { Tool } from './types';

class ToolsModule implements Module {

  private registry: ToolRegistryImpl | null = null;
  private ctx: ModuleContext | null = null;
  /** 已加载的内置工具（含 disabled 的，供 config 热重载启用时直接注册） */
  private loadedBuiltinTools: Tool[] = [];
  private builtinWatcher?: FSWatcher;
  private customWatcher?: FSWatcher;
  /** 工具目录内容签名：toolDir → (relPath → `${mtimeMs}:${size}`)，热重载前校验内容是否真的变化 */
  private toolSignatures = new Map<string, Map<string, string>>();

  async initialize(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.registry = new ToolRegistryImpl(ctx.logger, ctx.config);
    const skillRegistry = createSkillRegistry(ctx.env, ctx.logger, ctx.eventBus, ctx.config);
    const commandRegistry = createCommandRegistry(ctx.env, ctx.logger, ctx.eventBus);

    // 1. 加载并注册内置工具（从 tools 目录，按 config 过滤）
    await this.loadAndRegisterBuiltinTools(ctx);

    // 2. 加载自定义工具（~/.moss/tools/）
    await this.loadCustomTools(ctx);

    // 3. 注册服务（受保护服务名，由模块注册）
    ctx.services.register(ServiceNames.TOOL_REGISTRY, this.registry, {
      scope: 'tools',
    });
    ctx.services.register(ServiceNames.SKILL_REGISTRY, skillRegistry, {
      scope: 'tools',
    });
    ctx.services.register(ServiceNames.COMMAND_REGISTRY, commandRegistry, {
      scope: 'tools',
    });

    // 4. 热重载：工具启用/禁用由 registry.isEnabled 实时读取 config，
    //    listSchemas()/execute() 据此过滤，无需在此监听 config 变更做增删注册。
    //    文件级热重载（tool.json/index.ts 变更）由下方 startBuiltinWatch/startCustomWatch 处理。

    ctx.logger.info(t('tools.moduleInitialized'), {
      tools: this.registry.list().length,
    });
  }

  /** 从 tools 目录加载所有内置工具并注册（含 disabled，启用状态由 registry 实时过滤） */
  private async loadAndRegisterBuiltinTools(ctx: ModuleContext): Promise<void> {
    const builtinDir = resolveBuiltinDir(ctx.env);
    if (!builtinDir) {
      ctx.logger.warn(t('tools.builtinDirNotFound'), {
        checked: [
          join(ctx.env.packageRoot, 'src', 'modules', 'tools'),
          join(ctx.env.packageRoot, 'dist', 'modules', 'tools'),
        ],
      });
      return;
    }

    ctx.logger.info(t('tools.loadingBuiltin'), { dir: builtinDir });
    // 启动期只读 manifest（不 import 重依赖实现）：execute 首次调用才惰性加载 index.ts
    this.loadedBuiltinTools = await loadToolDescriptorsFromDir(builtinDir, ctx.env, ctx.logger, 'builtin');

    // 注册全部内置工具（含 disabled 的）：启用状态由 registry.isEnabled 实时读取 config，
    // listSchemas() 据此过滤给 LLM。这样 config 变更无需增删注册，且前端可见全部工具。
    for (const tool of this.loadedBuiltinTools) {
      this.registry!.register(tool);
      // 预置内容签名：启动批量读取产生的 atime 变化在懒落盘触发 watcher 事件时会被守卫拦截
      this.toolSignatures.set(tool.sourceDir!, this.buildDirSignature(tool.sourceDir!));
    }

    // 启动内置工具目录热重载监听
    this.startBuiltinWatch(builtinDir, ctx);
  }

  /** 从 ~/.moss/tools/ 加载自定义工具（错误隔离，单个失败不影响其他） */
  private async loadCustomTools(ctx: ModuleContext): Promise<void> {
    const dir = join(ctx.env.dataDir, 'tools');
    // 预创建目录（对称 MCP ensureUserMcpsDir）：目录先于 watcher 存在，
    // 保证用户之后创建首个自定义工具时热重载立即生效（无需重启）
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // 创建失败（权限等）：仍尝试加载与监听，watch 启动失败会单独 warn
    }

    ctx.logger.info(t('tools.loadingCustom'), { dir });
    await this.loadCustomToolsFromDir(dir, ctx);

    // 启动自定义工具目录热重载监听
    this.startCustomWatch(dir, ctx);
  }

  /** 扫描目录并加载所有自定义工具子目录 */
  private async loadCustomToolsFromDir(dir: string, ctx: ModuleContext): Promise<void> {
    const tools = await loadToolDescriptorsFromDir(dir, ctx.env, ctx.logger, 'custom');
    for (const tool of tools) {
      // 不允许覆盖内置工具
      if (BUILTIN_TOOL_NAMES.has(tool.name)) {
        ctx.logger.warn(t('tools.customConflictsBuiltin', { name: tool.name, dir: tool.sourceDir ?? '' }));
        continue;
      }
      this.registry!.register(tool);
      // 预置内容签名（同内置工具：拦截 atime 幽灵事件）
      this.toolSignatures.set(tool.sourceDir!, this.buildDirSignature(tool.sourceDir!));
      ctx.logger.info(t('tools.customLoaded', { name: tool.name }), { dir: tool.sourceDir });
    }
  }

  /** 启动内置工具目录热重载监听（批量收集，防抖 300ms） */
  private startBuiltinWatch(builtinDir: string, ctx: ModuleContext): void {
    // 批量收集：300ms 窗口内的多个文件变更全部处理（原实现只保留最后一个 filename，会丢事件）
    const pendingFiles = new Set<string>();
    let pendingFullReload = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      const files = Array.from(pendingFiles);
      pendingFiles.clear();
      const needFull = pendingFullReload;
      pendingFullReload = false;
      if (needFull) {
        // filename 不可得（Windows recursive watch 偶发 null/Buffer）：全量重载兜底
        this.fullReload(builtinDir, ctx, 'builtin').catch(err => {
          ctx.logger.error(t('tools.builtinReloadFailed'), {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      for (const filename of files) {
        this.reloadToolByFilename(builtinDir, filename, ctx, 'builtin').catch(err => {
          ctx.logger.error(t('tools.builtinReloadFailed'), {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    };
    try {
      this.builtinWatcher = watch(builtinDir, { recursive: true }, (_eventType, filename) => {
        if (filename === null || Buffer.isBuffer(filename)) {
          pendingFullReload = true;
        } else {
          pendingFiles.add(filename.replace(/\\/g, '/'));
        }
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(flush, 300);
      });
    } catch (err) {
      ctx.logger.warn(t('tools.watchBuiltinFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 启动自定义工具目录热重载监听（批量收集，防抖 300ms） */
  private startCustomWatch(customDir: string, ctx: ModuleContext): void {
    const pendingFiles = new Set<string>();
    let pendingFullReload = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      const files = Array.from(pendingFiles);
      pendingFiles.clear();
      const needFull = pendingFullReload;
      pendingFullReload = false;
      if (needFull) {
        this.fullReload(customDir, ctx, 'custom').catch(err => {
          ctx.logger.error(t('tools.customReloadFailed'), {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      for (const filename of files) {
        this.reloadToolByFilename(customDir, filename, ctx, 'custom').catch(err => {
          ctx.logger.error(t('tools.customReloadFailed'), {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    };
    try {
      this.customWatcher = watch(customDir, { recursive: true }, (_eventType, filename) => {
        if (filename === null || Buffer.isBuffer(filename)) {
          pendingFullReload = true;
        } else {
          pendingFiles.add(filename.replace(/\\/g, '/'));
        }
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(flush, 300);
      });
    } catch (err) {
      ctx.logger.warn(t('tools.watchCustomFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 构建工具目录内容签名：递归收集所有文件（不含目录）的 relPath → `${mtimeMs}:${size}`。
   * atime 变化不影响 mtimeMs/size，因此可过滤 Windows/Bun 下 atime 懒更新触发的幽灵事件。
   */
  private buildDirSignature(toolDir: string): Map<string, string> {
    const sig = new Map<string, string>();
    const walk = (dir: string, prefix: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full, rel);
          } else if (st.isFile()) {
            sig.set(rel, `${st.mtimeMs}:${st.size}`);
          }
        } catch {
          // 并发删除等竞态：跳过该条目
        }
      }
    };
    walk(toolDir, '');
    return sig;
  }

  private signaturesEqual(a: Map<string, string>, b: Map<string, string>): boolean {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (b.get(k) !== v) return false;
    }
    return true;
  }

  /**
   * 按 watch 的 filename 增量重载单个工具。
   * filename 形如 'read/tool.json' 或 'read/index.ts'，取首段为工具子目录名。
   * 若无法提取 filename，回退到全量重载该来源的所有工具。
   * 守卫：首段含 '.'（顶层文件，如 loader.ts）或目录无 tool.json（如 shared/）时静默跳过。
   */
  private async reloadToolByFilename(
    rootDir: string,
    filename: string | Buffer | null,
    ctx: ModuleContext,
    source: 'builtin' | 'custom',
  ): Promise<void> {
    if (!this.registry) return;

    if (filename === null || Buffer.isBuffer(filename)) {
      // 无法定位具体文件，全量重载
      await this.fullReload(rootDir, ctx, source);
      return;
    }

    // 提取工具子目录名（filename 首段，兼容 / 和 \）
    const parts = filename.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) {
      await this.fullReload(rootDir, ctx, source);
      return;
    }

    // 顶层文件变更（非工具子目录），静默跳过
    if (parts[0].includes('.')) {
      return;
    }

    const toolDir = join(rootDir, parts[0]);
    const toolName = parts[0];

    // 检查目录是否还存在（可能被删除）
    let dirExists = false;
    try {
      dirExists = statSync(toolDir).isDirectory();
    } catch {
      dirExists = false;
    }

    // 非工具目录（无 tool.json，如 shared/），静默跳过
    if (dirExists && !existsSync(join(toolDir, 'tool.json'))) {
      return;
    }

    if (!dirExists) {
      // 工具目录被删除，移除
      this.registry.removeBySourceDir(toolDir);
      this.toolSignatures.delete(toolDir);
      ctx.logger.info(t('tools.toolRemovedDirDeleted', { name: toolName }), { dir: toolDir });
      this.notifyToolChanged(ctx, toolName);
      return;
    }

    // 幽灵事件守卫：Windows/Bun 的 fs.watch 会因 atime 懒更新投递 change 事件（内容并未变化），
    // 且重载自身读取文件会再次刷新 atime，形成自维持重载循环。以 mtime/size 签名校验：内容未变则跳过。
    const currentSig = this.buildDirSignature(toolDir);
    const storedSig = this.toolSignatures.get(toolDir);
    if (storedSig && this.signaturesEqual(storedSig, currentSig)) {
      ctx.logger.debug(t('tools.reloadSkippedUnchanged', { name: toolName }), { dir: toolDir });
      return;
    }
    this.toolSignatures.set(toolDir, currentSig);

    // 重新加载该工具目录
    const tool = await loadToolFromDir(toolDir, ctx.env, ctx.logger, source);
    if (!tool) {
      // 加载失败（如 tool.json 无效），移除旧的
      this.registry.removeBySourceDir(toolDir);
      ctx.logger.warn(t('tools.reloadFailedRemoved', { name: toolName }), { dir: toolDir });
      this.notifyToolChanged(ctx, toolName);
      return;
    }

    // 自定义工具不允许覆盖内置工具
    if (source === 'custom' && BUILTIN_TOOL_NAMES.has(tool.name)) {
      this.registry.removeBySourceDir(toolDir);
      ctx.logger.warn(t('tools.customConflictsBuiltinRemoved', { name: tool.name }), { dir: toolDir });
      this.notifyToolChanged(ctx, tool.name);
      return;
    }

    // 注册（含 disabled 工具）：启用状态由 registry.isEnabled 实时读取 config
    this.registry.reloadBySourceDir(toolDir, tool);
    ctx.logger.info(t('tools.toolReloaded', { name: tool.name }), { dir: toolDir });
    this.notifyToolChanged(ctx, tool.name);

    // 如果是内置工具热重载，同步更新 loadedBuiltinTools 缓存
    if (source === 'builtin') {
      const idx = this.loadedBuiltinTools.findIndex(t => t.sourceDir === toolDir);
      if (idx >= 0) {
        this.loadedBuiltinTools[idx] = tool;
      } else {
        this.loadedBuiltinTools.push(tool);
      }
    }
  }

  /** 工具热重载后广播变更事件，通知前端刷新工具列表 */
  private notifyToolChanged(ctx: ModuleContext, name: string): void {
    void ctx.eventBus.broadcast('resources:changed', { kind: 'tool', name });
  }

  /** 全量重载某个来源的所有工具（回退方案） */
  private async fullReload(rootDir: string, ctx: ModuleContext, source: 'builtin' | 'custom'): Promise<void> {
    if (!this.registry) return;
    this.toolSignatures.clear();

    if (source === 'builtin') {
      // 移除所有内置工具
      for (const tool of this.registry.list()) {
        if (tool.source === 'builtin') {
          this.registry.removeBySourceDir(tool.sourceDir!);
        }
      }
      // 重新加载
      this.loadedBuiltinTools = await loadToolDescriptorsFromDir(rootDir, ctx.env, ctx.logger, 'builtin');
      for (const tool of this.loadedBuiltinTools) {
        this.registry.register(tool);
      }
      ctx.logger.info(t('tools.builtinFullReloaded'));
      this.notifyToolChanged(ctx, '*');
    } else {
      // 移除所有自定义工具
      for (const tool of this.registry.list()) {
        if (tool.source === 'custom') {
          this.registry.removeBySourceDir(tool.sourceDir!);
        }
      }
      await this.loadCustomToolsFromDir(rootDir, ctx);
      ctx.logger.info(t('tools.customFullReloaded'));
      this.notifyToolChanged(ctx, '*');
    }

    // 重载完成后重建签名：全量重载自身读取了所有文件（刷新 atime），
    // 若不重建，后续幽灵事件会逐一穿透守卫造成一轮多余重载
    for (const tool of this.registry.list()) {
      if (tool.sourceDir) {
        this.toolSignatures.set(tool.sourceDir, this.buildDirSignature(tool.sourceDir));
      }
    }
  }

  async destroy(): Promise<void> {
    this.builtinWatcher?.close();
    this.customWatcher?.close();
  }
}

export default (): Module => new ToolsModule();
