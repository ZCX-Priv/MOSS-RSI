// src/modules/agenteam/index.ts
// agenteam 模块入口：实现 AgentRegistry + TeamOrchestrator 编排服务。
// 注册 agenteam.registry 与 agenteam.orchestrator 服务。
// 持久化：注册表 ~/.moss/agenteam.json（含 1 个默认 Agent + 4 个内置模板）；
//        团队 ~/.moss/agenteam/；团队模板 ~/.moss/agenteam-profiles.json。

import { t } from '../../core/i18n';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Module, ModuleContext, Environment, Logger } from '../../core/types';
import { ServiceNames } from '../../core/types';
import type { AgentEngine } from '../contracts';
import { TeamStore } from './store';
import { TeamProfileStore } from './profiles';
import { TeamOrchestrator } from './orchestrator';
import { buildTemplateAgents } from './templates';
import { registerAgentTools } from './tools';

// ============================================================================
// 类型定义（与前端 webui/src/types/api.ts 对齐）
// ============================================================================

export interface AgentItem {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  builtIn: boolean;
  default?: boolean;
}

export interface AgentDetail extends AgentItem {
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  maxTokens?: number;
}

interface AgentsStoreData {
  version: number;
  defaultAgentId: string;
  agents: AgentDetail[];
}

// ============================================================================
// AgentRegistry 实现
// ============================================================================

export interface AgentRegistry {
  list(): AgentItem[];
  get(id: string): AgentDetail | null;
  create(data: {
    name: string;
    description?: string;
    systemPrompt?: string;
    model?: string;
    tools?: string[];
    icon?: string;
    maxTurns?: number;
    maxTokens?: number;
  }): AgentItem;
  update(id: string, patch: Partial<AgentDetail>): AgentDetail | null;
  remove(id: string): boolean;
  getDefault(): AgentDetail;
  setDefault(id: string): boolean;
}

class AgentRegistryImpl implements AgentRegistry {
  private readonly storePath: string;
  private readonly logger: Logger;
  private data: AgentsStoreData;

