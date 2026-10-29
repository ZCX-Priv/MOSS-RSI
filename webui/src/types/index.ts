// UI/src/types/index.ts
// UI 纯 UI 类型定义。业务/API 类型统一从 ./api re-export，保持单一真相源。

export type OverlayType = 'search' | null;

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'render'
  | 'anim'
  | 'agent'
  | 'provider'
  | 'context'
  | 'tools'
  | 'safety'
  | 'browser'
  | 'computer'
  | 'remote'
  | 'logs'
  | 'index'
  | 'commands'
  | 'rules'
  | 'memory'
  | 'hooks'
  | 'about';

// 统一 schema：TaskItem / TaskGroup 从 api.ts re-export
export type { TaskItem, TaskGroup } from './api';
