// src/modules/server/routes/context.ts
// 上下文引擎路由（转发到 context 模块的 routes 实现；保持 server 路由文件组织惯例）。

export {
  createContextStatsHandler,
  createContextCompactionsHandler,
  createCompactPreviewHandler,
  createManualCompactHandler,
  createSummaryModelsHandler,
} from '../../context/api/routes';
