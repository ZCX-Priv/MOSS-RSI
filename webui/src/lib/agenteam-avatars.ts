// webui/src/lib/agenteam-avatars.ts
// 专家团/子代理头像策略（单一真源）：
// - 四个内置模板绑定固定 seed → 头像永久固定且互不相同；
// - 团队成员头像由 buildMemberAvatarSeeds 统一分配：成员之间签名唯一，
//   且自定义成员不会与四个模板的固定头像重复（基于 Humation 渲染签名做碰撞检测）。

import { createAvatar } from '@humation/core';
import { humation1 } from '@humation/assets-humation-1';

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

/** seed → 头像渲染签名（selections/colors/background/crop）；同签名即视觉相同 */
const signatureCache = new Map<string, string>();

export function avatarSignature(seed: string): string {
  const key = seed.trim() || 'moss';
  const hit = signatureCache.get(key);
  if (hit !== undefined) return hit;
  const json = createAvatar(humation1, { seed: key }).toJSON();
  const sig = JSON.stringify({
    selections: json.selections,
    colors: json.colors,
    background: json.background,
    crop: json.crop,
  });
  signatureCache.set(key, sig);
  return sig;
}

/** 四个固定头像的签名集合（自定义成员必须避开） */
const FIXED_SIGNATURES: ReadonlySet<string> = new Set(
  Object.values(TEMPLATE_AVATAR_SEEDS).map((seed) => avatarSignature(seed)),
);

export interface AvatarMemberLike {
  name?: string;
  agentId?: string;
}

/**
 * 团队成员头像 seed 分配（确定性、成员间唯一、避开四个固定头像）：
 * - 同一模板第一次出现 → 使用模板固定 seed；
 * - 同一模板重复出现（第二个起）/ 自定义成员 → `moss-member:<teamKey>:<name>`，
 *   若签名已占用或撞上固定四个，追加 `#n` 继续尝试（上限保护，避免极端死循环）。
 *
 * 返回 Map<成员名, seed>；成员名在团队内唯一（后端 schema 约束）。
 */
export function buildMemberAvatarSeeds(
  members: ReadonlyArray<AvatarMemberLike>,
  teamKey: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();

  members.forEach((member, index) => {
    const name = (member.name ?? '').trim() || `member-${index + 1}`;
    const fixed = templateAvatarSeed(member.agentId);
    if (fixed) {
      const fixedSig = avatarSignature(fixed);
      if (!used.has(fixedSig)) {
        used.add(fixedSig);
        out.set(name, fixed);
        return;
      }
    }

    const base = `moss-member:${teamKey}:${name}`;
    let seed = base;
    for (let n = 2; n < 66; n += 1) {
      const sig = avatarSignature(seed);
      if (!used.has(sig) && !FIXED_SIGNATURES.has(sig)) {
        used.add(sig);
        break;
      }
      seed = `${base}#${n}`;
    }
    // 极端兜底（理论不可达）：仍写入，保证每个成员总有 seed
    if (!used.has(avatarSignature(seed))) used.add(avatarSignature(seed));
    out.set(name, seed);
  });

  return out;
}

/** 单成员头像 seed（无成员列表上下文时的兜底：模板固定，否则 agentId/name） */
export function fallbackAvatarSeed(agentId?: string | null, name?: string | null): string {
  return templateAvatarSeed(agentId) ?? agentId ?? name ?? 'moss';
}
