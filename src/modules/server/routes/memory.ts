// src/modules/server/routes/memory.ts
// 记忆引擎路由（转发到 memory 模块的 routes 实现；保持 server 路由文件组织惯例）。

export {
  createMemoryTreeHandler,
  createListMemoryHandler,
  createCreateMemoryHandler,
  createGetMemoryHandler,
  createUpdateMemoryHandler,
  createDeleteMemoryHandler,
  createClearMemoryHandler,
  createDistillMemoryHandler,
} from '../../memory/api/routes';
