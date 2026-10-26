// webui/src/lib/agent-avatars.ts
// 子代理头像策略（单一真源）：
// 四个内置模板绑定固定 seed → 头像永久固定且互不相同；
// 非内置/未知模板回退到 template id 或名称作为 seed（同 seed 头像稳定）。

/** 四个内置模板的固定头像 seed（与 agentId 解耦，模板身份稳定） */
export const TEMPLATE_AVATAR_SEEDS: Readonly<Record<string, string>> = {
  agent_explorer: 'moss-template-explorer',
  agent_planner: 'moss-template-planner',
  agent_coder: 'moss-template-coder',
  agent_reviewer: 'moss-template-reviewer',
};

/** 模板固定 seed；非内置模板返回 null（由调用方回退） */
export function templateAvatarSeed(agentId?: string | null): string | null {
  if (!agentId) return null;
  return TEMPLATE_AVATAR_SEEDS[agentId] ?? null;
}

/** 单 agent 头像 seed（无模板映射时的兜底：模板固定，否则 agentId/name） */
export function fallbackAvatarSeed(agentId?: string | null, name?: string | null): string {
  return templateAvatarSeed(agentId) ?? agentId ?? name ?? 'moss';
}
