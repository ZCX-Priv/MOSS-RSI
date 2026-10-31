// tools/web/search/types.ts
// 搜索链路共享类型：provider/引擎名、原始结果、清洗后条目、结果池分页与错误。

/** 对 Agent 暴露的四个 provider；default = 元搜索引擎 */
export type ProviderName = 'default' | 'bing' | 'baidu' | 'sogou';

/** 实际搜索引擎 */
export type EngineName = 'bing' | 'baidu' | 'sogou';

/** 时效过滤 */
export type Freshness = 'noLimit' | 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear';

/** 引擎解析出的原始条目（尚未清洗/去重） */
export interface RawResult {
  engine: EngineName;
  /** 该引擎结果页内的 0 基名次 */
  rank: number;
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
  /** Baidu /link?url= 跳转链（真实目标尚未解析） */
  redirectUrl?: string;
  /** 解析器附加标记（如 ad/media/baidu-redirect） */
  flags?: string[];
}

/** 单引擎单页结果 */
export interface EnginePage {
  engine: EngineName;
  items: RawResult[];
  /** 该引擎是否已无更多页 */
  exhausted: boolean;
}

/** 清洗/去重后的条目 */
export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
  /** 命中该条目的全部引擎 */
  engines: EngineName[];
  /** 各引擎内的名次（0 基） */
  engineRanks: Partial<Record<EngineName, number>>;
  /** 内部排序分（只在 metadata 暴露，不写入正文） */
  score: number;
  /** 正文摘录（仅 default provider 增强成功时存在） */
  contentExcerpt?: string;
  contentQuality?: 'high' | 'low';
  flags?: string[];
}

/** 逐引擎失败记录 */
export interface EngineFailure {
  engine: string;
  reason: string;
  cooldownMs?: number;
}

/** 清洗统计 */
export interface CleanStats {
  raw: number;
  deduped: number;
  dropped: number;
  queryFiltered: number;
}

/** 一次分页搜索的完整结果 */
export interface SearchPage {
  searchId: string;
  provider: ProviderName;
  query: string;
  offset: number;
  pageSize: number;
  items: SearchItem[];
  totalAvailable: number;
  hasMore: boolean;
  nextOffset?: number;
  engines: {
    attempted: EngineName[];
    succeeded: EngineName[];
    failed: EngineFailure[];
  };
  stats: CleanStats;
  warnings: string[];
  partial: boolean;
  cacheHit: boolean;
  elapsedMs: number;
}

/** 编排器输入 */
export interface SearchParams {
  sessionId: string;
  query: string;
  provider: ProviderName;
  pageSize: number;
  offset: number;
  /** 首次搜索可省略；翻页时优先使用 */
  searchId?: string;
  freshness: Freshness;
  /** 整次调用总预算 */
  timeoutMs: number;
  signal?: AbortSignal;
  /** 工具配置代理地址（空 = 读环境变量） */
  proxyUrl?: string;
}

export type SearchErrorCode = 'invalid' | 'all-failed' | 'cache-expired' | 'engine-failed';

/** 类型化搜索错误：index.ts 转成用户可读文本 */
export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly failures: EngineFailure[];

  constructor(code: SearchErrorCode, message: string, failures: EngineFailure[] = []) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    this.failures = failures;
  }
}

/** 引擎请求层错误（带冷却信息，供编排器转成 failure） */
export class EngineRequestError extends Error {
  readonly engine: EngineName;
  readonly cooldownMs: number;
  readonly challenge: boolean;

  constructor(engine: EngineName, message: string, options: { cooldownMs?: number; challenge?: boolean } = {}) {
    super(message);
    this.name = 'EngineRequestError';
    this.engine = engine;
    this.cooldownMs = options.cooldownMs ?? 0;
    this.challenge = options.challenge ?? false;
  }
}
