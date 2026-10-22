// 临时诊断：判定慢命令走的是 OSC 兜底还是标记主路径
import { TerminalManager } from './src/modules/terminal/service.ts';
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
  marker?: string;
  fallbackMarker?: string;
  echoEnd?: number;
  start: number;
  command: string;
}
interface RtView {
  buffer: string;
  scanner: { count: number };
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

const ps = await mgr.create({ sessionId: 'slow3', interpreter: 'powershell', cwd: process.cwd(), creator: 'ai' });
await mgr.run(ps.id, 'cd $env:TEMP', 20_000);
await mgr.run(ps.id, 'Write-Output "AAA"', 20_000);
await mgr.run(ps.id, 'Write-Output "BBB"', 20_000);
await mgr.run(ps.id, 'Write-Output "CCC"', 20_000);

const rt = view(ps.id);
console.log('before slow: scanner.count=', rt.scanner.count, 'waiters=', rt.waiters.size);
const t0 = Date.now();
const p = mgr.run(ps.id, 'Start-Sleep -Milliseconds 1200; Write-Output "SLOW"', 20_000);
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 50));
  const w = [...rt.waiters][0];
  console.log(
    `+${Date.now() - t0}ms`,
    JSON.stringify({
      n: rt.waiters.size,
      marker: w?.marker,
      fallback: w?.fallbackMarker,
      echoEnd: w?.echoEnd,
      cmd: w?.command.slice(0, 12),
    }),
  );
}
const res = await p;
console.log('result:', JSON.stringify({ out: res.output, done: res.completed, code: res.exitCode }));
mgr.disposeSession('slow3');
process.exit(0);
