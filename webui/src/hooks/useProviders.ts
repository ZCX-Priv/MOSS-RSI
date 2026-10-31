// UI/src/hooks/useProviders.ts
// 服务商管理 hook：挂载时拉取 providers + current 写入 store；
// 提供服务商/模型两级 CRUD、远程模型列表拉取、余额查询、连通性测试。

import { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { api } from '../api/http';
import i18n from '../i18n';
import type {
  ProviderItem,
  ProviderModelItem,
  ProviderServiceItem,
  ThinkingLevelItem,
  RemoteModelItem,
  ProviderBalanceResult,
} from '../types/api';
import { toast } from 'sonner';

/** 模型是否存在于任一服务商（按 id 或 model 字段匹配，与后端 findModelInProviders 一致） */
function isModelExists(providers: ProviderItem[], modelId: string): boolean {
  return providers.some((p) => p.models.some((m) => m.id === modelId || m.model === modelId));
}

/** 第一个有模型的服务商的第一个模型（"默认模型"回退目标）；无可用模型返回 null */
function findFirstAvailableModel(providers: ProviderItem[]): ProviderModelItem | null {
  for (const p of providers) {
    if (p.models.length > 0) return p.models[0];
  }
  return null;
}

/** 自动切换当前模型并提示（回退失败静默，由后续 load 兜底） */
async function switchCurrentModel(fallback: ProviderModelItem): Promise<void> {
  try {
    await api.setCurrentModel(fallback.id);
    useStore.getState().setCurrentModel(fallback.id);
    toast.info(i18n.t('settings.provider.modelAutoSwitched', { name: fallback.name }));
  } catch {
    // 回退失败保持原状
  }
}

export type UseProvidersResult = ReturnType<typeof useProviders>;

export function useProviders() {
  const setProviders = useStore((s) => s.setProviders);
  const setCurrentModel = useStore((s) => s.setCurrentModel);

  const load = useCallback(async () => {
    try {
      const { providers, current } = await api.listProviders();
      setProviders(providers);
      if (current && !isModelExists(providers, current)) {
        // current 指向不存在的模型（配置残留/外部变更）：自动回退到第一个可用模型
        const fallback = findFirstAvailableModel(providers);
        if (fallback) {
          await switchCurrentModel(fallback);
        }
      } else if (current) {
        setCurrentModel(current);
      }
    } catch (err) {
      console.warn('useProviders load failed:', err);
    }
  }, [setProviders, setCurrentModel]);

  useEffect(() => {
    void load();
  }, [load]);

  const setCurrent = useCallback(
    async (modelId: string) => {
      try {
        await api.setCurrentModel(modelId);
        setCurrentModel(modelId);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [setCurrentModel],
  );

  const createProvider = useCallback(
    async (data: {
      name: string;
      kind?: 'model' | 'voice';
      format?: ProviderItem['format'];
      voiceEngine?: 'openai-transcriptions';
      voiceModel?: string;
      endpoint: string;
      apiKey: string;
      balanceUrl?: string;
      modelsUrl?: string;
      icon?: string;
    }) => {
      try {
        const provider = await api.createProvider(data);
        await load();
        return provider;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const updateProvider = useCallback(
    async (id: string, patch: Partial<Omit<ProviderItem, 'id' | 'models'>>) => {
      try {
        const provider = await api.updateProvider(id, patch);
        await load();
        return provider;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const addProviderService = useCallback(
    async (providerId: string, data: Omit<ProviderServiceItem, 'id'>) => {
      try {
        const service = await api.addProviderService(providerId, data);
        await load();
        return service;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const updateProviderService = useCallback(
    async (providerId: string, serviceId: string, patch: Partial<ProviderServiceItem>) => {
      try {
        const service = await api.updateProviderService(providerId, serviceId, patch);
        await load();
        return service;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const deleteProviderService = useCallback(
    async (providerId: string, serviceId: string) => {
      try {
        await api.deleteProviderService(providerId, serviceId);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      // 删除前预判：该服务商是否含当前选中模型 → 计算回退目标（其他服务商第一个可用模型）
      const state = useStore.getState();
      const target = state.providers.find((p) => p.id === id);
      const hadCurrent = !!target && target.models.some((m) => m.id === state.currentModel);
      const fallback = hadCurrent
        ? findFirstAvailableModel(state.providers.filter((p) => p.id !== id))
        : null;
      try {
        await api.deleteProvider(id);
        // 先切 current 再 reload，避免 load 内部回退到非预期目标
        if (fallback) await switchCurrentModel(fallback);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const reorderProviders = useCallback(
    async (providerIds: string[]) => {
      try {
        await api.reorderProviders(providerIds);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const addProviderModels = useCallback(
    async (
      providerId: string,
      models: Array<{
        name: string;
        model: string;
        thinking?: ProviderModelItem['thinking'];
        contextWindow?: string;
        inputTokens?: number;
        outputTokens?: number;
        temperature?: number;
        topP?: number;
        topK?: number;
        thinkingLevels?: ThinkingLevelItem[];
      }>,
    ) => {
      try {
        const result = await api.addProviderModels(providerId, models);
        await load();
        return result;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const updateProviderModel = useCallback(
    async (providerId: string, modelId: string, patch: Partial<ProviderModelItem>) => {
      try {
        const model = await api.updateProviderModel(providerId, modelId, patch);
        await load();
        return model;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const deleteProviderModel = useCallback(
    async (providerId: string, modelId: string) => {
      // 删除前预判：删的是当前选中模型 → 回退目标优先同服务商剩余模型，否则其他服务商第一个可用模型
      const state = useStore.getState();
      const wasCurrent = state.currentModel === modelId;
      let fallback: ProviderModelItem | null = null;
      if (wasCurrent) {
        const provider = state.providers.find((p) => p.id === providerId);
        const remaining = provider?.models.filter((m) => m.id !== modelId) ?? [];
        fallback =
          remaining[0] ?? findFirstAvailableModel(state.providers.filter((p) => p.id !== providerId));
      }
      try {
        await api.deleteProviderModel(providerId, modelId);
        // 先切 current 再 reload，避免 load 内部回退到非预期目标
        if (fallback) await switchCurrentModel(fallback);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [load],
  );

  const fetchProviderModels = useCallback(
    async (providerId: string): Promise<{ success: boolean; models: RemoteModelItem[]; error?: string }> => {
      try {
        return await api.fetchProviderModels(providerId);
      } catch (err) {
        return { success: false, models: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
    [],
  );

  const fetchProviderBalance = useCallback(
    async (providerId: string): Promise<ProviderBalanceResult> => {
      try {
        return await api.fetchProviderBalance(providerId);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [],
  );

  const testProviderModel = useCallback(
    async (
      providerId: string,
      modelId: string,
    ): Promise<{ success: boolean; latencyMs?: number; error?: string }> => {
      try {
        return await api.testProviderModel(providerId, modelId);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [],
  );

  return {
    providers: useStore((s) => s.providers),
    currentModel: useStore((s) => s.currentModel),
    reload: load,
    setCurrent,
    createProvider,
    updateProvider,
    deleteProvider,
    reorderProviders,
    addProviderModels,
    updateProviderModel,
    deleteProviderModel,
    addProviderService,
    updateProviderService,
    deleteProviderService,
    fetchProviderModels,
    fetchProviderBalance,
    testProviderModel,
  };
}
