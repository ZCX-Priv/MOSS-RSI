// src/modules/context/compiler/index.ts
// 拼接器统一出口：静态系统提示 + 环境上下文锚定 + 发送视图构建。

export {
  buildStaticSystemPrompt,
  loadSystemPromptSegments,
  getSystemSections,
  invalidateSystemPromptCache,
} from './system-prompt';
export {
  buildEnvContextMessage,
  ensureEnvContext,
  todayDate,
  ENV_CONTEXT_MSG_NAME,
  DAY_ROLLOVER_MSG_NAME,
} from './env-context';
export {
  buildRequestView,
  collectSessionImagePaths,
  COMPACTION_SUMMARY_MSG_NAME,
  SKILL_INJECT_MSG_NAME,
  MAX_TURNS_NOTICE_MSG_NAME,
  SYSTEM_ERROR_MSG_NAME,
} from './view-builder';
export type { BuildViewOptions, BuiltView } from './view-builder';
export { ImageOptimizer } from './image-optimizer';
export type { OptimizedImage } from './image-optimizer';
