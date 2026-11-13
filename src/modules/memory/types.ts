// src/modules/memory/types.ts
// 记忆引擎类型契约：记忆宫殿（Wing→Room→Hall→Drawer）层次结构 + verbatim/蒸馏混合存储。
// 四层记忆栈：L0 身份（系统提示承担）/ L1 关键事实常驻 / L2 主题召回 / L3 深度检索（memory 工具 action=search）。

/** 记忆厅类型（Hall：记忆的语义分类） */
export type MemoryHall = 'decision' | 'event' | 'discovery' | 'preference' | 'suggestion';

export const MEMORY_HALLS: readonly MemoryHall[] = [
  'decision',
  'event',
  'discovery',
  'preference',
  'suggestion',
];

/**
 * 记忆来源分类：
 * - manual：用户在设置页手动创建；
 * - active：Agent 通过 memory 工具主动记录；
 * - auto：会话结束后蒸馏自动提取。
 */
export type MemoryOrigin = 'manual' | 'active' | 'auto';

/** 单条记忆（一个 JSON 文件：{scope}/memory/{wing}/{room}/{hash}.json） */
export interface MemoryRecord {
  /** 内容哈希（sha256 前 16 位 hex） */
  id: string;
  /** 翼：全局个人记忆固定 'user'；项目记忆 = 项目目录名 */
  wing: string;
  /** 房间：主题（蒸馏时 LLM 归类；人工创建自由命名） */
  room: string;
  /** 厅：语义分类 */
  hall: MemoryHall;
  /** 原文片段（零丢失 verbatim 存储） */
  verbatim: string;
  /** 蒸馏后的洞察（注入上下文用） */
  insight: string;
  /** 来源追溯 */
  source: {
    sessionId?: string;
    taskId?: string;
    at: string;
  };
  /** 来源分类（手动创建 / 主动记录 / 自动提取） */
  origin: MemoryOrigin;
  /** 标签 */
  tags: string[];
  /** 重要性 0-1（>= l1ImportanceThreshold 进入 L1 关键事实） */
  importance: number;
  /** 置顶（L1 常驻候选） */
  pinned: boolean;
  accessCount: number;
  lastAccessedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 记忆作用域 */
export type MemoryScope = 'global' | 'project';

/** 带作用域标注的记忆（列表接口返回） */
export interface ScopedMemoryRecord extends MemoryRecord {
  scope: MemoryScope;
}

/** 召回分数构成（可观测：设置页/记忆搜索展示相关度与分项） */
export interface MemoryScoreBreakdown {
  /** 字段加权 BM25 原始分 */
  bm25: number;
  /** 短语精确命中倍数（1 = 未命中） */
  phraseBoost: number;
  /** 重要性倍数 */
  importanceBoost: number;
  /** 时间衰减倍数 */
  recencyBoost: number;
  /** 置顶倍数 */
  pinnedBoost: number;
  /** 最终分（bm25 × 各倍数） */
  final: number;
}

/** 带召回分数的记忆（searchScored / 召回调试返回） */
export interface ScoredMemoryRecord extends ScopedMemoryRecord {
  score: number;
  breakdown: MemoryScoreBreakdown;
}

/** 记忆写入输入 */
export interface MemoryUpsertInput {
  wing: string;
  room: string;
  hall: MemoryHall;
  verbatim: string;
  insight: string;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  /** 来源分类（缺省按自动提取处理，兼容旧调用） */
  origin?: MemoryOrigin;
  source?: { sessionId?: string; taskId?: string; at?: string };
}

/** 宫殿树节点（WebUI 三栏浏览数据源） */
export interface MemoryPalaceTree {
  wings: Array<{
    wing: string;
    scope: MemoryScope;
    rooms: Array<{
      room: string;
      count: number;
      halls: Array<{ hall: MemoryHall; count: number }>;
    }>;
    total: number;
  }>;
}

/** L2 召回注入文本（governor 消费） */
export interface MemoryRecallSection {
  /** 注入文本（null = 无相关记忆，不注入） */
  text: string | null;
  /** 召回的记忆条数 */
  count: number;
  /** 召回的记忆 id */
  recalledIds: string[];
  /** 消息发生切换（新用户输入；调用方据此持久化 session.memoryState） */
  queryChanged?: boolean;
}

/** 蒸馏提取的单条记忆（LLM 输出解析结果） */
export interface DistilledMemory {
  wing?: string;
  room: string;
  hall: MemoryHall;
  verbatim: string;
  insight: string;
  tags?: string[];
  importance?: number;
}
