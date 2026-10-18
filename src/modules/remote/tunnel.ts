// src/modules/remote/tunnel.ts
// cloudflared 快速隧道：把本机 MOSS server 暴露成公网 https URL（随机 trycloudflare 子域）。
// 按 MOSS 规范 TS 化。
//
// - 二进制解析四级回退：PATH 已装 → Termux($PREFIX/bin / pkg 安装) → ~/.moss/remote/bin/ 持久缓存
//   → 多镜像测速选源下载（GitHub 官方直连 + 国内加速源，取最快；大文件 8 段并发分块自适应）
// - 资产名按 OS 分别拼：Windows 为 *.exe；macOS 为 *.tgz（需解压）；Linux 为**裸二进制**（无扩展名）。
//   实测 cloudflared-linux-*.tgz 一律 404——用「os+arch+.tgz」通吃会让 Linux 永远下载失败
// - Termux/Android 必须走 `pkg install cloudflared`：官方 Linux 构建是 glibc，Android 用户态是
//   bionic libc，二进制根本跑不起来（No such file or directory / 崩溃）
// - 强制 --protocol http2（TCP 443）：国内网络常屏蔽 UDP 7844（QUIC）导致 error 1033
// - URL 正则排除 api. 保留子域（cloudflared 输出会先出现 API 注册地址）
// - 进程退出监听：隧道崩溃/被杀时把状态打回，别让 UI 永远显示"可用"

import { spawn, execSync } from 'node:child_process';
import { mkdir, access, chmod, rm, stat, rename, cp } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { githubAssetCandidates, cachedRankMirrors, mirrorLabel } from '../../utils/mirror';

/** 快速隧道 URL：https://<随机子域>.trycloudflare.com（负向前瞻排除保留子域 api.） */
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

/** cloudflared 官方发布资产根地址（各镜像源在此基础上加前缀，见 utils/mirror） */
const CLOUDFLARED_RELEASE_BASE =
  'https://github.com/cloudflare/cloudflared/releases/latest/download';

/** 隧道进度阶段（types.ts 的 TunnelPhase 子集；idle/error 不由进度回调发出） */
export type TunnelProgressPhase = 'downloading' | 'starting' | 'registering' | 'ready';
/** 进度回调：detail 省略时由 service 按阶段取默认文案 */
export type PhaseCallback = (phase: TunnelProgressPhase, detail?: string) => void;

/** 多线程分块下载的并发段数（Windows 官方源单线程 ~200KB/s，8 并发 ≈ 1.6MB/s） */
const PARALLEL_SEGMENTS = 8;
/** 小于该字节数的文件不值得分块（直接单线程） */
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
/** 探针大小：单线程先下这么多测速 */
const PROBE_SIZE = 2 * 1024 * 1024;
/** 探针测速阈值（bytes/ms）：低于它认为慢网络，切多线程（300KB/s = 0.3） */
const SLOW_SPEED_THRESHOLD = 0.3;

/** cloudflared 发布资产的目标平台（Android/Termux 不走此路径，走 Termux 仓库的 pkg 包） */
export type CloudflaredTarget = 'windows' | 'darwin' | 'linux';
export type CloudflaredArch = 'amd64' | 'arm64' | 'arm' | '386';

export interface CloudflaredAsset {
  target: CloudflaredTarget;
  /** 发布资产文件名 */
  asset: string;
  /** 落位后的扩展名（Windows 为 .exe，其余为 ''） */
  ext: string;
  /** 是否需解压（仅 macOS 的 .tgz） */
  needsExtract: boolean;
}

/** node 的 arch 名 → 发布资产用的 arch 名（ia32 = 386） */
const ARCH_ALIAS: Record<string, CloudflaredArch | undefined> = {
  x64: 'amd64',
  arm64: 'arm64',
  arm: 'arm',
  ia32: '386',
};

/**
 * 由 platform/arch 推导 cloudflared 发布资产（**实测清单，勿凭直觉改成「os+arch+.tgz」通吃**）：
 *   win32  : cloudflared-windows-{amd64|386}.exe   （官方无 windows-arm64 资产）
 *   darwin : cloudflared-darwin-{amd64|arm64}.tgz  （唯一需要解压的平台）
 *   linux  : cloudflared-linux-{amd64|arm64|arm|386}（裸二进制；cloudflared-linux-*.tgz 实测 404）
 * 不支持的组合（如 win32+arm64）返回 null，由调用方给出可操作的错误提示。
 */
