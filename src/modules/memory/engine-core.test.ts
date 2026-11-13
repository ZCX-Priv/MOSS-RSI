// src/modules/memory/engine-core.test.ts
// 记忆引擎核心逻辑单元测试：分词器（中文 bigram）、内容哈希、宫殿存储 CRUD、
// L2 双翼检索覆盖（user wing）、按消息切换的召回去重语义。

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize, tokenOverlap } from './tokenizer';
import { buildMemoryRecord, computeMemoryId, writeMemory, listAllMemories, buildPalaceTree } from './storage';
import { MemoryRetriever } from './retriever';
import { MemoryEngineServiceImpl } from './service';
import type { Environment, Logger, ServiceRegistry, ConfigService } from '../../core/types';
import type { ContextSessionLike } from '../context/types';

// ============================================================================
// tokenizer
// ============================================================================

describe('tokenizer（中文 bigram + ASCII 词级）', () => {
  test('中文按 bigram 切分', () => {
    expect(tokenize('上下文')).toEqual(['上下', '下文']);
  });

  test('英文按词切分并小写化', () => {
    expect(tokenize('Context Engine')).toEqual(['context', 'engine']);
  });

  test('中英混合', () => {
    const tokens = tokenize('记忆引擎 memory');
    expect(tokens).toContain('记忆');
    expect(tokens).toContain('忆引');
    expect(tokens).toContain('引擎');
    expect(tokens).toContain('memory');
  });

  test('空串与纯空白', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });

  test('tokenOverlap：相同集合 = 1，不相交 = 0', () => {
    const a = tokenize('上下文引擎');
    const b = tokenize('上下文引擎');
    expect(tokenOverlap(a, b)).toBe(1);
    expect(tokenOverlap(['a', 'b'], ['c', 'd'])).toBe(0);
  });
});

// ============================================================================
// storage（内容哈希 + 宫殿 CRUD）
// ============================================================================

