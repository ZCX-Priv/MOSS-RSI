// src/modules/deferred-bundle.ts
// deferred 模块聚合入口（仅被 kernel 动态 import 一次）。
//
// 为什么聚合：11 个 deferred 模块若各自 dynamic import，会产生 11 次 chunk 打开/
// 模块解析开销（Windows 低配机 + 杀毒软件下每次可达数十毫秒）。
// 聚合为单个动态 chunk 后，启动期只需一次文件打开与一次模块图求值。

import type { Module } from '../core/types';
import remote from './remote';
import computer from './computer';
import browser from './browser';
import update from './update';
import voice from './voice';
import subagent from './subagent';
import im from './im';
import fileHistory from './file-history';
import daemon from './daemon';
import automation from './automation';
import migration from './migration';

export type DeferredModuleName =
  | 'remote'
  | 'computer'
  | 'browser'
  | 'update'
  | 'voice'
  | 'subagent'
  | 'im'
  | 'file-history'
  | 'daemon'
  | 'automation'
  | 'migration';

/** 模块名 → 工厂（与 MODULE_FACTORIES 的 name 一一对应） */
export const deferredFactories: Record<DeferredModuleName, () => Module> = {
  remote,
  computer,
  browser,
  update,
  voice,
  subagent,
  im,
  'file-history': fileHistory,
  daemon,
  automation,
  migration,
};