  constructor(env: Environment, logger: Logger) {
    this.storePath = join(env.dataDir, 'agenteam.json');
    this.logger = logger;
    // 存量迁移：旧 agents.json → agenteam.json（幂等；失败不阻断启动，下次重试）
    const legacyPath = join(env.dataDir, 'agents.json');
    try {
      if (existsSync(legacyPath) && !existsSync(this.storePath)) {
        renameSync(legacyPath, this.storePath);
      }
    } catch (err) {
      logger.warn('agenteam migrate failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.data = this.load(env);
  }

  private load(env: Environment): AgentsStoreData {
    const defaultData: AgentsStoreData = {
      version: 1,
      defaultAgentId: 'agent',
      agents: [
        {
          id: 'agent',
          name: 'Agent',
          description: 'Default MOSS agent',
          icon: 'Bot',
          builtIn: true,
          default: true,
        },
      ],
    };

    try {
      const raw = readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as AgentsStoreData;
      if (!parsed.agents || !Array.isArray(parsed.agents)) return defaultData;
      // 确保内置 Agent 存在
      if (!parsed.agents.find(a => a.id === 'agent')) {
        parsed.agents.unshift(defaultData.agents[0]);
      }
      // 合并内置模板 agent（幂等：已存在则不覆盖用户修改，缺失则补齐）
      for (const template of buildTemplateAgents(env)) {
        if (!parsed.agents.find(a => a.id === template.id)) {
          parsed.agents.push(template);
        }
      }
      if (!parsed.defaultAgentId) parsed.defaultAgentId = 'agent';
      // 标记 default
      for (const a of parsed.agents) {
        a.default = a.id === parsed.defaultAgentId;
      }
      return parsed;
    } catch {
      // 文件不存在/损坏：默认数据 + 内置模板
      defaultData.agents.push(...buildTemplateAgents(env));
      return defaultData;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      this.logger.error(t('agenteam.saveFailed'), {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  list(): AgentItem[] {
    return this.data.agents.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      builtIn: a.builtIn,
      default: a.id === this.data.defaultAgentId,
    }));
  }

  get(id: string): AgentDetail | null {
    const a = this.data.agents.find(x => x.id === id);
    return a ? { ...a, default: a.id === this.data.defaultAgentId } : null;
  }

  create(data: {
    name: string;
    description?: string;
    systemPrompt?: string;
    model?: string;
    tools?: string[];
    icon?: string;
    maxTurns?: number;
    maxTokens?: number;
  }): AgentItem {
    const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const agent: AgentDetail = {
      id,
      name: data.name,
      description: data.description,
      icon: data.icon ?? 'Bot',
      builtIn: false,
      default: false,
      systemPrompt: data.systemPrompt,
      model: data.model,
      tools: data.tools,
      maxTurns: data.maxTurns,
      maxTokens: data.maxTokens,
    };
    this.data.agents.push(agent);
    this.save();
    this.logger.info(t('agenteam.agentCreated', { id, name: data.name }));
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      builtIn: agent.builtIn,
      default: false,
    };
  }

  update(id: string, patch: Partial<AgentDetail>): AgentDetail | null {
    const idx = this.data.agents.findIndex(a => a.id === id);
    if (idx < 0) return null;
    const existing = this.data.agents[idx];
    if (existing.builtIn && patch.builtIn === false) {
      // 内置 Agent 不允许改为非内置
      return null;
    }
    // 不允许通过 patch 修改 id / builtIn / default
    const { id: _omitId, builtIn: _omitBuiltIn, default: _omitDefault, ...allowedPatch } = patch;
    this.data.agents[idx] = { ...existing, ...allowedPatch };
    this.save();
    return { ...this.data.agents[idx], default: this.data.agents[idx].id === this.data.defaultAgentId };
  }

  remove(id: string): boolean {
    const idx = this.data.agents.findIndex(a => a.id === id);
    if (idx < 0) return false;
    if (this.data.agents[idx].builtIn) return false;
    if (this.data.defaultAgentId === id) return false; // 默认 Agent 不允许删除
    this.data.agents.splice(idx, 1);
    this.save();
    this.logger.info(t('agenteam.agentRemoved', { id }));
    return true;
  }

  getDefault(): AgentDetail {
    const a = this.data.agents.find(x => x.id === this.data.defaultAgentId);
    if (a) return { ...a, default: true };
    // 兜底：返回第一个
    const first = this.data.agents[0];
    this.data.defaultAgentId = first.id;
    this.save();
    return { ...first, default: true };
  }

  setDefault(id: string): boolean {
    const exists = this.data.agents.some(a => a.id === id);
    if (!exists) return false;
    this.data.defaultAgentId = id;
    this.save();
    this.logger.info(t('agenteam.defaultSet', { id }));
    return true;
  }
}

// ============================================================================
// Module 入口
// ============================================================================

class AgenteamModule implements Module {
  private orchestrator: TeamOrchestrator | null = null;

  async initialize(ctx: ModuleContext): Promise<void> {
    const registry = new AgentRegistryImpl(ctx.env, ctx.logger);
    ctx.services.register(ServiceNames.AGENTEAM_REGISTRY, registry, {
      scope: 'agenteam',
    });

    // 编排服务（依赖 AgentEngine；引擎未就绪时降级——不阻断启动）
    const engine = ctx.services.tryResolve<AgentEngine>(ServiceNames.AGENT_ENGINE);
    if (engine) {
      const store = new TeamStore(ctx.env.dataDir, ctx.logger);
      const profiles = new TeamProfileStore(ctx.env.dataDir, ctx.logger);
      this.orchestrator = new TeamOrchestrator({
        engine,
        store,
        profiles,
        eventBus: ctx.eventBus,
        logger: ctx.logger,
        env: ctx.env,
        services: ctx.services,
      });
      ctx.services.register(ServiceNames.AGENTEAM_ORCHESTRATOR, this.orchestrator, {
        scope: 'agenteam',
      });
      // 单一 agent 工具注册（mode=subagent|agenteam）
      registerAgentTools(ctx.services, this.orchestrator, ctx.logger, ctx.env);
    } else {
      ctx.logger.warn('agenteam: agent engine unavailable, orchestrator disabled');
    }

    ctx.logger.info(t('agenteam.moduleInitialized'), {
      agentCount: registry.list().length,
      defaultAgent: registry.getDefault().id,
    });
  }

  async destroy(): Promise<void> {
    this.orchestrator?.destroy();
    this.orchestrator = null;
  }
}

export default (): Module => new AgenteamModule();