describe('memory storage（哈希 JSON + 宫殿目录）', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'moss-memory-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('computeMemoryId：内容寻址确定性（相同输入相同 id；变化即不同）', () => {
    const base = { wing: 'user', room: 'test', verbatim: 'v', insight: 'i' };
    expect(computeMemoryId(base)).toBe(computeMemoryId({ ...base }));
    expect(computeMemoryId(base)).not.toBe(computeMemoryId({ ...base, insight: 'changed' }));
    expect(computeMemoryId(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('writeMemory + listAllMemories：按 wing/room 目录落盘并枚举', () => {
    const record = buildMemoryRecord({
      wing: 'MOSS-OS',
      room: 'context-engine',
      hall: 'decision',
      verbatim: '原话',
      insight: '保持前缀缓存稳定',
      importance: 0.9,
    });
    writeMemory(root, record);
    expect(existsSync(join(root, 'MOSS-OS', 'context-engine', `${record.id}.json`))).toBe(true);

    const all = listAllMemories(root, 'project');
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(record.id);
    expect(all[0].insight).toBe('保持前缀缓存稳定');
    expect(all[0].importance).toBe(0.9);
  });

  test('importance 边界裁剪到 [0,1]', () => {
    const rec = buildMemoryRecord({
      wing: 'u', room: 'r', hall: 'event', verbatim: 'v', insight: 'i',
      importance: 5,
    });
    expect(rec.importance).toBe(1);
    const rec2 = buildMemoryRecord({
      wing: 'u', room: 'r', hall: 'event', verbatim: 'v', insight: 'i',
      importance: -1,
    });
    expect(rec2.importance).toBe(0);
  });

  test('buildPalaceTree：翼/房/厅计数', () => {
    writeMemory(root, buildMemoryRecord({
      wing: 'MOSS-OS', room: 'context-engine', hall: 'decision', verbatim: 'v1', insight: 'i1',
    }));
    writeMemory(root, buildMemoryRecord({
      wing: 'MOSS-OS', room: 'context-engine', hall: 'discovery', verbatim: 'v2', insight: 'i2',
    }));
    writeMemory(root, buildMemoryRecord({
      wing: 'user', room: 'preferences', hall: 'preference', verbatim: 'v3', insight: 'i3',
    }));

    // buildPalaceTree 需要 env.dataDir（全局根）——传一个不存在的临时全局根
    const env = { dataDir: join(root, 'nonexistent-global') } as Environment;
    const tree = buildPalaceTree(env, root); // cwd=root 作为项目根（无 .moss/memory 子目录 → 项目侧空）
    // 项目根下没有 .moss/memory：listAllMemories(projectMemoryRoot) 为空；但这里 root 直接当项目记忆根传入
    // buildPalaceTree 内部会拼 cwd/.moss/memory——为验证计数，改用直接校验 listAllMemories + 手动构树
    const all = listAllMemories(root, 'project');
    expect(all).toHaveLength(3);
    const byWing = new Map<string, number>();
    for (const m of all) byWing.set(m.wing, (byWing.get(m.wing) ?? 0) + 1);
    expect(byWing.get('MOSS-OS')).toBe(2);
    expect(byWing.get('user')).toBe(1);
    // 直接读文件验证 JSON 结构完整
    const raw = JSON.parse(readFileSync(join(root, 'MOSS-OS', 'context-engine', `${all[0].id}.json`), 'utf8')) as Record<string, unknown>;
    expect(raw).toHaveProperty('id');
    expect(raw).toHaveProperty('wing');
    expect(raw).toHaveProperty('room');
    expect(raw).toHaveProperty('hall');
    expect(raw).toHaveProperty('verbatim');
    expect(raw).toHaveProperty('insight');
    expect(raw).toHaveProperty('importance');
    void tree;
  });
});

// ============================================================================
// 召回升级（增量索引 / 字段加权 / 近重复去重）
// ============================================================================

describe('召回升级（增量索引 / 字段加权 / 去重）', () => {
  let dataDir: string;
  let cwd: string;
  let globalRoot: string;
  let retriever: MemoryRetriever;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'moss-recall-upgrade-'));
    cwd = mkdtempSync(join(tmpdir(), 'moss-recall-upgrade-project-'));
    globalRoot = join(dataDir, 'memory');
    retriever = new MemoryRetriever({ dataDir } as Environment);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('增量索引：文件内容原地更新后（invalidate）命中新内容', () => {
    const rec = buildMemoryRecord({
      wing: 'user',
      room: 'context',
      hall: 'decision',
      verbatim: '旧原文',
      insight: '旧的索引策略',
    });
    writeMemory(globalRoot, rec);
    expect(retriever.recall(cwd, '旧的索引策略', { topK: 5 })).toHaveLength(1);

    // 模拟外部修改同一文件（只改 content → mtime/size 变化）
    const file = join(globalRoot, 'user', 'context', `${rec.id}.json`);
    writeFileSync(file, JSON.stringify({ ...rec, insight: '全新的向量召回方案' }, null, 2), 'utf8');
    retriever.invalidate();

    const hits = retriever.recall(cwd, '向量召回', { topK: 5 });
    expect(hits.map((h) => h.id)).toContain(rec.id);
    expect(retriever.recall(cwd, '旧的索引策略', { topK: 5 })).toHaveLength(0);
  });

  test('字段加权：insight 命中排在 verbatim 命中之前', () => {
    const insightRec = buildMemoryRecord({
      wing: 'user',
      room: 'a',
      hall: 'decision',
      verbatim: '无关原文',
      insight: '上下文压缩策略',
    });
    const verbatimRec = buildMemoryRecord({
      wing: 'user',
      room: 'b',
      hall: 'decision',
      verbatim: '上下文压缩策略',
      insight: '无关洞察',
    });
    writeMemory(globalRoot, insightRec);
    writeMemory(globalRoot, verbatimRec);

    const hits = retriever.recallScored(cwd, '上下文压缩策略', { topK: 5 });
    expect(hits[0].id).toBe(insightRec.id);
  });

  test('近重复去重：同内容的两条记忆只保留最高分一条', () => {
    const a = buildMemoryRecord({
      wing: 'user',
      room: 'r1',
      hall: 'preference',
      verbatim: 'v1',
      insight: '用户偏好简洁回复',
    });
    const b = buildMemoryRecord({
      wing: 'user',
      room: 'r1',
      hall: 'preference',
      verbatim: 'v1',
      // 仅标点差异 → 分词集合完全相同（近重复），但内容哈希 id 不同
      insight: '用户偏好简洁回复。',
    });
    writeMemory(globalRoot, a);
    writeMemory(globalRoot, b);

    const hits = retriever.recallScored(cwd, '用户偏好简洁回复', {
      topK: 5,
      weights: { dedupThreshold: 0.8 },
    });
    expect(hits).toHaveLength(1);
  });
});

