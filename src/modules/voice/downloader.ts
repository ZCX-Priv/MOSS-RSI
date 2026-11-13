// src/modules/voice/downloader.ts
// 模型归档下载与解压：流式写盘 + 进度回调 + 进程内 bzip2/tar 解包（跨平台）。
//
// 为什么不用系统 tar：Windows 自带的 bsdtar 未编译 bzip2 解码器（实测构建串
// `bsdtar 3.5.2 - libarchive 3.5.2 zlib/1.2.5.f-ipp`），执行 `tar -xjf` 会因
// `Can't initialize filter; unable to run program "bzip2 -d"` 直接退出码 1。
// 因此这里改用纯 JS 流式解包（unbzip2-stream + node-tar），不依赖任何外部可执行文件。
//
// 归档来自 GitHub Releases，体积较大，故下载与解包全程流式，避免整包驻留内存。

import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import unbzip2 from 'unbzip2-stream';
// 注意：tar 必须动态 import —— 静态 import 会把 node polyfill（约 944KB）拉进启动闭包。
import type { VoiceModelDef } from './types';
import { githubAssetCandidates, cachedRankMirrors } from '../../utils/mirror';
/** 下载空闲超时（毫秒）：超过该时长无新数据即中止，交由下一镜像重试，避免永久挂起 */
const IDLE_TIMEOUT_MS = 30_000;

/** HuggingFace 直链源（国内镜像优先；官方兜底） */
const HF_MIRRORS: readonly string[] = ['https://hf-mirror.com', 'https://huggingface.co'];

/** 直链文件并发数：3 路并行在带宽与对端限速之间最稳 */
const HF_FILE_CONCURRENCY = 3;

/** Silero VAD 模型下载地址（约 150~650KB，随上游导出版本变化，仅做最小体积校验） */
const VAD_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const VAD_MODEL_MIN_BYTES = 100_000;

/** 校验文件头是否为 bzip2 归档（魔数 "BZh"，避免镜像/网络返回错误页后误当归档解压） */
function assertBzip2Archive(file: string): void {
  const head = Buffer.alloc(3);
  const fd = openSync(file, 'r');
  try {
    const n = readSync(fd, head, 0, 3, 0);
    if (n < 3 || head.toString('latin1') !== 'BZh') {
      throw new Error('下载内容不是有效的 bzip2 归档（镜像/网络可能返回了错误页面）');
    }
  } finally {
    closeSync(fd);
  }
}

/** 流式下载归档到目标文件（带空闲超时与写流错误监听） */
async function downloadArchive(
  url: string,
  destFile: string,
  expectedBytes: number,
  onProgress?: (p: number) => void,
): Promise<void> {
  const ac = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
  };
  armIdle();

  let out: ReturnType<typeof createWriteStream> | null = null;
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!resp.ok || !resp.body) {
      throw new Error(`下载失败：HTTP ${resp.status}`);
    }
    const headerLen = Number(resp.headers.get('content-length') ?? '0');
    const total = headerLen > 0 ? headerLen : expectedBytes;

    const stream = createWriteStream(destFile);
    out = stream;
    // 写流出错时 write 回调可能永不触发 → 额外监听 error，防止永久挂起
    const writeError = new Promise<never>((_, reject) => {
      stream.once('error', reject);
    });
    writeError.catch(() => undefined); // 避免无人 await 时的未处理拒绝告警

    const reader = resp.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), writeError]);
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          stream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        }),
        writeError,
      ]);
      armIdle();
      if (total > 0) onProgress?.(Math.min(1, received / total));
    }

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      }),
      writeError,
    ]);
    out = null;

    if (received === 0) throw new Error('下载内容为空');
    if (headerLen > 0 && received !== headerLen) {
      throw new Error(`下载不完整（已接收 ${received} / 期望 ${headerLen} 字节）`);
    }
  } catch (err) {
    if (ac.signal.aborted) {
      throw new Error('下载超时（长时间无数据，已尝试切换镜像）');
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    // 异常路径：确保写流关闭，避免文件句柄泄漏
    if (out) {
      const pending = out;
      await new Promise<void>((resolve) => pending.end(() => resolve())).catch(() => undefined);
    }
  }
}

