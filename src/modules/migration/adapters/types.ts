// src/modules/migration/adapters/types.ts
// 外部 Agent 数据源的统一中间格式。
// 适配器只负责「把各家磁盘格式读成 AgentMessage[]」，不关心 MOSS 任务/分组落盘。

import type { AgentMessage } from '../../contracts';

/** 支持的外部数据源 id */
export type ExternalSourceId = 'claude-code' | 'codex';

/** 会话列表项（前端勾选列表的数据源） */
export interface ExternalSessionMeta {
  /** 来源内唯一 id（CC: jsonl 文件名；Codex: session_meta.payload.id） */
  sourceId: string;
  title: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** 完整会话内容 */
export interface ExternalTranscript {
  meta: ExternalSessionMeta;
  messages: AgentMessage[];
  /** 解析过程中的非致命问题（坏行/未知 block 等），随导入结果回传前端 */
  warnings: string[];
}

export interface SessionAdapter {
  id: ExternalSourceId;
  label: string;
  /** 数据源根目录（绝对路径，供前端展示） */
  rootDir: string;
  /** 根目录是否存在 */
  available(): boolean;
  /** 扫描全部会话（仅提取元信息） */
  list(): ExternalSessionMeta[];
  /** 读取单个会话并解析为 MOSS 消息序列 */
  read(sourceId: string): ExternalTranscript | null;
}