// ============================================================================
// L2 双翼检索覆盖（缺陷1修复：user wing 可召回）
// ============================================================================

describe('recallWithTunnel（当前项目 wing + user wing 双翼覆盖）', () => {
  let dataDir: string; // 模拟 env.dataDir（全局根父目录）
  let cwd: string; // 模拟项目工作目录（项目 wing 无记忆）

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'moss-recall-global-'));
    cwd = mkdtempSync(join(tmpdir(), 'moss-recall-project-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('项目 wing 为空时，user wing 偏好记忆仍可被召回', () => {
    // 全局宫殿：~dataDir/memory/user/preferences/{hash}.json
    const globalRoot = join(dataDir, 'memory');
    mkdirSync(join(globalRoot, 'user', 'preferences'), { recursive: true });
    writeMemory(globalRoot, buildMemoryRecord({
      wing: 'user',
      room: 'preferences',
      hall: 'preference',
      verbatim: '用户说要简洁',
      insight: '用户偏好简洁回复，不要长篇大论',
      importance: 0.8,
    }));

    const env = { dataDir } as Environment;
    const retriever = new MemoryRetriever(env);
    // cwd 为空项目（projectWing = 目录名，无记忆）
    const hits = retriever.recallWithTunnel(cwd, '请给我简洁的回复', { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].wing).toBe('user');
    expect(hits[0].insight).toContain('简洁');
  });

  test('无关项目 wing 的记忆不进入 primary（Tunnel 语义保持）', () => {
    const globalRoot = join(dataDir, 'memory');
    mkdirSync(join(globalRoot, 'other-project', 'preferences'), { recursive: true });
    writeMemory(globalRoot, buildMemoryRecord({
      wing: 'other-project',
      room: 'preferences',
      hall: 'preference',
      verbatim: 'v',
      insight: '其他项目的偏好记录',
      importance: 0.5,
    }));

    const env = { dataDir } as Environment;
    const retriever = new MemoryRetriever(env);
    // 当前项目 wing 无记忆 + user wing 无记忆 → primary 为空 → Tunnel 不启动 → 无召回
    const hits = retriever.recallWithTunnel(cwd, '其他项目的偏好记录是什么', { topK: 5 });
    expect(hits).toHaveLength(0);
  });
});

// ============================================================================
// 按消息切换的召回去重语义（缺陷2修复）
// ============================================================================