/**
 * 按测速结果依次尝试各源（快 → 慢 → 失败），任一成功即返回。
 * 源池 / 并发测速 / 排序统一在 utils/mirror：GitHub 直连在大陆常被重置、公共加速源又时好时坏，
 * 故由「写死前缀盲试」改为「运行时测速 + 从最快源下载 + 按序回退」。
 */
async function downloadWithFallback(
  url: string,
  destFile: string,
  expectedBytes: number,
  onProgress?: (p: number) => void,
): Promise<void> {
  const ranked = await cachedRankMirrors(
    `voice:${url}`,
    () => githubAssetCandidates(url),
    { probeBytes: 256 * 1024, maxMs: 6000 },
  );
  let lastError: unknown = null;
  for (const m of ranked) {
    try {
      onProgress?.(0); // 切换源：进度归零，避免停在高位后突然跳变
      await downloadArchive(m.url, destFile, expectedBytes, onProgress);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('下载失败（所有镜像源均不可用）');
}

/** 有限并发执行（保持结果顺序无关；任一失败即整体失败） */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(lanes);
}

/** HF 直链 URL（path 逐段编码，兼容带目录的文件） */
function hfFileUrl(base: string, repo: string, path: string): string {
  const encoded = path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${base}/${repo}/resolve/main/${encoded}`;
}

/**
 * 直链安装：按文件清单并发下载（预解压文件，无 bzip2 解压）。
 *
 * 原子性：全部文件落到 .tmp-<id> 后再 rename 到最终目录；
 * 单文件失败会在 HF 镜像间重试，全部失败由上层回退 GitHub 归档。
 */
async function downloadHfModel(
  def: VoiceModelDef,
  modelsRoot: string,
  onProgress?: (p: number) => void,
): Promise<string> {
  const hf = def.hf;
  if (!hf) throw new Error('模型缺少直链文件清单');
  const modelDir = join(modelsRoot, def.rootDir);
  const tmpDir = join(modelsRoot, `.tmp-${def.id}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const totalBytes = hf.files.reduce((sum, f) => sum + f.size, 0);
  const received = new Map<string, number>();
  const report = (): void => {
    if (totalBytes <= 0) return;
    let done = 0;
    for (const v of received.values()) done += v;
    onProgress?.(Math.min(0.99, done / totalBytes));
  };

  try {
    await runWithConcurrency(hf.files, HF_FILE_CONCURRENCY, async (file) => {
      const dest = join(tmpDir, file.path);
      let lastError: unknown = null;
      for (const base of HF_MIRRORS) {
        try {
          received.set(file.path, 0);
          report();
          await downloadArchive(
            hfFileUrl(base, hf.repo, file.path),
            dest,
            file.size,
            (p) => {
              received.set(file.path, p * file.size);
              report();
            },
          );
          const actual = statSync(dest).size;
          if (actual !== file.size) {
            throw new Error(`文件大小不符：${file.path}（${actual} / ${file.size}）`);
          }
          received.set(file.path, file.size);
          report();
          return;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`下载失败：${file.path}`);
    });

    rmSync(modelDir, { recursive: true, force: true });
    renameSync(tmpDir, modelDir);
    onProgress?.(1);
    return modelDir;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 下载 Silero VAD 模型（约 150~650KB）到指定目录；已存在且体积正常时直接返回。
 * 失败由调用方降级为 RMS 分段，不影响语音功能可用性。
 */
export async function downloadVadModel(dir: string): Promise<string> {
  const dest = join(dir, 'silero_vad.onnx');
  try {
    if (existsSync(dest) && statSync(dest).size >= VAD_MODEL_MIN_BYTES) return dest;
  } catch {
    // 忽略 stat 失败，继续重新下载
  }
  mkdirSync(dir, { recursive: true });
  const ranked = await cachedRankMirrors(
    'voice:silero_vad',
    () => githubAssetCandidates(VAD_MODEL_URL),
    { probeBytes: 128 * 1024, maxMs: 6000 },
  );
  let lastError: unknown = null;
  for (const m of ranked) {
    try {
      await downloadArchive(m.url, dest, VAD_MODEL_MIN_BYTES);
      return dest;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('VAD 模型下载失败（所有镜像源均不可用）');
}

/**
 * 进程内流式解压 .tar.bz2 到目标目录（跨平台，不依赖系统 tar 的 bzip2 支持）。
 *
 * node-tar 的 Parser 只鸭子类型实现了 write/end（并非 NodeJS.WritableStream），
 * 官方用法即 `readable.pipe(tar.x({ cwd }))`，故此处做一次窄化转型；
 * `finish` 事件在「解析结束且全部文件落盘」后才触发（Unpack 的 PENDING 计数）。
 */
async function extractTarBz2(archive: string, destDir: string): Promise<void> {
  const src = createReadStream(archive);
  const inflate = unbzip2();
  const tar = await import('tar');
  const unpack = tar.x({ cwd: destDir, preservePaths: false });

  await new Promise<void>((resolve, reject) => {
    src.once('error', reject);
    inflate.once('error', reject);
    unpack.once('error', reject);
    unpack.once('finish', () => resolve());
    src.pipe(inflate).pipe(unpack as unknown as NodeJS.WritableStream);
  });
}

/**
 * 在解压产物中定位模型目录：优先归档顶层目录名，其次唯一顶层目录，最后兜底用临时目录本身。
 * （不硬绑 def.rootDir：上游目录名漂移时仍可安装成功）
 */
function resolveExtractedDir(tmpDir: string, rootDir: string): string {
  const expected = join(tmpDir, rootDir);
  if (existsSync(expected) && statSync(expected).isDirectory()) return expected;
  const dirs = readdirSync(tmpDir).filter((name) => {
    try {
      return statSync(join(tmpDir, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length === 1) return join(tmpDir, dirs[0]);
  return tmpDir;
}

/**
 * 下载并安装模型到 modelsRoot/<rootDir>。
 *
 * 优先直链（HF 预解压文件，无需 bzip2 解压，安装速度最快）；
 * 直链全部失败时回退 GitHub tar.bz2（进程内流式解压）。
 *
 * 原子性：先落到临时目录，校验后再 rename 到最终位置——
 * 中途失败不会留下半成品模型目录（避免被 isInstalled 误判为已安装）。
 *
 * @param def 模型定义
 * @param modelsRoot 模型根目录
 * @param onProgress 下载进度 0..1
 * @param onDeployStart 归档模式下进入解压部署阶段时回调（供上层切换「部署中」状态）
 * @returns 模型目录绝对路径
 */
export async function downloadAndExtract(
  def: VoiceModelDef,
  modelsRoot: string,
  onProgress?: (p: number) => void,
  onDeployStart?: () => void,
): Promise<string> {
  mkdirSync(modelsRoot, { recursive: true });
  const modelDir = join(modelsRoot, def.rootDir);

  // 1) 直链安装（免解压）
  let hfError: unknown = null;
  if (def.hf) {
    try {
      return await downloadHfModel(def, modelsRoot, onProgress);
    } catch (err) {
      hfError = err;
    }
  }

  // 2) 归档兜底（GitHub Releases + 镜像测速）
  const archivePath = join(modelsRoot, `${def.id}.tar.bz2`);
  const tmpDir = join(modelsRoot, `.tmp-${def.id}-${Date.now()}`);

  try {
    try {
      await downloadWithFallback(def.url, archivePath, def.sizeBytes, (p) => onProgress?.(p * 0.9));
      assertBzip2Archive(archivePath);
      // 下载完成即进入部署（解压/校验/rename）：上层据此把状态切到「部署中」
      onDeployStart?.();
      mkdirSync(tmpDir, { recursive: true });
      await extractTarBz2(archivePath, tmpDir);

      const srcDir = resolveExtractedDir(tmpDir, def.rootDir);
      rmSync(modelDir, { recursive: true, force: true });
      renameSync(srcDir, modelDir);
    } catch (err) {
      if (hfError) {
        const hfMsg = hfError instanceof Error ? hfError.message : String(hfError);
        const arcMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`直链安装失败：${hfMsg}；归档安装失败：${arcMsg}`);
      }
      throw err;
    }
  } finally {
    // 无论成败都清理临时目录与归档（体积大）
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
  }

  if (!existsSync(modelDir)) {
    throw new Error(`解压后未找到模型目录：${modelDir}`);
  }
  onProgress?.(1);
  return modelDir;
}