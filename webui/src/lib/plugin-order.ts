// webui/src/lib/plugin-order.ts
// 插件库（技能 / MCP 服务器）自定义顺序：仅保存在浏览器 IndexedDB，不写服务端。
// 未列入顺序的新项保持列表原有相对顺序，排在已排序项之后。

import { idbGet, idbSet } from '../utils/idb';

/** 技能顺序 key（值为技能名数组） */
export const SKILL_ORDER_KEY = 'moss-plugins-skill-order';
/** MCP 服务器顺序 key（值为服务器名数组） */
export const MCP_ORDER_KEY = 'moss-plugins-mcp-order';

/** 读取顺序；非字符串数组视为未设置 */
export async function loadPluginOrder(key: string): Promise<string[]> {
  const raw = await idbGet<unknown>(key);
  if (!Array.isArray(raw)) return [];
  return raw.filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** 保存顺序（idbSet 内部已降级：IndexedDB 不可用时仅内存生效） */
export function savePluginOrder(key: string, names: string[]): void {
  void idbSet(key, names);
}

/** 按保存的顺序重排列表；未列入顺序的项保持原相对顺序排在末尾 */
export function applyPluginOrder<T extends { name: string }>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items;
  const rank = new Map(order.map((name, index) => [name, index]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.name);
    const rb = rank.get(b.name);
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}