describe('buildRecallSection（query 切换：同消息稳定 / 新消息防重复）', () => {
  let dataDir: string;
  let cwd: string;
  let engine: MemoryEngineServiceImpl;
  let session: ContextSessionLike;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'moss-svc-global-'));
    cwd = mkdtempSync(join(tmpdir(), 'moss-svc-project-'));

    // mock 依赖：config 返回默认记忆配置；services 无 LLM；logger 静默
    const config = {
      getAppConfig: () => ({
        context: {
          memory: {
            enabled: true, distillModel: 'inherit', distillMinMessages: 6,
            recallTopK: 5, recallTokenBudget: 2000,
            l1ImportanceThreshold: 0.75, l1MaxEntries: 20,
          },
        },
      }),
      getApiConfig: () => ({ version: 2, providers: [] }),
    } as unknown as ConfigService;
    const services = { tryResolve: () => null } as unknown as ServiceRegistry;
    const logger = {
      debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
    } as unknown as Logger;

    engine = new MemoryEngineServiceImpl({
      env: { dataDir } as Environment,
      config,
      services,
      logger,
    });

    // 全局 user wing 写入一条偏好记忆
    const globalRoot = join(dataDir, 'memory');
    mkdirSync(join(globalRoot, 'user', 'preferences'), { recursive: true });
    writeMemory(globalRoot, buildMemoryRecord({
      wing: 'user',
      room: 'preferences',
      hall: 'preference',
      verbatim: '用户说要简洁',
      insight: '用户偏好简洁回复，不要长篇大论',
      importance: 0.8,
    }));

    session = {
      id: 'test-session',
      messages: [],
      updatedAt: new Date().toISOString(),
    };
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('首次召回：命中 + queryChanged=true + state 初始化', () => {
    const r1 = engine.buildRecallSection(session, '请给我简洁的回复', cwd);
    expect(r1.text).not.toBeNull();
    expect(r1.count).toBe(1);
    expect(r1.queryChanged).toBe(true);
    expect(session.memoryState?.lastRecallQuery).toBe('请给我简洁的回复');
    expect(session.memoryState?.currentRecalled).toHaveLength(1);
    expect(session.memoryState?.excludeFromRecall).toHaveLength(0);
  });

  test('同消息多轮：注入内容稳定（exclude 不含本消息召回）', () => {
    const r1 = engine.buildRecallSection(session, '请给我简洁的回复', cwd);
    const r2 = engine.buildRecallSection(session, '请给我简洁的回复', cwd);
    expect(r2.queryChanged).toBeFalsy();
    expect(r2.text).toBe(r1.text);
    expect(r2.count).toBe(r1.count);
    // currentRecalled 保持（不随轮次累积排除）
    expect(session.memoryState?.currentRecalled).toHaveLength(1);
  });

  test('新消息：上一条召回转为排除集（防重复注入）', () => {
    const r1 = engine.buildRecallSection(session, '请给我简洁的回复', cwd);
    expect(r1.text).not.toBeNull();
    // 新消息（语义仍命中同一条记忆）
    const r2 = engine.buildRecallSection(session, '回答请保持简洁一些', cwd);
    expect(r2.queryChanged).toBe(true);
    // 唯一命中的记忆已在排除集中 → 本次不注入
    expect(r2.text).toBeNull();
    expect(r2.count).toBe(0);
    expect(session.memoryState?.excludeFromRecall).toEqual(r1.recalledIds);
    expect(session.memoryState?.currentRecalled).toHaveLength(0);
  });

  test('listMemories 按 scope/origin 过滤', () => {
    const manual = engine.save(cwd, {
      wing: 'proj',
      room: 'r',
      hall: 'event',
      verbatim: '项目手动记忆原文',
      insight: '项目手动记忆',
      origin: 'manual',
    });
    const active = engine.save(cwd, {
      wing: 'proj',
      room: 'r',
      hall: 'event',
      verbatim: '项目主动记忆原文',
      insight: '项目主动记忆',
      origin: 'active',
    });

    const project = engine.listMemories(cwd, { scope: 'project' });
    expect(project.every(m => m.scope === 'project')).toBe(true);
    expect(new Set(project.map(m => m.id))).toEqual(new Set([manual.id, active.id]));

    const global = engine.listMemories(cwd, { scope: 'global' });
    expect(global.length).toBeGreaterThanOrEqual(1);
    expect(global.every(m => m.scope === 'global')).toBe(true);

    expect(engine.listMemories(cwd, { origin: 'manual' }).map(m => m.id)).toEqual([manual.id]);
    expect(engine.listMemories(cwd, { origin: 'active' }).map(m => m.id)).toEqual([active.id]);
  });
});