export function cloudflaredAssetOf(platform: string, arch: string): CloudflaredAsset | null {
  const a = ARCH_ALIAS[arch];
  if (!a) return null;
  if (platform === 'win32') {
    if (a !== 'amd64' && a !== '386') return null;
    return { target: 'windows', asset: `cloudflared-windows-${a}.exe`, ext: '.exe', needsExtract: false };
  }
  if (platform === 'darwin') {
    if (a !== 'amd64' && a !== 'arm64') return null;
    return { target: 'darwin', asset: `cloudflared-darwin-${a}.tgz`, ext: '', needsExtract: true };
  }
  if (platform === 'linux') {
    return { target: 'linux', asset: `cloudflared-linux-${a}`, ext: '', needsExtract: false };
  }
  return null;
}

/**
 * 是否 Termux（Android 上的 Termux 终端）。
 * 只用 Termux 专有信号：proot-distro 内会继承 Termux 的 ANDROID_ROOT / ANDROID_DATA，
 * 用它们判定会把 glibc 发行版误判成 Termux——而发行版恰恰应当下载 glibc 二进制。
 */
export function isTermux(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TERMUX_VERSION) || (env.PREFIX ?? '').includes('com.termux');
}

/** Termux 中 cloudflared 的安装位置（pkg 装在 $PREFIX/bin） */
function termuxBinPath(env: NodeJS.ProcessEnv): string {
  return join(env.PREFIX ?? '/data/data/com.termux/files/usr', 'bin', 'cloudflared');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 合并多个分段文件为一个目标文件（顺序拼接后统一结束）。 */
async function mergeParts(partFiles: string[], dest: string): Promise<void> {
  const out = createWriteStream(dest);
  try {
    for (const f of partFiles) {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on('error', reject);
        rs.pipe(out, { end: false });
        rs.on('end', () => resolve());
      });
    }
  } finally {
    await new Promise<void>(r => out.end(() => r()));
  }
}

/**
 * 下载文件到 dest（自适应）：
 * 1. 服务器不支持 Range 或文件小 → 单线程；
 * 2. 单线程探针测速——速度够快 → 继续单线程；
 * 3. 探针速度低于阈值（慢网络）→ 丢弃探针，改 8 段并发分块。
 */
