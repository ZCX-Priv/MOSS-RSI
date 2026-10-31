// UI/src/hooks/useSkills.ts
// Skills 查询 hook：挂载时拉取 skills 列表写入 store；toggleSkill 启停（乐观更新）。
// （自定义斜杠命令的 CRUD 见 useCommands.ts —— command 与 skill 是两个体系）

import { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import { applyPluginOrder, loadPluginOrder, SKILL_ORDER_KEY } from '../lib/plugin-order';

export function useSkills() {
  const setSkills = useStore((s) => s.setSkills);

  const load = useCallback(async () => {
    try {
      const { skills } = await api.listSkills();
      // 应用浏览器本地保存的自定义顺序（IndexedDB）
      const order = await loadPluginOrder(SKILL_ORDER_KEY);
      setSkills(applyPluginOrder(skills, order));
    } catch (err) {
      console.warn('useSkills load failed:', err);
    }
  }, [setSkills]);

  useEffect(() => {
    void load();
    // 订阅后端资源热重载，自动刷新
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type === 'resources.changed') {
        void load();
      }
    });
    return unsub;
  }, [load]);

  const toggleSkill = useCallback(
    async (name: string, enabled: boolean) => {
      // 乐观更新，失败回滚
      const prev = useStore.getState().skills;
      setSkills(prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
      try {
        await api.updateSkill(name, { enabled });
      } catch (err) {
        setSkills(prev);
        console.warn('toggleSkill failed:', err);
        throw err;
      }
    },
    [setSkills],
  );

  return {
    skills: useStore((s) => s.skills),
    reload: load,
    toggleSkill,
  };
}
