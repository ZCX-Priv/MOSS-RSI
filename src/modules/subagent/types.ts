// src/modules/subagent/types.ts
// Agent 注册表类型与契约（与前端 webui/src/types/api.ts 对齐）。

/** 注册表列表项 */
export interface AgentItem {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  builtIn: boolean;
  default?: boolean;
}

/** 注册表详情（含执行配置） */
export interface AgentDetail extends AgentItem {
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  maxTokens?: number;
}

/** 注册表持久化结构 */
export interface AgentsStoreData {
  version: number;
  defaultAgentId: string;
  agents: AgentDetail[];
}

/** Agent 注册表服务契约 */
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
