// src/modules/tools/shared/agent-seed.ts
// agent/ 提示词目录播种 + 内容指纹自动迁移。
// 首次运行：从 <packageRoot>/agent/ 递归复制到 ~/.moss/agent/（含 prompt/ 与 documents/）。
// 已初始化：先清理废弃路径，再把旧布局（根级模块目录 / prompts/）迁入 prompt/，
// 最后逐文件内容指纹对比同步——用户未修改的文件自动升级到新版，
// 用户修改过的文件保留不动（内容哈希不匹配任何已知播种指纹）。
// 指纹记录：~/.moss/agent/.seed-manifest.json（path → 上次播种内容 sha256）。
// 失败不阻断启动（静默降级，调用方各自处理目录缺失场景）。
// 附带清理历史遗留：旧版 prompts/ 一层嵌套、早期误放入 main/ 子目录的提示词与已移除的 spec 目录（见 DEPRECATED_SEED_PATHS）。

import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Environment } from '../../../core/types';

/** 是否已执行过本次进程内的播种检查（幂等加速；stat 代价低，但避免重复日志/IO） */
let seeded = false;

/** 已知旧版种子内容指纹（relpath → sha256 列表）。 */
const LEGACY_MAIN_SYSTEM_HASHES: ReadonlyArray<string> = [
  '61a92fc6c815da130d26a3f17ebe0d87d954bb897f9eda175b6fd901659d64f0',
  'd56794dff898e11fe8fdaafbc8c6e196a8b62e5a99a939cb7cb4b31745b06bf8',
  // 二期版本（环境变量注入版）：rules 并入 system、环境信息迁往 env-context 前的形态
  '5008ed358b2239ceeab49d6ec42a31c8aec809e9f3ab08b6fcc402c1fe69bf54',
  // 二期落地版（rules 并入 + 环境信息迁 env-context）：三期新增语言思考/输出渲染段前的形态
  '83a6f4069fe6ca3c1849a29f3c171e13366204b842d4b0f022ab9af614c47169',
];

/** main/rules.md 历史种子哈希（内容已并入 system.md，仅用于迁移识别） */
const LEGACY_MAIN_RULES_HASHES: ReadonlyArray<string> = [
  '9a80c5af645cf3feffacf6cfe936349424c19085fa0cfff09c1659c799b91928',
  'afecb8d831bd60b5c9254def1e9baac7974989fa3481079c1d2e8c2114d8e48a',
  '166d069be3dd54329e74fd53a04e302b3de075cd0a7088f8970ab4bee3e3c5f7',
];

/**
 * 已知旧版种子内容指纹（relpath → sha256 列表）。
 * 用于 manifest 缺失时的首次迁移：目标内容命中任一旧指纹 = 用户未修改的旧版 → 升级。
 * 后续版本演进由 manifest 机制接管，新迁移时在此追加旧指纹即可。
 * 同时登记旧布局键与新布局键（prompt/...），覆盖「manifest 缺失 + 已完成目录迁移」场景。
 */
const LEGACY_SEED_HASHES: Readonly<Record<string, ReadonlyArray<string>>> = {
  'main/system.md': LEGACY_MAIN_SYSTEM_HASHES,
  'main/rules.md': LEGACY_MAIN_RULES_HASHES,
  'prompt/main/system.md': LEGACY_MAIN_SYSTEM_HASHES,
  'prompt/main/rules.md': LEGACY_MAIN_RULES_HASHES,
};

/** manifest 文件名（~/.moss/agent/ 下） */
const MANIFEST_FILE = '.seed-manifest.json';

/**
 * 已废弃的种子路径（relpath，相对 ~/.moss/agent/）。
 * 系统提示词加载器只读 main/*.md，早期版本误放进 main/ 子目录的提示词从未生效；
 * spec 功能已整体移除；rules.md 内容已并入 system.md（rules 解析段同步移除）；
 * base.md 已更名为 identity.md（identity 本就是加载器第二候选名）。
 * 启动播种时从用户目录清理残留（幂等）。
 */
