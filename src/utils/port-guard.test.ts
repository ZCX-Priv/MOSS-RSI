// src/utils/port-guard.test.ts
// 端口占用解析回归：netstat 输出、CIM JSON 形状、僵尸 PID 判定。

import { describe, test, expect } from 'bun:test';
import { parseNetstatListeningPid, parseProcessInfoJson } from './port-guard';

const NETSTAT = [
  '活动连接',
  '',
  '  协议  本地地址          外部地址        状态           PID',
  '  TCP    127.0.0.1:7766    0.0.0.0:0       LISTENING       5244',
  '  TCP    127.0.0.1:7767    0.0.0.0:0       LISTENING       15064',
  '  TCP    127.0.0.1:64154   127.0.0.1:7766  ESTABLISHED     11380',
].join('\r\n');

describe('parseNetstatListeningPid', () => {
  test('只取监听行的 PID，不把已建立连接的 PID 当成监听者', () => {
    expect(parseNetstatListeningPid(NETSTAT, 7766)).toBe(5244);
    expect(parseNetstatListeningPid(NETSTAT, 7767)).toBe(15064);
    expect(parseNetstatListeningPid(NETSTAT, 9999)).toBeNull();
  });

  test('兼容 IPv6 方括号地址', () => {
    const out = '  TCP    [::1]:7766    [::]:0    LISTENING    42';
    expect(parseNetstatListeningPid(out, 7766)).toBe(42);
  });
});

describe('parseProcessInfoJson', () => {
  test('解析 PowerShell ConvertTo-Json 的进程信息', () => {
    const info = parseProcessInfoJson(
      JSON.stringify({
        ProcessId: 15064,
        ParentProcessId: 2820,
        Name: 'bun.exe',
        CommandLine: 'bun.exe run --watch src/main.ts start --foreground',
        CreationDate: '2026-11-02T13:19:07.000Z',
      }),
    );
    expect(info?.pid).toBe(15064);
    expect(info?.parentPid).toBe(2820);
    expect(info?.name).toBe('bun.exe');
    expect(info?.commandLine).toContain('src/main.ts');
  });

  test('空输出/非法 JSON 返回 null', () => {
    expect(parseProcessInfoJson('')).toBeNull();
    expect(parseProcessInfoJson('null')).toBeNull();
    expect(parseProcessInfoJson('{"ProcessId":0}')).toBeNull();
  });
});
