// src/modules/tools/registry.ts
// 工具注册表：注册、查询、执行工具。

import { t } from '../../core/i18n';
import type { Logger, ConfigService } from '../../core/types';
import type { Tool, ToolContext, ToolResult } from './types';
import type { ToolRegistry } from '../contracts';
import { localizeDescription, localizeSchema } from './loader';
import { compareToolNames } from './sort';

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  /** sourceDir → toolName 索引（热重载增量定位用） */
  private readonly sourceDirIndex = new Map<string, string>();
  private readonly logger: Logger;
  private readonly config: ConfigService | null;

  constructor(logger: Logger, config?: ConfigService) {
    this.logger = logger;
    this.config = config ?? null;
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(t('tools.alreadyRegistered', { name: tool.name }));
    }
    // 同步 sourceDir 索引
    if (tool.sourceDir) {
      // 清理可能指向旧 name 的索引
      this.sourceDirIndex.set(tool.sourceDir, tool.name);
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(t('tools.registered', { name: tool.name }));
  }

  unregister(name: string): void {
    const existing = this.tools.get(name);
    if (existing?.sourceDir) {
      this.sourceDirIndex.delete(existing.sourceDir);
    }
    if (!this.tools.delete(name)) {
      this.logger.warn(t('tools.notRegisteredUnregister', { name }));
    }
  }

  /**
   * 增量热重载：按来源目录替换工具。
   * 若新工具 name 与旧的不同，先移除旧的；同名冲突（不同 sourceDir）保留先注册者。
   */
  reloadBySourceDir(sourceDir: string, tool: Tool): void {
    const oldName = this.sourceDirIndex.get(sourceDir);
    // 文件曾注册过且 name 变了，先移除旧 name
    if (oldName && oldName !== tool.name) {
      this.tools.delete(oldName);
    }
    // 同名工具若已被其他 sourceDir 占用，保留先注册者
    const existing = this.tools.get(tool.name);
    if (existing && existing.sourceDir && existing.sourceDir !== sourceDir) {
      this.logger.warn(t('tools.reloadConflict', { name: tool.name, owner: existing.sourceDir, dir: sourceDir }));
      return;
    }
    this.tools.set(tool.name, tool);
    this.sourceDirIndex.set(sourceDir, tool.name);
    this.logger.debug(t('tools.reloadedBySourceDir', { name: tool.name, dir: sourceDir }));
  }

  /** 按来源目录移除工具（文件删除时调用） */
  removeBySourceDir(sourceDir: string): void {
    const name = this.sourceDirIndex.get(sourceDir);
    if (name) {
      this.tools.delete(name);
      this.sourceDirIndex.delete(sourceDir);
      this.logger.debug(t('tools.removedBySourceDir', { name, dir: sourceDir }));
    }
  }

  /** 判断指定 sourceDir 是否已注册（热重载判断用） */
  hasSourceDir(sourceDir: string): boolean {
    return this.sourceDirIndex.has(sourceDir);
  }

  get(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  listSchemas(): Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    annotations?: Record<string, unknown>;
  }> {
    // 仅暴露启用的工具给 LLM（enabled 从 config 实时读取）；
    // description/schema 按当前后端 locale live 解析（en 时用 description_en）；
    // 顺序：首字母分组（A→Z→a→z→0→9），组内长度升序，同长度按字符序（compareToolNames）
    return this.list()
      .filter(t => this.isEnabled(t.name))
      .sort((a, b) => compareToolNames(a.name, b.name))
      .map(t => ({
        name: t.name,
        description: localizeDescription(t),
        inputSchema: localizeSchema(t.inputSchema),
        annotations: t.annotations as Record<string, unknown> | undefined,
      }));
  }

  /**
   * 判断工具是否启用：从 config.tools[name].enabled 实时读取，缺失默认 true。
   * config 不可用时默认启用（不阻断工具调用）。
   */
  isEnabled(name: string): boolean {
    if (!this.config) return true;
    try {
      const allTools = this.config.getAppConfig().tools as Record<string, { enabled?: boolean }>;
      return allTools[name]?.enabled ?? true;
    } catch {
      return true;
    }
  }

  async execute(name: string, params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: t('toolsExtra.toolNotFoundResult', { name }) }],
        isError: true,
      };
    }

    // 启用状态实时校验（防止 LLM 调用已禁用的工具）
    if (!this.isEnabled(name)) {
      return {
        content: [{ type: 'text', text: `Error: Tool "${name}" is disabled` }],
        isError: true,
      };
    }

    // 从 config 读取 requireConfirmation（优先级：config > annotations）
    // config 不可用时回退到工具自身 annotations
    let requireConfirmation = tool.annotations?.requireConfirmation ?? false;
    let toolConfig: Record<string, unknown> | undefined;
    if (this.config) {
      try {
        const allTools = this.config.getAppConfig().tools as Record<string, Record<string, unknown>>;
        toolConfig = allTools[name];
        if (toolConfig && typeof toolConfig.requireConfirmation === 'boolean') {
          requireConfirmation = toolConfig.requireConfirmation;
        }
      } catch {
        // config 不可用时回退到 annotations
      }
    }

    try {
      // 权限确认 hook（通过 ctx.emit 上报，由前端/上层确认）。
      // safety 模块已决策放行（agent 链路，permissionDecision='allowed'）时跳过；
      // 非 agent 链路（直调 registry）仍走此兜底确认。
      if (requireConfirmation && ctx.permissionDecision !== 'allowed') {
        ctx.emit({
          type: 'confirm-required',
          message: t('toolsExtra.toolRequiresConfirmation', { name }),
          details: params,
        });
        // 强制确认：阻塞等待用户允许，未获批准或无法确认则取消执行（安全默认拒绝）
        const ok = await ctx.confirm?.(
          t('toolsExtra.toolRequiresConfirmation', { name }),
        );
        if (ok === false || ok === undefined) {
          return {
            content: [{ type: 'text', text: `Tool "${name}" canceled (requires confirmation)` }],
            isError: true,
          };
        }
      }

      // 注入 toolConfig 到 ctx，供工具自身读取（如 terminal 的 timeout）
      const ctxWithConfig: ToolContext = { ...ctx, toolConfig };
      const result = await tool.execute(params, ctxWithConfig);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(t('tools.executionFailed', { name }), { error: msg });
      return {
        content: [{ type: 'text', text: `Error executing tool "${name}": ${msg}` }],
        isError: true,
      };
    }
  }
}
