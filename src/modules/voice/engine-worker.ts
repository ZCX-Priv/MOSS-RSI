// src/modules/voice/engine-worker.ts
// 语音识别 Worker：sherpa-onnx 的模型加载与解码全部在此线程执行。
//
// 背景：流式识别器 `new OnlineRecognizer(...)` 是同步原生调用（本机 5~6 秒）。
// 若在主线程执行，会冻结 HTTP/WS 与静态资源，导致后端重启后首次录音收不到音频。
// 本 Worker 复用 engine.ts 的进程内会话实现，主线程只负责消息转发与结果队列。

import { parentPort } from 'node:worker_threads';
import type { VoiceSession } from './types';
import {
  createLocalSessionInProcess,
  ensureLocalRecognizer,
  invalidateLocalRecognizer,
  loadSherpa,
  type LocalSessionInit,
  type SherpaModule,
  type VoiceWorkerEvent,
  type VoiceWorkerRequest,
} from './engine';

const port = parentPort;
if (!port) {
  throw new Error('engine-worker must be started as a worker thread');
}

interface WorkerSessionEntry {
  session: VoiceSession;
  timer: ReturnType<typeof setInterval>;
}

let sherpa: SherpaModule | null = null;
let currentInit: Omit<LocalSessionInit, 'vadModel'> | null = null;
const sessions = new Map<string, WorkerSessionEntry>();

/** 单次 tick 最多取出的结果数（与主线程 VoiceSessionHost 口径一致） */
const MAX_POLLS_PER_TICK = 8;
/** Worker 内解码驱动间隔（毫秒） */
const TICK_INTERVAL_MS = 80;

function post(event: VoiceWorkerEvent): void {
  port!.postMessage(event);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 初始化：加载运行时并创建/复用识别器（同步加载发生在 Worker 线程内） */
async function handleInit(req: Extract<VoiceWorkerRequest, { type: 'init' }>): Promise<void> {
  const startedAt = Date.now();
  try {
    const runtime = await loadSherpa();
    if (!runtime) throw new Error('sherpa-onnx runtime unavailable');
    sherpa = runtime;
    currentInit = {
      engine: req.engine,
      mode: req.mode,
      modelDir: req.modelDir,
      language: req.language,
      numThreads: req.numThreads,
    };
    // 只预热识别器，不创建会话
    await ensureLocalRecognizer(runtime, { ...currentInit, vadModel: null });
    post({ type: 'inited', elapsedMs: Date.now() - startedAt });
  } catch (err) {
    post({ type: 'init-error', error: errorText(err) });
  }
}

/** 创建会话并启动解码 tick */
async function handleStart(req: Extract<VoiceWorkerRequest, { type: 'start' }>): Promise<void> {
  if (!sherpa || !currentInit) {
    post({ type: 'start-error', sessionId: req.sessionId, error: 'voice worker not initialized' });
    return;
  }
  try {
    const session = await createLocalSessionInProcess(sherpa, {
      ...currentInit,
      vadModel: req.vadModel,
    });
    const timer = setInterval(() => {
      try {
        for (let i = 0; i < MAX_POLLS_PER_TICK; i++) {
          const result = session.poll();
          if (!result) break;
          post({ type: 'result', sessionId: req.sessionId, result });
        }
      } catch (err) {
        post({ type: 'error', sessionId: req.sessionId, error: errorText(err) });
      }
    }, TICK_INTERVAL_MS);
    sessions.set(req.sessionId, { session, timer });
    post({ type: 'started', sessionId: req.sessionId });
  } catch (err) {
    post({ type: 'start-error', sessionId: req.sessionId, error: errorText(err) });
  }
}

/** 结束会话：先冲刷已产出结果，再 finish 取尾部文本 */
async function handleStop(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) {
    post({ type: 'stopped', sessionId, final: null });
    return;
  }
  clearInterval(entry.timer);
  try {
    for (;;) {
      const result = entry.session.poll();
      if (!result) break;
      post({ type: 'result', sessionId, result });
    }
    const final = await entry.session.finish();
    post({ type: 'stopped', sessionId, final });
  } catch (err) {
    post({ type: 'stopped', sessionId, final: null });
    post({ type: 'error', sessionId, error: errorText(err) });
  }
}

/** 释放会话 */
function handleClose(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  clearInterval(entry.timer);
  entry.session.close();
  sessions.delete(sessionId);
}

/** 模型安装/卸载后清空 Worker 内识别器缓存 */
function handleReset(): void {
  for (const [id, entry] of sessions) {
    clearInterval(entry.timer);
    entry.session.close();
    sessions.delete(id);
    // 让主线程在途的 finish 立即结束，而不是等 15 秒超时
    post({ type: 'stopped', sessionId: id, final: null });
  }
  currentInit = null;
  invalidateLocalRecognizer();
}

port.on('message', (req: VoiceWorkerRequest) => {
  switch (req.type) {
    case 'init':
      void handleInit(req);
      return;
    case 'start':
      void handleStart(req);
      return;
    case 'audio':
      sessions.get(req.sessionId)?.session.acceptSamples(req.samples);
      return;
    case 'stop':
      void handleStop(req.sessionId);
      return;
    case 'close':
      handleClose(req.sessionId);
      return;
    case 'reset':
      handleReset();
      return;
    default:
      return;
  }
});

// Worker 内部异常不应静默：上报给主线程，由主线程决定回退
process.on('uncaughtException', (err) => {
  post({ type: 'error', error: `voice worker uncaught: ${errorText(err)}` });
});
process.on('unhandledRejection', (reason) => {
  post({ type: 'error', error: `voice worker unhandled: ${errorText(reason)}` });
});
