// src/modules/subagent/registry.ts
// Agent 注册表：默认 Agent + 四个内置模板 + 用户自定义 Agent。
// 持久化：~/.moss/agents.json（旧 ~/.moss/agenteam.json 启动时安全迁移）。

import { t } from '../../core/i18n';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Environment, Logger } from '../../core/types';
import { buildTemplateAgents } from './templates';
import type {
  AgentDetail,
  AgentItem,
  AgentRegistry,
  AgentsStoreData,
} from './types';

export class AgentRegistryImpl implements AgentRegistry {
  private readonly storePath: string;
  private readonly logger: Logger;
  private data: AgentsStoreData;

  constructor(env: Environment, logger: Logger) {
    this.storePath = join(env.dataDir, 'agents.json');
    this.logger = logger;
    this.migrateLegacyStore(env);
    this.data = this.load(env);
  }

  /**
   * 一次性迁移：旧 agenteam.json → agents.json。
   * 旧文件是上一版本的权威数据；迁移成功后删除旧文件，失败仅告警不阻断启动。
   */
  private migrateLegacyStore(env: Environment): void {
    const legacyPath = join(env.dataDir, 'agenteam.json');
    if (!existsSync(legacyPath)) return;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      copyFileSync(legacyPath, this.storePath);
      rmSync(legacyPath, { force: true });
      this.logger.info('subagent: registry migrated from agenteam.json');
    } catch (err) {
      this.logger.warn('subagent: registry migration failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      this.logger.error(t('subagent.saveFailed'), {
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
    this.logger.info(t('subagent.agentCreated', { id, name: data.name }));
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
    this.logger.info(t('subagent.agentRemoved', { id }));
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
    this.logger.info(t('subagent.defaultSet', { id }));
    return true;
  }
}
