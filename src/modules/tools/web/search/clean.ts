// tools/web/search/clean.ts
// 搜索结果清洗、去重、相关性排序。
//
// 目标（对应用户三条反馈）：
// 1. 多个相似内容：URL 规范化 + 标题 Jaccard + 标题/摘要 SimHash 近邻聚类；
// 2. 大量无关内容：查询 token 覆盖度过滤（池充足时才丢弃，避免空结果）；
// 3. 信源不可靠：多引擎一致加权（RRF）+ 来源等级 + 同域名最多 2 条。

import type { CleanStats, EngineName, RawResult, SearchItem } from './types';
import { normalizeSpace } from './engines/common';

// ============================================================================
// 常量
// ============================================================================

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'yclid', 'msclkid', 'spm', 'scm', 'from', 'source', 'ref',
  'share', 'share_token', 'share_id', 'sm', 'entry', 'cq', 'spm_id_from',
]);

const TITLE_SIMILARITY_THRESHOLD = 0.82;
const SIMHASH_HAMMING_THRESHOLD = 4;
const SIMHASH_TITLE_MIN_SIMILARITY = 0.72;
const DOMAIN_LIMIT = 2;
const RELEVANCE_THRESHOLD = 0.15;

const HIGH_TIER_HOSTS = [
  '.gov.cn', '.edu.cn', '.gov', '.edu',
  'wikipedia.org', 'github.com', 'stackoverflow.com', 'developer.mozilla.org',
  'nodejs.org', 'python.org', 'rust-lang.org', 'go.dev', 'npmjs.com',
  'microsoft.com', 'openai.com', 'anthropic.com', 'deepseek.com', 'cloudflare.com',
];

const LOW_TIER_HOSTS = [
  'baijiahao.baidu.com', 'zhidao.baidu.com', 'wenku.baidu.com',
  'docin.com', 'renrendoc.com', '360doc.com', 'doc88.com',
  'book118.com', 'taodocs.com',
];

const SITE_SUFFIX_PATTERN = /(?:\s*[-_|—–]\s*)(百度知道|百度百科|知乎|知乎专栏|CSDN博客|博客园|简书|搜狐|网易|新浪|腾讯|今日头条|百家号|微信公众号|官方网站|官网|百科)$/i;

const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '及', '就', '都', '而', '也', '这', '那',
  '有', '我', '你', '他', '它', '们', '一个', '什么', '如何', '怎么', '为什么',
  '哪些', '哪个', '可以', '是否', '最新', '今天', '现在',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'was', 'were', 'what', 'how', 'why', 'which', 'latest', 'today',
]);

// ============================================================================
// 文本规范化
// ============================================================================

/** NFKC + 去零宽/控制字符 + 折叠空白 */
export function normalizeText(value: string): string {
  return normalizeSpace(
    value
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' '),
  );
}

