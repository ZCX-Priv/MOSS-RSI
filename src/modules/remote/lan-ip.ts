// src/modules/remote/lan-ip.ts
// 局域网 IPv4 智能选择：手机与电脑连同一网络时，选出手机最可能可达的本机地址。
// 按 MOSS 规范 TS 化。
//
// os.networkInterfaces() 枚举顺序不可靠：Windows 上 Radmin VPN / Tailscale / vEthernet
// 等虚拟网卡常排在 WLAN 前面，直接取第一张非回环网卡会生成手机打不开的二维码。
// 打分规则：RFC1918 私网地址 +100；名称像物理网卡 +20；像 VPN/虚拟网卡 -50。

import { networkInterfaces } from 'node:os';

/** RFC1918 私网地址（手机与电脑连同一局域网时通常可直连） */
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** 名称像真实物理网卡的接口（WLAN / Wi-Fi / Ethernet / 以太网 / en / eth …） */
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;

/** 常见的 VPN / 虚拟网卡名称（手机通常无法通过它们直连电脑） */
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge|hyper-v|loopback)/i;

interface IfaceAddress {
  family: string;
  address: string;
  internal: boolean;
}

/**
 * 从 networkInterfaces() 接口表里选出手机最可能可达的 IPv4。
 * 没有任何私网地址时回退到最高分地址（纯 VPN 环境仍可用）。
 */
export function selectLanIPv4(interfaces: Record<string, IfaceAddress[]>): string | null {
  const candidates: Array<{ ip: string; score: number; order: number }> = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      // 排除 loopback 与 link-local；其余地址即使不是私网（如 Radmin 的 26.x）也保留兜底
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;

      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;

      candidates.push({ ip, score, order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

/** 收集所有可手动选择的局域网/Tailnet 候选 IPv4（去重，保持枚举顺序）。 */
export function listLanCandidateIps(interfaces: Record<string, IfaceAddress[]>): string[] {
  const ips: string[] = [];
  for (const [, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}

/** 带缓存的候选列表（状态轮询频繁，不能每次都重新枚举网卡）。 */
export class LanIpExplorer {
  private cache: { at: number; ips: string[] } | null = null;
  private readonly cacheMs: number;

  constructor(cacheMs = 15_000) {
    this.cacheMs = cacheMs;
  }

  /** 自动选择最佳局域网 IPv4。 */
  async select(): Promise<string | null> {
    return selectLanIPv4(this.snapshot());
  }

  /** 候选列表（缓存 cacheMs）。 */
  async candidates(): Promise<string[]> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > this.cacheMs) {
      this.cache = { at: now, ips: listLanCandidateIps(this.snapshot()) };
    }
    return this.cache.ips;
  }

  private snapshot(): Record<string, IfaceAddress[]> {
    return networkInterfaces() as unknown as Record<string, IfaceAddress[]>;
  }
}

/** 简单 IPv4 格式校验（override 输入用） */
export function isValidIpv4(value: string): boolean {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}
