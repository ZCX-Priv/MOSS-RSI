// src/utils/pid.test.ts
// PID 身份校验回归测试。
//
// 背景：Windows 重启后 PID 号会被重新分配，残留 PID 文件里的号可能落到 svchost.exe 上。
// 旧实现只判「这个号有没有进程在跑」，于是把 svchost 当成活着的 MOSS，报「已在运行」，
// 并且 cmdStop 随之 taskkill /T /F 强杀系统服务（可能蓝屏）。
//
// 本测试全部为只读：不写真实 ~/.moss、不杀任何进程。

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyPid,
  parseTasklistCsv,
  inspectPid,
  writePidFile,
  readPidFile,
  currentProcessIdentity,
  type PidInfo,
} from './pid';

const NOW = Date.parse('2026-10-18T08:00:00.000Z');
const BOOT = Date.parse('2026-10-18T07:57:15.000Z');

function info(overrides: Partial<PidInfo> = {}): PidInfo {
  return {
    pid: 4242,
    // 开机之后启动：正常情形
    startedAt: '2026-10-18T07:59:00.000Z',
    ...overrides,
  };
}

describe('classifyPid：四种关键情形', () => {
  test('PID 不存在（查不到映像名）→ not-running', () => {
    const r = classifyPid(info(), null, BOOT, NOW);
    expect(r.alive).toBe(false);
    expect(r.isMoss).toBe(false);
    expect(r.reason).toBe('not-running');
  });

  test('PID 被 svchost.exe 占用 → image-mismatch，绝不算 MOSS', () => {
    const r = classifyPid(info({ pid: 1168 }), 'svchost.exe', BOOT, NOW);
    expect(r.alive).toBe(true);
    expect(r.isMoss).toBe(false);
    expect(r.reason).toBe('image-mismatch');
    expect(r.imageName).toBe('svchost.exe');
  });

  test('映像名是 bun.exe 但 startedAt 早于本次开机 → stale-across-boot', () => {
    // 重启后该号恰好又被 bun 占用，但记录是上辈子写的
    const r = classifyPid(info({ startedAt: '2026-10-17T20:00:00.000Z' }), 'bun.exe', BOOT, NOW);
    expect(r.alive).toBe(true);
    expect(r.isMoss).toBe(false);
    expect(r.reason).toBe('stale-across-boot');
  });

  test('映像名是 bun.exe 且 startedAt 在本次开机之后 → ok', () => {
    const r = classifyPid(info(), 'bun.exe', BOOT, NOW);
    expect(r.alive).toBe(true);
    expect(r.isMoss).toBe(true);
    expect(r.reason).toBe('ok');
  });
});

describe('classifyPid：边界与兼容', () => {
  test('映像名大小写不敏感', () => {
    expect(classifyPid(info(), 'BUN.EXE', BOOT, NOW).isMoss).toBe(true);
  });

  test('node.exe 也是合法宿主（构建产物兜底）', () => {
    expect(classifyPid(info(), 'node.exe', BOOT, NOW).isMoss).toBe(true);
  });

  test('其他系统进程（winlogon.exe）一律拒绝', () => {
    const r = classifyPid(info(), 'winlogon.exe', BOOT, NOW);
    expect(r.isMoss).toBe(false);
    expect(r.reason).toBe('image-mismatch');
  });

  test('开机时间不可用（返回 0）时跳过跨重启判定，不误杀正常 MOSS', () => {
    const r = classifyPid(info({ startedAt: '2020-01-01T00:00:00.000Z' }), 'bun.exe', 0, NOW);
    expect(r.isMoss).toBe(true);
  });

  test('startedAt 非法时不判定为过期（无法证明，保守放行）', () => {
    const r = classifyPid(info({ startedAt: 'not-a-date' }), 'bun.exe', BOOT, NOW);
    expect(r.isMoss).toBe(true);
  });

  test('容差内（开机前 1 秒）仍视为有效，吸收时钟抖动', () => {
    const startedAt = new Date(BOOT - 1000).toISOString();
    const r = classifyPid(info({ startedAt }), 'bun.exe', BOOT, NOW);
    expect(r.isMoss).toBe(true);
  });

  test('超出容差（开机前 10 秒）判定为跨重启残留', () => {
    const startedAt = new Date(BOOT - 10_000).toISOString();
    const r = classifyPid(info({ startedAt }), 'bun.exe', BOOT, NOW);
    expect(r.isMoss).toBe(false);
    expect(r.reason).toBe('stale-across-boot');
  });
});

