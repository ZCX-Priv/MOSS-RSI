// src/modules/tools/terminal/raw-run.test.ts
// raw 非 PTY 执行：输出不折行、JSON 可解析、超时可控。

import { describe, expect, test } from 'bun:test';
import { runCommandRaw } from './raw-run';

const isWindows = process.platform === 'win32';

describe('runCommandRaw', () => {
  test.skipIf(!isWindows)('PowerShell 长行 JSON 不被折行', async () => {
    const command =
      "$o=[ordered]@{ver='10.0.19045'; user='赵晨旭'; disks=@('C:|181|43.9','D:|750.2|247.1')}; $o | ConvertTo-Json -Compress -Depth 5";
    const result = await runCommandRaw({ command, cwd: process.cwd(), timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split('\n').length).toBe(1);
    const parsed = JSON.parse(result.stdout) as { ver?: string; user?: string };
    expect(parsed.ver).toBe('10.0.19045');
    expect(parsed.user).toBe('赵晨旭');
  });

  test.skipIf(!isWindows)('200 字符单行输出', async () => {
    const result = await runCommandRaw({
      command: 'Write-Output ("x" * 200)',
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBe(200);
    expect(result.stdout.trim().split('\n').length).toBe(1);
  });

  test.skipIf(!isWindows)('超时会终止进程并返回 timedOut', async () => {
    const result = await runCommandRaw({
      command: 'Start-Sleep -Seconds 3',
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});