export async function downloadFile(
  url: string,
  dest: string,
  opts: { signal?: AbortSignal; segments?: number } = {},
): Promise<number> {
  const segments = opts.segments ?? PARALLEL_SEGMENTS;
  let head: Response | null = null;
  try {
    head = await fetch(url, { method: 'HEAD', signal: opts.signal });
  } catch {
    head = null;
  }
  const len = head ? Number(head.headers.get('content-length') || 0) : 0;
  const acceptsRanges = head
    ? String(head.headers.get('accept-ranges') || '').toLowerCase() === 'bytes'
    : false;

  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    const res = await fetch(url, { signal: opts.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    return len || 0;
  }

  // 探针测速
  const probeBytes = Math.min(PROBE_SIZE, len);
  const probeStart = Date.now();
  try {
    const probeRes = await fetch(url, { signal: opts.signal, headers: { Range: `bytes=0-${probeBytes - 1}` } });
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`);
    const probeBody = await probeRes.arrayBuffer();
    const probeMs = Date.now() - probeStart;
    const probeSpeed = probeMs > 0 ? probeBytes / probeMs : Infinity;
    if (probeMs < 500 || probeSpeed >= SLOW_SPEED_THRESHOLD) {
      // 够快 → 单线程下完剩余部分（探针字节已写入 dest）
      const w = createWriteStream(dest);
      await new Promise<void>((resolve, reject) => {
        w.on('error', reject);
        w.write(Buffer.from(probeBody));
        w.end(() => resolve());
      });
      const restRes = await fetch(url, { signal: opts.signal, headers: { Range: `bytes=${probeBytes}-${len - 1}` } });
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`);
      await pipeline(Readable.fromWeb(restRes.body as never), createWriteStream(dest, { flags: 'a' }));
      return len;
    }
    // 慢 → 丢弃探针，转分块并发
    await rm(dest, { force: true }).catch(() => {});
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    if (!/HTTP|fetch/i.test(String(err instanceof Error ? err.message : err))) throw err;
    // 探针 HTTP 错误（部分服务器 HEAD 与 GET 行为不一致）→ 直接分块
  }

  // 分块并发
  const parts: Array<{ start: number; end: number; file: string }> = [];
  const chunk = Math.ceil(len / segments);
  for (let i = 0; i < segments; i++) {
    const start = i * chunk;
    const end = i === segments - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(parts.map(async p => {
      const res = await fetch(url, { signal: opts.signal, headers: { Range: `bytes=${p.start}-${p.end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${p.start}-${p.end})`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(p.file));
    }));
    await mergeParts(parts.map(p => p.file), dest);
  } finally {
    await Promise.all(parts.map(p => rm(p.file, { force: true }).catch(() => {})));
  }
  return len;
}

/** 手动安装指引（自动下载全部失败时给出，按平台区分）。 */
function manualInstallHint(): string {
  if (process.platform === 'win32') return 'winget install cloudflared';
  if (process.platform === 'darwin') return 'brew install cloudflared';
  return '从 https://github.com/cloudflare/cloudflared/releases 下载对应 linux 资产';
}

async function downloadCloudflared(
  binPath: string,
  signal?: AbortSignal,
  onPhase?: PhaseCallback,
): Promise<string> {
  const target = cloudflaredAssetOf(process.platform, process.arch);
  if (!target) {
    throw new Error(
      `当前平台不受支持（${process.platform}/${process.arch}），无法自动获取 cloudflared。\n`
      + `请手动安装后重试：${manualInstallHint()}`,
    );
  }
  const { asset, ext, needsExtract } = target;
  const dir = dirname(binPath);
  const tmpFile = join(dir, 'cloudflared.download');
  const isWindows = target.target === 'windows';
  const assetUrl = `${CLOUDFLARED_RELEASE_BASE}/${asset}`;
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);

  // 测速选源：候选 = 官方直连 + 各国内加速源；返回已按「快 → 慢 → 失败」排序的全量列表
  const ranked = await cachedRankMirrors(
    `cloudflared:${asset}`,
    () => githubAssetCandidates(assetUrl),
    { signal },
  );
  const fastest = ranked.find(m => m.ok);
  if (fastest) {
    const kbps = Math.round((fastest.speed * 1000) / 1024);
    onPhase?.('downloading', `已测速选源：${mirrorLabel(fastest.url)}（${kbps} KB/s），开始下载 cloudflared…`);
  }

  let ok = false;
  let lastErr: unknown = null;
  for (const m of ranked) {
    try {
      await rm(tmpFile, { force: true }).catch(() => {});
      await downloadFile(m.url, tmpFile, { signal: fetchSignal });
      const st = await stat(tmpFile);
      if (st.size < 1024 * 1024) throw new Error(`文件异常小（${st.size} 字节），疑似镜像错误页`);
      ok = true;
      break;
    } catch (err) {
      lastErr = err;
      await rm(tmpFile, { force: true }).catch(() => {});
    }
  }
  if (!ok) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(
      `cloudflared 下载失败：所有镜像源都不通（最后错误：${msg}）。\n`
      + `可手动安装后重试：${manualInstallHint()}\n`
      + `或把对应发布资产（${asset}）放到缓存目录 ${dir} 后重试。`,
    );
  }

  const extracted = join(dir, `cloudflared${ext}`);
  if (!needsExtract) {
    // Windows .exe / Linux 裸二进制：下载即二进制，直接落位
    await rename(tmpFile, extracted).catch(async () => {
      await cp(tmpFile, extracted).catch(() => {});
    });
  } else {
    // 解压到独立临时子目录（避免 tgz 解压产物占用目标路径名）
    const extractDir = join(dir, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('tar', ['-xzf', tmpFile, '-C', extractDir], { stdio: 'ignore' });
        child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`cloudflared 解压失败（code=${code}）`))));
        child.once('error', reject);
      });
      const { readdir } = await import('node:fs/promises');
      let found: string | null = null;
      const direct = join(extractDir, `cloudflared${ext}`);
      try {
        if ((await stat(direct)).isFile()) found = direct;
      } catch {
        // 不存在
      }
      if (!found) {
        const verDir = join(extractDir, 'cloudflared');
        try {
          const vers = await readdir(verDir);
          for (const v of vers) {
            const bin = join(verDir, v, 'bin', `cloudflared${ext}`);
            try {
              if ((await stat(bin)).isFile()) {
                found = bin;
                break;
              }
            } catch {
              // 继续
            }
          }
        } catch {
          // 无此目录
        }
      }
      if (!found) throw new Error('cloudflared 解压成功但未找到二进制');
      if (found !== extracted) {
        await rename(found, extracted).catch(async () => {
          await cp(found, extracted).catch(() => {});
        });
      }
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!isWindows) await chmod(extracted, 0o755);
  await rm(tmpFile, { force: true }).catch(() => {});
  return extracted;
}