const DEPRECATED_SEED_PATHS: ReadonlyArray<string> = [
  'main/system',
  'main/base',
  'main/base.md',
  'main/rule',
  'main/spec',
  'main/rules.md',
  // 提示词精简（去英文/去 fallback/合并 distill）：清理用户目录残留
  'agenteam/usage-en.md',
  // usage-zh.md 更名为 usage.md：清理用户目录旧文件（新文件由本次播种写入）
  'subagent/usage-zh.md',
  // agenteam 模块整体废弃：旧工具说明与模板目录迁往 subagent
  'agenteam',
  'fallback',
  'memory/distill-system.md',
];

/** 旧版提示词模块目录（相对 ~/.moss/agent/）：整体迁入 prompt/ 下 */
const LEGACY_PROMPT_DIRS: ReadonlyArray<string> = [
  'main',
  'subagent',
  'code-mode',
  'compact',
  'context',
  'heal',
  'insight',
  'mcp',
  'memory',
  'rules',
  'safety',
  'title',
  'tool-result',
  'translate',
];

interface SeedManifest {
  version: 1;
  /** relpath（posix）→ 上次播种内容 sha256 */
  files: Record<string, string>;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 递归枚举目录下所有文件的绝对路径 */
function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) {
          walk(full);
        } else {
          out.push(full);
        }
      } catch {
        // 单项失败忽略
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 单目录迁移：from/** → to/**（只复制目标不存在的文件，不覆盖新布局）。
 * 任一文件复制失败返回 false，调用方保留旧目录，下次启动重试。
 */
function migrateDirIfPossible(from: string, to: string): boolean {
  let ok = true;
  for (const file of listFilesRecursive(from)) {
    const rel = relative(from, file).split(sep).join('/');
    const target = join(to, ...rel.split('/'));
    try {
      if (existsSync(target)) continue;
      mkdirSync(join(target, '..'), { recursive: true });
      copyFileSync(file, target);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * 旧目录布局迁移：~/.moss/agent/{<module>,prompts}/** → ~/.moss/agent/prompt/**（保留用户改动）。
 * - 先迁根级旧模块目录（较新），再用历史 prompts/ 补缺；
 * - 目标文件已存在 → 跳过（新布局优先，不覆盖用户现有文件）；
 * - 全部复制成功后才删除旧目录；失败则保留，下次启动重试；
 * - 幂等：旧目录不存在时直接返回。
 */
function migrateLegacyPromptLayout(dest: string): void {
  const promptRoot = join(dest, 'prompt');

  for (const name of LEGACY_PROMPT_DIRS) {
    const legacy = join(dest, name);
    if (!existsSync(legacy) || !statSync(legacy).isDirectory()) continue;
    if (!migrateDirIfPossible(legacy, join(promptRoot, name))) continue;
    try {
      rmSync(legacy, { recursive: true, force: true });
    } catch {
      // 删除失败忽略（文件已迁移，下次启动重试清理）
    }
  }

  const legacyPrompts = join(dest, 'prompts');
  if (!existsSync(legacyPrompts)) return;
  if (!migrateDirIfPossible(legacyPrompts, promptRoot)) return;
  try {
    rmSync(legacyPrompts, { recursive: true, force: true });
  } catch {
    // 删除失败忽略（已迁移文件不受影响）
  }
}

/** 读取 manifest（缺失/损坏返回空 manifest） */
function readManifest(manifestPath: string): SeedManifest {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<SeedManifest>;
    if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') {
      return { version: 1, files: raw.files as Record<string, string> };
    }
  } catch {
    // 缺失/损坏：视为无记录
  }
  return { version: 1, files: {} };
}

/**
 * manifest 旧键重映射：旧模块键与历史 prompts/ 键 → prompt/ 前缀键。
 * 根模块键优先，prompts/ 只补缺，避免旧目录覆盖较新的根目录版本。
 */
function remapLegacyManifest(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, hash] of Object.entries(files)) {
    const legacyModule = LEGACY_PROMPT_DIRS.some((name) => rel.startsWith(`${name}/`));
    if (legacyModule) {
      const mapped = `prompt/${rel}`;
      if (!(mapped in out)) out[mapped] = hash;
      continue;
    }
    if (rel.startsWith('prompts/')) continue;
    out[rel] = hash;
  }
  for (const [rel, hash] of Object.entries(files)) {
    if (!rel.startsWith('prompts/')) continue;
    const mapped = `prompt/${rel.slice('prompts/'.length)}`;
    if (!(mapped in out)) out[mapped] = hash;
  }
  return out;
}

