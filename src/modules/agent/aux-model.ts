// src/modules/agent/aux-model.ts
// 辅助模型（标题生成 / 工具结果摘要）共用的模型解析与推理挡位转换。
// 语义与 context 压缩摘要、safety 自动审查保持一致：
//   - 配置 model 为 '' / 'inherit' / 等于主模型 → 继承主模型请求名；
//   - 配置了模型 id 但找不到 → 回退主模型（不阻断主链路）；
//   - reasoningEffort 为 off/none/空 → 关闭思考，其余原样透传 provider。

import type { ThinkingConfig } from '../llm/types';
import { resolveSummaryModel } from '../context/compressor';

/** 推理挡位 → UnifiedRequest.thinking */
export function effortToThinking(effort: string | undefined): ThinkingConfig {
  const value = (effort ?? '').trim();
  if (!value || value === 'off' || value === 'none') return { enabled: false };
  return { enabled: true, effort: value };
}

/**
 * 解析辅助模型请求名（发送给 LLM 的 model 字段值）。
 * @param configured 配置中的模型 id（'' / 'inherit' = 主模型）
 * @param mainRequestModel 本轮主模型请求名
 * @param apiModels provider 模型列表（id → model 映射）
 */
export function resolveAuxRequestModel(
  configured: string,
  mainRequestModel: string,
  apiModels: Array<{ id: string; model: string }>,
): string {
  return resolveSummaryModel(configured, mainRequestModel, apiModels).requestModel;
}