describe('parseTasklistCsv：严格按前两列解析', () => {
  test('不会把内存列 "34,816 K" 里的 34 当成 PID', () => {
    const csv = '"svchost.exe","1168","Services","0","34,816 K"\r\n';
    const map = parseTasklistCsv(csv);
    expect(map.get(1168)).toBe('svchost.exe');
    expect(map.has(34)).toBe(false);
    expect(map.size).toBe(1);
  });

  test('多行输出全部正确解析', () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 K"',
      '"bun.exe","11312","Console","1","1,204,332 K"',
      '"node.exe","13252","Console","1","88,120 K"',
    ].join('\r\n');
    const map = parseTasklistCsv(csv);
    expect(map.get(11312)).toBe('bun.exe');
    expect(map.get(13252)).toBe('node.exe');
    // PID 0 不是有效进程，应被丢弃
    expect(map.has(0)).toBe(false);
  });

  test('无匹配的提示行（英文 / 中文）解析为空', () => {
    expect(parseTasklistCsv('INFO: No tasks are running which match the specified criteria.\r\n').size).toBe(0);
    expect(parseTasklistCsv('信息: 没有运行的任务匹配指定标准。\r\n').size).toBe(0);
  });

  test('空输入与纯空白不会抛错', () => {
    expect(parseTasklistCsv('').size).toBe(0);
    expect(parseTasklistCsv('\r\n\r\n').size).toBe(0);
  });
});

describe('inspectPid：真实进程只读探测', () => {
  test('不存在的 PID → not-running', () => {
    const r = inspectPid({ pid: 999999, startedAt: new Date().toISOString() });
    expect(r.isMoss).toBe(false);
    expect(r.reason).toBe('not-running');
  });

  test('当前测试进程自身 → 识别为 MOSS 宿主', () => {
    const identity = currentProcessIdentity();
    const r = inspectPid({
      pid: process.pid,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      ...identity,
    });
    expect(r.alive).toBe(true);
    expect(r.isMoss).toBe(true);
    expect(r.imageName?.toLowerCase()).toMatch(/^(bun|node)(\.exe)?$/);
  });

  test('真实的 svchost.exe PID → 必须被判为非 MOSS', () => {
    if (process.platform !== 'win32') return; // 仅在 Windows 上验证
    const listed = Bun.spawnSync({
      cmd: ['tasklist', '/FI', 'IMAGENAME eq svchost.exe', '/NH', '/FO', 'CSV'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const parsed = parseTasklistCsv(listed.stdout?.toString() ?? '');
    const firstPid = [...parsed.keys()][0];
    if (firstPid === undefined) return; // 环境异常则跳过，避免假失败

    // 关键断言：这正是线上事故的形态——PID 存在，但身份不是 MOSS
    const r = inspectPid({ pid: firstPid, startedAt: new Date().toISOString() });
    expect(r.alive).toBe(true);
    expect(r.imageName?.toLowerCase()).toBe('svchost.exe');
    expect(r.isMoss).toBe(false);
    expect(r.reason).toBe('image-mismatch');
  });
});

describe('PID 文件读写往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moss-pid-test-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('身份字段可完整落盘并读回', () => {
    const file = join(dir, 'nested', 'moss.pid');
    const payload: PidInfo = {
      pid: 1234,
      startedAt: new Date().toISOString(),
      port: 7766,
      imageName: 'bun.exe',
      execPath: 'C:\\bun\\bun.exe',
    };
    writePidFile(file, payload);
    expect(readPidFile(file)).toEqual(payload);
  });

  test('文件损坏时返回 null 而不抛错', () => {
    const file = join(dir, 'broken.pid');
    writePidFile(file, { pid: 1, startedAt: 'x' });
    Bun.write(file, '{ not json');
    expect(readPidFile(file)).toBeNull();
  });

  test('文件不存在时返回 null', () => {
    expect(readPidFile(join(dir, 'missing.pid'))).toBeNull();
  });
});