/** 标题清洗：去广告标记、URL/面包屑残留、站点后缀、尾部省略号 */
export function cleanTitle(value: string): string {
  let title = normalizeText(value)
    .replace(/^[\[【(（]?\s*广告\s*[\]】)）]?\s*/i, '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s*›[\s\S]*$/g, ' ')
    .replace(/\.{2,}|…+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  title = title.replace(SITE_SUFFIX_PATTERN, '').trim();
  return title;
}

/** 摘要清洗：去模板词与「查看更多/百度快照」噪声 */
export function cleanSnippet(value: string, title: string): string {
  let snippet = normalizeText(value)
    .replace(/^[\[【(（]?\s*广告\s*[\]】)）]?\s*/i, '')
    .replace(/^(最佳答案|回答时间|发布时间|更新时间|摘要)[:：]?\s*/i, '')
    .replace(/(百度快照|网页快照|查看更多|展开全部|下载APP|扫码关注|点击进入|立即下载)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalizeText(snippet).toLowerCase() === normalizeText(title).toLowerCase()) {
    snippet = '';
  }
  return snippet;
}

// ============================================================================
// URL 规范化
// ============================================================================

/** URL 规范化：去 fragment/追踪参数、host 小写、默认端口、尾斜杠、排序 query */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    kept.push([key, value]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const search = new URLSearchParams();
  for (const [key, value] of kept) search.append(key, value);
  url.search = search.toString();
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// ============================================================================
// 查询 token 与覆盖度
// ============================================================================

/** 查询分词：中文 2-gram + 英文单词，去停用词，最多 24 个 */
export function queryTokens(query: string): string[] {
  const normalized = normalizeText(query).toLowerCase();
  const tokens = new Set<string>();
  const parts = normalized.split(/[\s,，。.!！?？、;；:：/\\|()（）\[\]【】'"“”‘’<>《》]+/).filter(Boolean);

  for (const part of parts) {
    if (part.length < 1) continue;
    const lower = part.toLowerCase();
    const hasCjk = /[\u3400-\u9FFF]/.test(lower);
    if (hasCjk) {
      if (lower.length >= 2) {
        for (let i = 0; i < lower.length - 1; i++) {
          const gram = lower.slice(i, i + 2);
          if (!STOPWORDS.has(gram)) tokens.add(gram);
        }
      }
      if (lower.length <= 6 && !STOPWORDS.has(lower)) tokens.add(lower);
    } else if (lower.length >= 2 && !STOPWORDS.has(lower)) {
      tokens.add(lower);
    }
  }

  return Array.from(tokens).slice(0, 24);
}

/** 文本对查询 token 的覆盖度 */
export function queryCoverage(text: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const normalized = normalizeText(text).toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) matched++;
  }
  return matched / tokens.length;
}

function combinedCoverage(title: string, snippet: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const titleCoverage = queryCoverage(title, tokens);
  const snippetCoverage = queryCoverage(snippet, tokens);
  return Math.min(1, (titleCoverage * 2 + snippetCoverage) / 3);
}

// ============================================================================
// 相似度：字符 bigram Jaccard + 64 位 SimHash
// ============================================================================

function shingles(text: string, size = 2): Set<string> {
  const normalized = normalizeText(text).toLowerCase();
  const set = new Set<string>();

  // 中文：连续 CJK 片段做字符 bigram（不需要分词也能捕捉改写/转载）
  const cjkChunks = normalized.match(/[\u3400-\u9FFF]+/g) ?? [];
  for (const chunk of cjkChunks) {
    if (chunk.length < size) {
      if (chunk) set.add(chunk);
      continue;
    }
    for (let i = 0; i <= chunk.length - size; i++) set.add(chunk.slice(i, i + size));
  }

  // 英文/数字：按词 + 相邻词 bigram
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length >= 2 && !STOPWORDS.has(word)) set.add(word);
    const next = words[i + 1];
    if (next && word.length >= 2 && next.length >= 2) set.add(`${word} ${next}`);
  }

  if (set.size === 0 && normalized) set.add(normalized.slice(0, 24));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function fnv1a64(value: string): bigint {
  let hash = 14_695_981_039_346_656_037n;
  const prime = 1_099_511_628_211n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash;
}

/** 64 位 SimHash；token 太少返回 null（避免不可靠的近邻判断） */
export function simHash64(text: string): bigint | null {
  const tokens = shingles(text, 2);
  if (tokens.size < 4) return null;
  const weights = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < 64; bit++) {
      const mask = 1n << BigInt(bit);
      weights[bit] += (hash & mask) !== 0n ? 1 : -1;
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit] > 0) result |= 1n << BigInt(bit);
  }
  return result;
}

/** 文本相似度（标题 bigram Jaccard），正文伪装检测复用 */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}

export function hammingDistance(a: bigint, b: bigint): number {
  let value = a ^ b;
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count++;
  }
  return count;
}

// ============================================================================
// 垃圾过滤与来源等级
// ============================================================================

function isEngineSelfLink(host: string, path: string): boolean {
  if (host.endsWith('bing.com')) {
    return path.startsWith('/search') || path.startsWith('/ck/a') || path.startsWith('/newtabredir');
  }
  if (host.endsWith('baidu.com')) {
    return path.startsWith('/s') || path.startsWith('/link') === false && path === '/';
  }
  if (host.endsWith('sogou.com')) {
    return path.startsWith('/web') || path.startsWith('/link');
  }
  return false;
}

