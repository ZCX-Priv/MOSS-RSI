// src/modules/remote/tunnel.test.ts
// cloudflared 资产名推导与 Termux 判定的纯函数单测（不 spawn、不触网）。

import { describe, test, expect } from 'vitest';
import { cloudflaredAssetOf, isTermux } from './tunnel';

describe('cloudflaredAssetOf：三端资产名', () => {
  test('Linux 为裸二进制（回归护栏：绝不能再拼 .tgz——实测 cloudflared-linux-*.tgz 一律 404）', () => {
    expect(cloudflaredAssetOf('linux', 'x64')).toEqual({
      target: 'linux',
      asset: 'cloudflared-linux-amd64',
      ext: '',
      needsExtract: false,
    });
    expect(cloudflaredAssetOf('linux', 'arm64')?.asset).toBe('cloudflared-linux-arm64');
    expect(cloudflaredAssetOf('linux', 'arm')?.asset).toBe('cloudflared-linux-arm');
    expect(cloudflaredAssetOf('linux', 'ia32')?.asset).toBe('cloudflared-linux-386');
    expect(cloudflaredAssetOf('linux', 'x64')?.asset.endsWith('.tgz')).toBe(false);
  });

  test('macOS 用 .tgz 且需要解压', () => {
    expect(cloudflaredAssetOf('darwin', 'x64')).toEqual({
      target: 'darwin',
      asset: 'cloudflared-darwin-amd64.tgz',
      ext: '',
      needsExtract: true,
    });
    expect(cloudflaredAssetOf('darwin', 'arm64')?.asset).toBe('cloudflared-darwin-arm64.tgz');
    // macOS 无 32 位 ARM 发布资产（Apple Silicon 一律 arm64）
    expect(cloudflaredAssetOf('darwin', 'arm')).toBeNull();
  });

  test('Windows 用 .exe 且无需解压；无 arm64 资产', () => {
    expect(cloudflaredAssetOf('win32', 'x64')).toEqual({
      target: 'windows',
      asset: 'cloudflared-windows-amd64.exe',
      ext: '.exe',
      needsExtract: false,
    });
    expect(cloudflaredAssetOf('win32', 'ia32')?.asset).toBe('cloudflared-windows-386.exe');
    expect(cloudflaredAssetOf('win32', 'arm64')).toBeNull();
  });

  test('未知平台/架构返回 null', () => {
    expect(cloudflaredAssetOf('freebsd', 'x64')).toBeNull();
    expect(cloudflaredAssetOf('linux', 'mips')).toBeNull();
  });
});

describe('isTermux：只用 Termux 专有信号', () => {
  test('TERMUX_VERSION 或 PREFIX 含 com.termux 判定为 Termux', () => {
    expect(isTermux({ TERMUX_VERSION: '0.118' })).toBe(true);
    expect(isTermux({ PREFIX: '/data/data/com.termux/files/usr' })).toBe(true);
  });

  test('仅 ANDROID_ROOT / ANDROID_DATA 不判定为 Termux（proot 发行版会继承，误判会走错安装路径）', () => {
    expect(isTermux({ ANDROID_ROOT: '/system' })).toBe(false);
    expect(isTermux({ ANDROID_DATA: '/data' })).toBe(false);
    expect(isTermux({})).toBe(false);
  });
});