/** PATH 里是否已有 cloudflared。 */
function cloudflaredOnPath(): boolean {
  try {
    execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** in-flight 下载（单飞）：并发调用复用同一次，防止交错写入损坏文件。 */
let downloading: Promise<string> | null = null;

/** Termux：通过 pkg 安装 cloudflared（官方 glibc 构建在 Android 上跑不起来）。 */
async function installCloudflaredViaPkg(onPhase?: PhaseCallback, signal?: AbortSignal): Promise<void> {
  onPhase?.('downloading', 'Termux：正在通过 pkg 安装 cloudflared（不使用 glibc 二进制）…');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pkg', ['install', '-y', 'cloudflared'], { stdio: 'ignore' });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      finish(() => reject(new Error('已取消 | cancelled')));
    };
    child.once('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(() => reject(new Error(
        code === 'ENOENT' ? '找不到 pkg 命令（请确认运行在 Termux 内）' : `启动 pkg 失败：${err.message}`,
      )));
    });
    child.once('exit', code => {
      if (code === 0) finish(() => resolve());
      else finish(() => reject(new Error(`pkg install cloudflared 退出码 ${code}`)));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Termux 安装失败的统一可操作提示（不回退去下 glibc 二进制——下了也跑不起来）。 */
function termuxInstallError(reason: string): Error {
  return new Error(
    `Termux 安装 cloudflared 失败：${reason}\n`
    + '请手动执行：pkg update && pkg install -y cloudflared\n'
    + '若下载慢或失败：先执行 termux-change-repo（切清华/中科大等国内镜像）后重试。',
  );
}

/**
 * 拿一个可用的 cloudflared 路径。回退顺序：
 *   1) PATH 已装 → 'cloudflared'
 *   2) Termux → $PREFIX/bin/cloudflared；缺失则 pkg install（失败即抛可操作错误）
 *   3) 持久缓存（cacheDir）
 *   4) 多镜像测速选源下载
 */
export async function resolveCloudflared(
  opts: { cacheDir: string; onPhase?: PhaseCallback; signal?: AbortSignal },
): Promise<string> {
  if (cloudflaredOnPath()) return 'cloudflared';

  // Termux/Android：必须用 Termux 仓库的包；官方 Linux 资产是 glibc，Android 用户态是 bionic
  if (isTermux(process.env)) {
    const bin = termuxBinPath(process.env);
    try {
      await access(bin);
      return bin;
    } catch {
      // 未安装 → 走 pkg
    }
    try {
      await installCloudflaredViaPkg(opts.onPhase, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw err; // 主动取消：原样抛出
      throw termuxInstallError(err instanceof Error ? err.message : String(err));
    }
    if (cloudflaredOnPath()) return 'cloudflared';
    try {
      await access(bin);
      return bin;
    } catch {
      throw termuxInstallError('pkg 已执行但未找到 cloudflared 可执行文件');
    }
  }

  const target = cloudflaredAssetOf(process.platform, process.arch);
  if (!target) {
    throw new Error(
      `当前平台不受支持（${process.platform}/${process.arch}），无法自动获取 cloudflared。\n`
      + `请手动安装后重试：${manualInstallHint()}`,
    );
  }
  // 缓存命中：兼容本模块落位名与手动放置的官方资产原名
  const candidates = [...new Set([
    join(opts.cacheDir, `cloudflared${target.ext}`),
    join(opts.cacheDir, target.asset),
  ])];
  for (const bin of candidates) {
    try {
      await access(bin);
      return bin;
    } catch {
      // 继续找下一个
    }
  }
  opts.onPhase?.('downloading');
  await mkdir(opts.cacheDir, { recursive: true });
  if (!downloading) {
    downloading = downloadCloudflared(join(opts.cacheDir, `cloudflared${target.ext}`), opts.signal, opts.onPhase)
      .finally(() => {
        downloading = null;
      });
  }
  return downloading;
}

/** 隧道句柄 */
export interface QuickTunnel {
  url: string;
  kill(): void;
  /** 注册「进程已退出」回调，返回取消函数。 */
  onExit(cb: (code: number | null) => void): () => void;
}

/**
 * 启动 cloudflared 快速隧道，返回公网 URL。
 * @param opts.port    本机 MOSS server 端口（cloudflared 回连目标）
 * @param opts.cacheDir cloudflared 持久缓存目录（~/.moss/remote/bin）
 * @param opts.signal  取消信号（stopTunnel 用）
 * @param opts.onPhase 进度回调：downloading→starting→registering→ready
 */
export async function startQuickTunnel(opts: {
  port: number;
  cacheDir: string;
  signal?: AbortSignal;
  onPhase?: PhaseCallback;
}): Promise<QuickTunnel> {
  const bin = await resolveCloudflared({ cacheDir: opts.cacheDir, onPhase: opts.onPhase, signal: opts.signal });
  opts.onPhase?.('starting');
  // 强制 HTTP/2（TCP 443）而不是默认 QUIC（UDP 7844）：国内网络常屏蔽 UDP 导致 error 1033
  const child = spawn(
    bin,
    ['tunnel', '--url', `http://127.0.0.1:${opts.port}`, '--protocol', 'http2', '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let cleanup: (() => void) | null = null;
  let rejectErr: ((err: Error) => void) | null = null;

  // spawn 失败（缓存二进制损坏等）必须接住，否则 uncaughtException 崩宿主
  child.on('error', err => {
    cleanup?.();
    opts.onPhase?.('ready'); // 不再继续，交给 promise reject
    rejectErr?.(new Error(`cloudflared 启动失败：${err.message}（可删除缓存目录后重试）`));
  });
  opts.onPhase?.('registering');

  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    rejectErr = reject;
    const onData = (chunk: Buffer | string): void => {
      buf += String(chunk);
      const m = buf.match(QUICK_TUNNEL_URL_RE);
      if (m) {
        cleanup?.();
        opts.onPhase?.('ready');
        resolve(m[0]);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup?.();
      // 带上 cloudflared 输出尾段（stderr 常含具体原因），便于排查
      const tail = buf.trim().split(/\r?\n/).slice(-3).join('\n').trim();
      reject(new Error(`cloudflared 退出（code=${code}）${tail ? '：' + tail.slice(0, 500) : ''}`));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      // 摘掉监听后管道不再消费 → 64KB 缓冲填满会阻塞 cloudflared → 继续吞掉输出
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = (): void => {
      cleanup?.();
      child.kill();
      reject(new Error('已取消 | cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup?.();
      child.kill();
      reject(new Error(
        'cloudflared 启动超时（30s）——请检查是否开着代理/VPN（Clash 等 TUN 模式会掐断隧道连接），退出代理后重试',
      ));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });

  // 隧道进程运行中死亡（崩溃/被杀）→ 通知监听方（service 据此把状态打回 error）
  const exitListeners = new Set<(code: number | null) => void>();
  child.on('exit', code => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url,
    kill: () => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
    },
    onExit: cb => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}

/** 校验已知 cloudflared 缓存文件是否存在（状态快照用，不触发下载）。 */
export async function cloudflaredCached(cacheDir: string): Promise<boolean> {
  // Termux：pkg 装在 $PREFIX/bin（不计入缓存目录，但状态上等同"已就绪"）
  if (isTermux(process.env)) {
    try {
      await access(termuxBinPath(process.env));
      return true;
    } catch {
      // 继续查缓存目录
    }
  }
  const target = cloudflaredAssetOf(process.platform, process.arch);
  const names = new Set<string>(['cloudflared', 'cloudflared.exe']);
  if (target) {
    names.add(`cloudflared${target.ext}`);
    names.add(target.asset); // 手动放置的官方资产原名
  }
  for (const name of names) {
    try {
      await access(join(cacheDir, name));
      return true;
    } catch {
      // 下一个
    }
  }
  return false;
}