function writeManifest(manifestPath: string, manifest: SeedManifest): void {
  try {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch {
    // 写失败静默：下次启动会重走对比（幂等）
  }
}

/** 清理用户目录中已废弃的种子路径（幂等；单项失败不阻断，下次启动重试） */
function cleanupDeprecatedSeedPaths(dest: string): void {
  for (const rel of DEPRECATED_SEED_PATHS) {
    const target = join(dest, ...rel.split('/'));
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    } catch {
      // 单项失败忽略
    }
  }
}

/**
 * 播种内置 agent 提示词到 ~/.moss/agent/（带内容指纹自动迁移）。
 * 失败不阻断启动（静默降级，调用方各自处理目录缺失场景）。
 */
export function seedBuiltinAgentPrompts(env: Environment): boolean {
  if (seeded) return true;
  const src = join(env.packageRoot, 'agent');
  const dest = join(env.dataDir, 'agent');
  try {
    if (!existsSync(src)) {
      // 无种子源（异常安装），跳过；调用方回退到各自默认逻辑
      seeded = true;
      return false;
    }
    // 旧布局迁移在清理废弃路径之后执行，避免把历史误放入 main 子目录的内容搬进新布局
    if (!existsSync(dest)) {
      // 首次初始化：全量复制 + 记录 manifest
      cpSync(src, dest, { recursive: true });
      // 复制源可能是历史构建产物：先清理废弃路径，再把旧 prompts/ 层归位
      cleanupDeprecatedSeedPaths(dest);
      migrateLegacyPromptLayout(dest);
      const files: Record<string, string> = {};
      for (const file of listFilesRecursive(src)) {
        const rel = relative(src, file).split(sep).join('/');
        files[rel] = sha256(readFileSync(file));
      }
      writeManifest(join(dest, MANIFEST_FILE), { version: 1, files });
      seeded = true;
      return true;
    }

    // 已初始化：先清理历史遗留的废弃路径，再把旧布局迁入 prompt/，最后做逐文件内容指纹同步
    cleanupDeprecatedSeedPaths(dest);
    migrateLegacyPromptLayout(dest);
    const manifestPath = join(dest, MANIFEST_FILE);
    const oldManifest = readManifest(manifestPath);
    const previousFiles = remapLegacyManifest(oldManifest.files);
    const newFiles: Record<string, string> = {};
    for (const file of listFilesRecursive(src)) {
      const rel = relative(src, file).split(sep).join('/');
      const srcHash = sha256(readFileSync(file));
      const target = join(dest, ...rel.split('/'));
      let targetHash: string | null = null;
      try {
        if (existsSync(target)) {
          targetHash = sha256(readFileSync(target));
        }
      } catch {
        targetHash = null;
      }

      if (targetHash === null) {
        // 目标缺失 → 复制
        mkdirSync(join(target, '..'), { recursive: true });
        copyFileSync(file, target);
        newFiles[rel] = srcHash;
        continue;
      }
      if (targetHash === srcHash) {
        // 已最新
        newFiles[rel] = srcHash;
        continue;
      }
      const seededHash = previousFiles[rel];
      const legacyHashes = LEGACY_SEED_HASHES[rel];
      if (targetHash === seededHash || (legacyHashes && legacyHashes.includes(targetHash))) {
        // 目标 == 上次播种内容 / 已知旧版种子 → 用户未修改 → 升级为新版
        copyFileSync(file, target);
        newFiles[rel] = srcHash;
        continue;
      }
      // 用户修改过 → 保留不动；manifest 不记该文件播种哈希（下次源再变仍判定为用户版）
    }
    writeManifest(manifestPath, { version: 1, files: newFiles });
    seeded = true;
    return true;
  } catch {
    // 播种失败不阻断，返回 false 让调用方走兜底
    return false;
  }
}