/** 软件下载站/破解站特征（仅对非权威域名生效） */
function isDownloadSpam(host: string, path: string, title: string, tier: 'high' | 'neutral' | 'low'): boolean {
  if (tier === 'high') return false;
  const piracy = /(破解版|绿色版|激活版|汉化版|免激活|无敌版)/.test(title);
  if (piracy) return true;
  const downloadPath = /(down|download|soft|downinfo|app)\//i.test(path);
  const downloadTitle = /(官方正版下载|正版下载|正式版下载|免费下载|下载地址|安装包|安卓|电脑版|最新版|正式版|满血版)/.test(title);
  return downloadPath && downloadTitle;
}

function hardFilter(item: RawResult): boolean {
  const title = cleanTitle(item.title);
  const snippet = cleanSnippet(item.snippet, title);
  if (!title && !snippet) return true;
  if (!/^https?:\/\//i.test(item.url)) return true;

  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return true;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (isEngineSelfLink(host, path)) return true;
  if (isDownloadSpam(host, path, title, sourceTier(host))) return true;

  // 只有站点名/域名、没有真实标题的卡片（Bing 站点图标链接被误取）
  const hostName = host.replace(/^www\./, '');
  if (title.toLowerCase() === host || title.toLowerCase() === hostName) return true;

  const text = `${title} ${snippet}`;
  if (text.length < 6) return true;
  if (/^(立即下载|点击进入|官网首页|登录|注册|扫码下载|打开APP)$/i.test(title)) return true;
  if (/^[\p{P}\p{S}\d\s]+$/u.test(title)) return true;
  return false;
}

function sourceTier(host: string): 'high' | 'neutral' | 'low' {
  if (HIGH_TIER_HOSTS.some((suffix) => host === suffix || host.endsWith(suffix) || host.startsWith(`${suffix}/`))) {
    return 'high';
  }
  if (LOW_TIER_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return 'low';
  }
  return 'neutral';
}

function junkPenalty(host: string, path: string, snippet: string): number {
  let penalty = 0;
  if (/\/(tag|tags|category|categories|search|page)\//i.test(path)) penalty += 0.003;
  if (path.split('/').filter(Boolean).length > 4) penalty += 0.002;
  if (snippet.length < 40) penalty += 0.002;
  if (sourceTier(host) === 'low') penalty += 0.004;
  return penalty;
}

function freshnessBoost(publishedAt: string | undefined): number {
  if (!publishedAt) return 0;
  const date = Date.parse(publishedAt);
  if (!Number.isFinite(date)) return 0;
  const ageMs = Date.now() - date;
  if (ageMs < 0) return 0;
  if (ageMs <= 30 * 86_400_000) return 0.002;
  return 0;
}

// ============================================================================
// 聚类与合并
// ============================================================================

interface Candidate {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
  engines: Set<EngineName>;
  engineRanks: Partial<Record<EngineName, number>>;
  flags: Set<string>;
  titleTokens: Set<string>;
  simhash: bigint | null;
  redirectUrl?: string;
}

interface Cluster {
  representative: Candidate;
  members: Candidate[];
  titleTokens: Set<string>;
  simhash: bigint | null;
}

function buildCandidate(raw: RawResult): Candidate | null {
  const title = cleanTitle(raw.title);
  const snippet = cleanSnippet(raw.snippet, title);
  const url = canonicalizeUrl(raw.url);
  if (!url) return null;
  return {
    title,
    url,
    snippet,
    source: raw.source ? normalizeText(raw.source) : undefined,
    publishedAt: raw.publishedAt,
    engines: new Set([raw.engine]),
    engineRanks: { [raw.engine]: raw.rank },
    flags: new Set(raw.flags ?? []),
    titleTokens: shingles(title),
    simhash: simHash64(`${title} ${snippet}`),
    ...(raw.redirectUrl ? { redirectUrl: raw.redirectUrl } : {}),
  };
}

function mergeIntoCluster(cluster: Cluster, candidate: Candidate): void {
  cluster.members.push(candidate);
  const rep = cluster.representative;
  for (const engine of candidate.engines) rep.engines.add(engine);
  for (const [engine, rank] of Object.entries(candidate.engineRanks)) {
    if (rank === undefined) continue;
    const key = engine as EngineName;
    const current = rep.engineRanks[key];
    rep.engineRanks[key] = current === undefined ? rank : Math.min(current, rank);
  }
  for (const flag of candidate.flags) rep.flags.add(flag);
  if (candidate.snippet.length > rep.snippet.length) rep.snippet = candidate.snippet;
  if (!rep.source && candidate.source) rep.source = candidate.source;
  if (candidate.publishedAt && (!rep.publishedAt || candidate.publishedAt > rep.publishedAt)) {
    rep.publishedAt = candidate.publishedAt;
  }
  // 优先真实 URL，Baidu 跳转链只在没有真实 URL 时保留
  if (candidate.redirectUrl && !rep.redirectUrl) {
    // rep 已是真实 URL，无需处理
  } else if (!candidate.redirectUrl && rep.redirectUrl) {
    rep.url = candidate.url;
    rep.redirectUrl = undefined;
    rep.flags.delete('baidu-redirect');
  } else if (!candidate.redirectUrl && !rep.redirectUrl) {
    // 两个真实 URL 同一簇：保留更长摘要对应的 URL（rep 已保留）
  }
  cluster.titleTokens = new Set([...cluster.titleTokens, ...candidate.titleTokens]);
  if (cluster.simhash === null) cluster.simhash = candidate.simhash;
}

function buildCluster(candidate: Candidate): Cluster {
  return {
    representative: candidate,
    members: [candidate],
    titleTokens: new Set(candidate.titleTokens),
    simhash: candidate.simhash,
  };
}

function cloneCandidate(candidate: Candidate): Candidate {
  return {
    ...candidate,
    engines: new Set(candidate.engines),
    engineRanks: { ...candidate.engineRanks },
    flags: new Set(candidate.flags),
    titleTokens: new Set(candidate.titleTokens),
  };
}

/** 同簇内优先选择权威、非跳转、多引擎、摘要更长的代表 */
function candidateQuality(candidate: Candidate): number {
  const tier = sourceTier(hostnameOf(candidate.url));
  const tierScore = tier === 'high' ? 30 : tier === 'neutral' ? 20 : 0;
  return tierScore
    + candidate.engines.size * 3
    + (candidate.redirectUrl ? 0 : 2)
    + Math.min(candidate.snippet.length, 600) / 100;
}

/** 聚类完成后重选代表并合并全部成员（避免镜像站因多引擎命中抢占官方 URL） */
function consolidateCluster(cluster: Cluster): void {
  if (cluster.members.length <= 1) return;
  const candidates = [...cluster.members].sort((a, b) => candidateQuality(b) - candidateQuality(a));
  const chosen = candidates[0];
  if (!chosen) return;

  const merged = cloneCandidate(chosen);
  const temp: Cluster = {
    representative: merged,
    members: [],
    titleTokens: new Set(chosen.titleTokens),
    simhash: chosen.simhash,
  };
  for (const member of candidates) {
    if (member === chosen) continue;
    mergeIntoCluster(temp, member);
  }
  cluster.representative = temp.representative;
  cluster.titleTokens = temp.titleTokens;
  cluster.simhash = temp.simhash;
}

function shouldMerge(cluster: Cluster, candidate: Candidate): boolean {
  const rep = cluster.representative;
  if (rep.url === candidate.url) return true;
  const titleSim = jaccard(cluster.titleTokens, candidate.titleTokens);
  if (titleSim >= TITLE_SIMILARITY_THRESHOLD) return true;
  if (
    cluster.simhash !== null &&
    candidate.simhash !== null &&
    titleSim >= SIMHASH_TITLE_MIN_SIMILARITY &&
    hammingDistance(cluster.simhash, candidate.simhash) <= SIMHASH_HAMMING_THRESHOLD
  ) {
    return true;
  }
  return false;
}

// ============================================================================
// 主入口
// ============================================================================

export interface CleanOptions {
  /** 至少保留多少条（用于决定是否执行低相关过滤） */
  minKeep: number;
}

export interface CleanResult {
  items: SearchItem[];
  stats: CleanStats;
}

/** 清洗、去重、排序；返回稳定的池顺序 */
export function cleanResults(rawItems: readonly RawResult[], query: string, options: CleanOptions): CleanResult {
  const tokens = queryTokens(query);
  const candidates: Candidate[] = [];
  let dropped = 0;

  for (const raw of rawItems) {
    if (hardFilter(raw)) {
      dropped++;
      continue;
    }
    const candidate = buildCandidate(raw);
    if (!candidate) {
      dropped++;
      continue;
    }
    candidates.push(candidate);
  }

  const clusters: Cluster[] = [];
  for (const candidate of candidates) {
    let merged = false;
    for (const cluster of clusters) {
      if (shouldMerge(cluster, candidate)) {
        mergeIntoCluster(cluster, candidate);
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push(buildCluster(candidate));
  }

  const deduped = candidates.length - clusters.length;
  for (const cluster of clusters) consolidateCluster(cluster);

  interface ScoredItem extends SearchItem {
    queryCoverage: number;
  }

  const scored: ScoredItem[] = clusters.map((cluster) => {
    const rep = cluster.representative;
    const host = hostnameOf(rep.url);
    const coverage = combinedCoverage(rep.title, rep.snippet, tokens);

    let rrf = 0;
    for (const rank of Object.values(rep.engineRanks)) {
      if (rank === undefined) continue;
      rrf += 1 / (60 + rank);
    }
    const agreement = rep.engines.size;
    const score = rrf * (1 + 0.5 * Math.max(0, agreement - 1))
      + coverage * 0.01
      + (sourceTier(host) === 'high' ? 0.004 : sourceTier(host) === 'low' ? -0.004 : 0)
      + freshnessBoost(rep.publishedAt)
      - junkPenalty(host, new URL(rep.url).pathname, rep.snippet);

    return {
      title: rep.title,
      url: rep.url,
      snippet: rep.snippet,
      ...(rep.source ? { source: rep.source } : {}),
      ...(rep.publishedAt ? { publishedAt: rep.publishedAt } : {}),
      engines: Array.from(rep.engines),
      engineRanks: rep.engineRanks,
      score,
      ...(rep.flags.size > 0 ? { flags: Array.from(rep.flags) } : {}),
      queryCoverage: coverage,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // 低相关过滤：只有池充足时才丢弃，避免搜索结果被过度清洗成空
  let queryFiltered = 0;
  const minKeep = Math.max(1, options.minKeep);
  const lowCount = scored.filter((item) => item.queryCoverage < RELEVANCE_THRESHOLD).length;
  let kept = scored;
  if (scored.length - lowCount >= minKeep && lowCount > 0) {
    kept = scored.filter((item) => item.queryCoverage >= RELEVANCE_THRESHOLD);
    queryFiltered = lowCount;
  }

  // 域名多样性：同一 hostname 最多 2 条，超出者降序移到池尾（不删除，翻页仍可读）
  const perHost = new Map<string, number>();
  const primary: ScoredItem[] = [];
  const overflow: ScoredItem[] = [];
  for (const item of kept) {
    const host = hostnameOf(item.url);
    const count = perHost.get(host) ?? 0;
    if (count < DOMAIN_LIMIT) {
      perHost.set(host, count + 1);
      primary.push(item);
    } else {
      overflow.push(item);
    }
  }

  const items: SearchItem[] = [...primary, ...overflow].map(({ queryCoverage: _coverage, ...item }) => item);

  return {
    items,
    stats: {
      raw: rawItems.length,
      deduped,
      dropped,
      queryFiltered,
    },
  };
}
