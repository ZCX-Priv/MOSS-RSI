// src/utils/mirror.ts
// 跨国下载的源注册表 + 自动测速选源（cloudflared 二进制 / sherpa 语音模型 / npm registry 复用）。
//
// 背景（本机实测）：
//   github：直连 github.com 常超时（曾 20s 超时），gh-proxy.com 实测 206 —— 故源池收敛为这两条；
//   npm：npmmirror.com 即淘宝/阿里云镜像（旧 registry.npm.taobao.org 证书已过期不可用），
//        中科大 npm 反代已于 2026-06-12 停服（mirrors.ustc.edu.cn/npm 404，旧地址 302 → npmmirror），
//        故均不收录；源池只保留实测可达者。
// 说明「公共加速源时效性波动极大」，所以候选源只能运行时测速 + 按序回退，而非写死一条链。
//
// 三条硬约束：
// 1. 绝不抛出：单个源探测失败只记录 error，由调用方按序回退；
// 2. 必须提前取消读取：部分代理不支持 Range，会以 200 返回整包（模型归档 >100MB），
//    读满 probeBytes 即 reader.cancel()，否则测速本身就会拉完整包；
// 3. 结果短时缓存 + 并发单飞：同一资产多次安装复用同一次测速，避免重复探针流量。

/** GitHub Release 资产代理前缀池：完整 URL = `${prefix}${githubUrl}`；'' = 官方直连 */
export const GITHUB_ASSET_MIRRORS: readonly string[] = [
  '', // 官方直连 github.com
  'https://gh-proxy.com/', // 本机实测 206，当前唯一稳定可用的国内加速源
];

/** npm registry 源（npmmirror 即淘宝/阿里云镜像；国内源优先） */
export const NPM_REGISTRIES: readonly string[] = [
  'https://registry.npmmirror.com', // 淘宝/阿里云镜像（现行域名）
  'https://registry.npmjs.org',
  'https://mirrors.cloud.tencent.com/npm', // 实测 200
];

export interface MirrorCandidate {
  /** 人类可读来源名（日志 / 进度文案用，如 'github.com' / 'gh-proxy.com'） */
  id: string;
  /** 完整可下载 URL */
  url: string;
}

export interface MirrorProbe extends MirrorCandidate {
  ok: boolean;
  /** 实际读取到的字节数 */
  bytes: number;
  /** 探测耗时（毫秒） */
  ms: number;
  /** 吞吐：bytes / ms（ok=false 时恒为 0） */
  speed: number;
  /** 失败原因（ok=true 时无此字段） */
  error?: string;
}

export interface ProbeOptions {
  /** 外部取消信号（stopTunnel / 安装中止） */
  signal?: AbortSignal;
  /** 单源最大读取字节数，默认 256KB */
  probeBytes?: number;
  /** 单源探测上限耗时（毫秒），默认 6000 */
  maxMs?: number;
  /** 排序口径：throughput（默认，二进制大文件）/ latency（小体积元数据） */
  metric?: 'throughput' | 'latency';
  /** 注入 fetch 实现（单测用；生产走全局 fetch） */
  fetchImpl?: typeof fetch;
}

const DEFAULT_PROBE_BYTES = 256 * 1024;
const DEFAULT_PROBE_MS = 6_000;
/** 测速结果缓存时长：同一资产 5 分钟内不重复探测 */
const CACHE_TTL_MS = 5 * 60 * 1_000;

/** URL 主机名（取不到则原样返回）；仅用于展示，不做任何安全判定 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 供日志/进度文案使用的简短来源名（官方直连会得到 'github.com'）。 */
export function mirrorLabel(url: string): string {
  return hostOf(url);
}

/**
 * GitHub 原始 URL → 各代理候选（含官方直连）。
 * 顺序与源池一致；同前缀去重（避免源池里重复前缀产生同一 URL）。
 */
export function githubAssetCandidates(githubUrl: string): MirrorCandidate[] {
  const seen = new Set<string>();
  const out: MirrorCandidate[] = [];
  for (const prefix of GITHUB_ASSET_MIRRORS) {
    const url = `${prefix}${githubUrl}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ id: hostOf(url), url });
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 探测单个候选源：ranged GET 读满 probeBytes 即取消；任何失败都收敛为 ok=false。 */
async function probeOne(
  cand: MirrorCandidate,
  opts: ProbeOptions & { probeBytes: number; maxMs: number },
): Promise<MirrorProbe> {
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.maxMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal;
  let bytes = 0;
  try {
    const res = await doFetch(cand.url, {
      signal,
      headers: { Range: `bytes=0-${opts.probeBytes - 1}` },
      redirect: 'follow',
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value ? chunk.value.byteLength : 0;
        if (bytes >= opts.probeBytes) break;
      }
    } finally {
      // 提前取消：不支持 Range 的源会以 200 返回整包，不取消就会把整包拉完
      await reader.cancel().catch(() => undefined);
    }
    const ms = Math.max(1, Date.now() - started);
    if (bytes === 0) throw new Error('空响应');
    return { ...cand, ok: true, bytes, ms, speed: bytes / ms };
  } catch (err) {
    return { ...cand, ok: false, bytes, ms: Math.max(1, Date.now() - started), speed: 0, error: errorText(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发探测全部候选并按优先级返回**全量有序**列表：
 * 可用（快 → 慢）→ 不可用（保持入参顺序）。调用方直接按序回退即可，无需自行过滤。
 */
export async function rankMirrors(
  cands: MirrorCandidate[],
  opts: ProbeOptions = {},
): Promise<MirrorProbe[]> {
  if (cands.length === 0) return [];
  const probeBytes = opts.probeBytes ?? DEFAULT_PROBE_BYTES;
  const maxMs = opts.maxMs ?? DEFAULT_PROBE_MS;
  const metric = opts.metric ?? 'throughput';
  const results = await Promise.all(cands.map(c => probeOne(c, { ...opts, probeBytes, maxMs })));
  const okList = results.filter(r => r.ok);
  const failList = results.filter(r => !r.ok);
  okList.sort((a, b) =>
    metric === 'latency' ? a.ms - b.ms || b.speed - a.speed : b.speed - a.speed || a.ms - b.ms,
  );
  return [...okList, ...failList];
}

interface CacheEntry {
  at: number;
  list: MirrorProbe[];
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<MirrorProbe[]>>();

/**
 * rankMirrors 的缓存版：同 key 命中缓存（TTL 5 分钟）或复用 in-flight Promise（并发单飞）。
 * 全部源失败时**不缓存**——避免死网络在 TTL 内被钉住而不再重试。
 */
export function cachedRankMirrors(
  key: string,
  build: () => MirrorCandidate[],
  opts: ProbeOptions = {},
): Promise<MirrorProbe[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.list);
  const running = inflight.get(key);
  if (running) return running;

  const p = rankMirrors(build(), opts)
    .then(list => {
      if (list.some(r => r.ok)) cache.set(key, { at: Date.now(), list });
      else cache.delete(key);
      return list;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** 清空测速缓存与单飞表（配置变更 / 单测隔离用）。 */
export function clearMirrorCache(): void {
  cache.clear();
  inflight.clear();
}
