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
import * as tar from 'tar';
import type { VoiceModelDef } from './types';
import { githubAssetCandidates, cachedRankMirrors } from '../../utils/mirror';

/** 下载空闲超时（毫秒）：超过该时长无新数据即中止，交由下一镜像重试，避免永久挂起 */
const IDLE_TIMEOUT_MS = 30_000;

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
 * 下载并解压模型到 modelsRoot/<rootDir>。
 *
 * 原子性：先解压进临时目录，校验后再 rename 到最终位置——
 * 中途失败不会留下半成品模型目录（避免被 isInstalled 误判为已安装）。
 *
 * @param def 模型定义
 * @param modelsRoot 模型根目录（全部模型解压于此）
 * @param onProgress 进度 0..1
 * @returns 解压后的模型目录绝对路径
 */
export async function downloadAndExtract(
  def: VoiceModelDef,
  modelsRoot: string,
  onProgress?: (p: number) => void,
): Promise<string> {
  mkdirSync(modelsRoot, { recursive: true });
  const modelDir = join(modelsRoot, def.rootDir);
  const archivePath = join(modelsRoot, `${def.id}.tar.bz2`);
  const tmpDir = join(modelsRoot, `.tmp-${def.id}-${Date.now()}`);

  try {
    await downloadWithFallback(def.url, archivePath, def.sizeBytes, (p) => onProgress?.(p * 0.9));
    assertBzip2Archive(archivePath);
    mkdirSync(tmpDir, { recursive: true });
    await extractTarBz2(archivePath, tmpDir);

    const srcDir = resolveExtractedDir(tmpDir, def.rootDir);
    rmSync(modelDir, { recursive: true, force: true });
    renameSync(srcDir, modelDir);
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