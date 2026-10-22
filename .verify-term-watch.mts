// 临时诊断：续行看门狗为何偶发不触发
import { TerminalManager } from './src/modules/terminal/service.ts';
import { isContinuationTail } from './src/modules/terminal/clean-output.ts';
import type { Logger } from './src/core/types.ts';

const silent = (): Logger => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return l;
    },
    setLevel() {},
  } as unknown as Logger;
  return l;
};
interface W {
  start: number;
  marker?: string;
}
interface RtView {
  buffer: string;
  waiters: Set<W>;
}
const mgr = new TerminalManager({
  emitter: () => {},
  logger: silent(),
  isWindows: process.platform === 'win32',
  dataDir: './.verify-plan-data',
});
const view = (id: string): RtView =>
  (mgr as unknown as { runtimes: Map<string, RtView> }).runtimes.get(id) as RtView;

const info = await mgr.create({ sessionId: 'watch', interpreter: 'powershell', cwd: process.cwd(), creator: 'ai' });
await mgr.run(info.id, 'Write-Output "warm"', 20_000);

for (let attempt = 0; attempt < 4; attempt++) {
  const rt = view(info.id);
  const p = mgr.run(info.id, 'if ($true) {', 8000);
  for (const ms of [600, 1200, 1400]) {
    await new Promise((r) => setTimeout(r, ms === 600 ? 600 : ms === 1200 ? 600 : 200));
    const w = [...rt.waiters][0];
    if (!w) break;
    console.log(
      `#${attempt} @${ms}`,
      JSON.stringify({
        tail: rt.buffer.slice(-80),
        cont: isContinuationTail(rt.buffer, w.start, 'powershell'),
        marker: w.marker,
      }),
    );
  }
  const t0 = Date.now();
  const res = await p;
  console.log(`#${attempt} result`, JSON.stringify({ syntax: res.syntaxIncomplete, done: res.completed, ms: Date.now() - t0 }));
}
mgr.disposeSession('watch');
process.exit(0);
