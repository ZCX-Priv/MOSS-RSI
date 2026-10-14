// src/modules/context/compiler/view-builder.ts
// 消息视图构建（替代 agent/session.toUnifiedMessages）：
//   [静态 system 前缀] + [env-context 锚定消息] + [压缩摘要消息] + [未压缩消息尾部] + [ephemeral 尾部消息]
// 工具结果按 tool-pruner 微压缩（仅发送视图，session 原文不动）；
// skill message 模式的占位消息替换为注册表全文；发送前 pair-sanitize 最终配对修复。
// 溢出兜底：预算超限时从尾部保留（env/summary/rules/memory 锚定恒保留），alignWindowBoundaries 配对对齐。
// ephemeral 消息（L2 记忆召回）：仅本次请求视图、不持久化；插在消息流末尾——
// 保住 system+env+history 的前缀缓存命中，且近因注意力聚焦召回内容（规避 lost-in-the-middle）。

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { UnifiedImage, UnifiedMessage } from '../../llm/types';
import type {
  ContextBreakdown,
  ContextMessage,
  ContextSessionLike,
  ToolPruningConfig,
} from '../types';
import { estimateTextTokens, estimateMessageTokens } from '../budgeter/estimator';
import { sanitizeMessages, alignWindowBoundaries } from '../healer/pair-sanitize';
import { pruneToolResultView } from '../compressor/tool-pruner';
import { ENV_CONTEXT_MSG_NAME } from './env-context';

/** 摘要消息 name 标识（与 compressor 一致） */
export const COMPACTION_SUMMARY_MSG_NAME = 'compaction-summary';
/** skill message 模式占位消息 name（与 agent engine 一致） */
export const SKILL_INJECT_MSG_NAME = 'skill-inject';
/** 轮数触顶提示消息 name（agent engine 写入 session；纯 UI 展示，永不发给 LLM） */
export const MAX_TURNS_NOTICE_MSG_NAME = 'max-turns-notice';
/** 模型请求失败的错误消息 name（agent engine 写入 session；纯 UI 展示，永不发给 LLM） */
export const SYSTEM_ERROR_MSG_NAME = 'system-error';
/** paths 规则注入锚定消息 name（与 rules 模块一致；恒保留锚定） */
export const ACTIVE_RULES_MSG_NAME = 'active-rules';
/** L1 关键事实锚定消息 name（与 memory 模块一致；恒保留锚定） */
export const MEMORY_L1_MSG_NAME = 'memory-l1';
/** L2 记忆召回临时消息 name（ephemeral；仅本次请求视图） */
export const MEMORY_RECALL_MSG_NAME = 'memory-recall';

/** 单张图片大小上限（与主流 provider 限制对齐；超出跳过，避免单张巨图导致整轮请求失败） */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 扩展名 → MIME（仅主流视觉模型支持的格式）。
 * 不含 svg：主流视觉模型不支持 image/svg+xml，SVG 仍按文本处理。
 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 是否为可发送给模型的图片路径 */
function isImagePath(p: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME, extname(p).toLowerCase());
}

/**
 * 按路径实时读盘编码为多模态图片（base64；不落库，仅存在于本次请求视图）。
 * 过大的图片跳过并记入 skipped（调用方追加文本提示）；读盘失败静默跳过，不阻断整轮请求。
 */
function readImages(paths: readonly string[]): { images: UnifiedImage[]; skipped: string[] } {
  const images: UnifiedImage[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    if (!isImagePath(p)) continue;
    try {
      const buf = readFileSync(p);
      if (buf.length > MAX_IMAGE_BYTES) {
        skipped.push(p);
        continue;
      }
      images.push({ data: buf.toString('base64'), mimeType: IMAGE_MIME[extname(p).toLowerCase()], path: p });
    } catch {
      // 文件缺失/不可读：跳过该图
    }
  }
  return { images, skipped };
}

export interface BuildViewOptions {
  toolPruning: ToolPruningConfig;
  /** skill 内容解析回调（message 模式占位替换 / system 模式由调用方拼进 staticSystemPrompt） */
  resolveSkillPrompt?: (name: string) => string | null;
  /** 溢出兜底预算（窗口 token；undefined = 不做兜底裁剪） */
  budgetTokens?: number;
  /** ephemeral 尾部消息（L2 记忆召回等；不持久化，追加在消息流末尾） */
  ephemeralMessages?: ContextMessage[];
}

export interface BuiltView {
  messages: UnifiedMessage[];
  breakdown: ContextBreakdown;
  /** 兜底裁剪丢弃的头部消息数（0 = 无兜底） */
  tailDropped: number;
}

/** 是否为恒保留的锚定消息（env-context / 压缩摘要 / skill 注入占位 / 规则 / L1 记忆） */
function isAnchorMessage(m: ContextMessage): boolean {
  return (
    m.name === ENV_CONTEXT_MSG_NAME ||
    m.name === COMPACTION_SUMMARY_MSG_NAME ||
    m.name === SKILL_INJECT_MSG_NAME ||
    m.name === ACTIVE_RULES_MSG_NAME ||
    m.name === MEMORY_L1_MSG_NAME
  );
}

/**
 * 构建发送视图。
 * @param session 会话（鸭子类型；不被修改——视图对象全部新建）
 * @param staticSystemPrompt 静态系统提示词（可含 skill system 模式注入）
 */
export function buildRequestView(
  session: ContextSessionLike,
  staticSystemPrompt: string,
  opts: BuildViewOptions,
): BuiltView {
  // ===== 1. 可见消息（未软删、未压缩；触顶提示/系统错误消息纯 UI 不发 LLM） =====
  const visible = session.messages.filter(
    m =>
      !m.deletedAt &&
      !m.compacted &&
      m.name !== MAX_TURNS_NOTICE_MSG_NAME &&
      m.name !== SYSTEM_ERROR_MSG_NAME,
  );

  // ===== 2. 视图消息准备（微压缩 + skill 占位替换；全部新建对象不动原消息） =====
  const prepared: ContextMessage[] = visible.map(m => {
    if (m.role === 'tool' && opts.toolPruning.enabled) {
      const pruned = pruneToolResultView(m.content, opts.toolPruning);
      if (pruned !== m.content) {
        return { ...m, content: pruned };
      }
      return m;
    }
    if (m.role === 'system' && m.name === SKILL_INJECT_MSG_NAME && opts.resolveSkillPrompt) {
      const skillName =
        (m.metadata as { skillName?: string } | undefined)?.skillName ??
        /^# Active Skill: (.+)$/.exec(m.content)?.[1] ??
        session.activeSkill?.name;
      if (skillName) {
        const prompt = opts.resolveSkillPrompt(skillName);
        if (prompt) {
          return { ...m, content: `# Active Skill: ${skillName}\n\n${prompt}` };
        }
      }
    }
    return m;
  });

  // ===== 2.5 ephemeral 尾部消息（L2 记忆召回等；不参与持久化/压缩/兜底裁剪） =====
  const ephemeral = opts.ephemeralMessages ?? [];

  // ===== 3. 溢出兜底裁剪（压缩失败/关闭时的最后防线；ephemeral 不参与裁剪） =====
  let tailDropped = 0;
  let windowed = prepared;
  if (opts.budgetTokens !== undefined) {
    const systemTokens = estimateTextTokens(staticSystemPrompt);
    const ephemeralTokens = ephemeral.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const budget = opts.budgetTokens - systemTokens - ephemeralTokens - 500; // 500 token 余量
    const anchors = prepared.filter(isAnchorMessage);
    const anchorTokens = anchors.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const rest = prepared.filter(m => !isAnchorMessage(m));

    // 保持相对顺序：锚定消息 + 从后往前保留的普通消息
    const keptRest: ContextMessage[] = [];
    let used = budget - anchorTokens;
    for (let i = rest.length - 1; i >= 0; i--) {
      const t = estimateMessageTokens(rest[i]);
      if (used - t < 0 && keptRest.length >= 1) break;
      keptRest.unshift(rest[i]);
      used -= t;
    }
    tailDropped = rest.length - keptRest.length;

    // 锚定消息回插原位（按原 prepared 顺序重组）
    if (tailDropped > 0) {
      const keptSet = new Set(keptRest);
      windowed = prepared.filter(m => isAnchorMessage(m) || keptSet.has(m));
      // 开头孤立 tool 清理 + 配对对齐
      windowed = alignWindowBoundaries(windowed, windowed);
    }
  }

  // ===== 4. 发送前自愈：tool_use/tool_result 配对完整性 =====
  const sanitized = sanitizeMessages(windowed);
  const full = [...sanitized.messages, ...ephemeral];

  // ===== 5. 转 UnifiedMessage =====
  // 多模态图片在此实时读盘编码（base64 不落库，仅存在于本次请求视图）；
  // user 消息取附件路径，tool 消息取工具结果携带的图片路径。
  const conversation: UnifiedMessage[] = full.map(m => {
    const paths = m.role === 'user' ? m.attachments ?? [] : m.role === 'tool' ? m.images ?? [] : [];
    const { images, skipped } = readImages(paths);
    const content =
      skipped.length > 0 ? `${m.content}\n\n[图片过大已跳过: ${skipped.join(', ')}]` : m.content;
    return {
      role: m.role,
      content,
      ...(images.length > 0 ? { images } : {}),
      toolCallId: m.toolCallId,
      toolCalls: m.toolCalls?.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
      name: m.name,
    };
  });

  // ===== 6. token 构成分解 =====
  const systemTokens = estimateTextTokens(staticSystemPrompt);
  let envTokens = 0;
  let summaryTokens = 0;
  let historyTokens = 0;
  let rulesTokens = 0;
  let memoryTokens = 0;
  for (const m of full) {
    const t = estimateMessageTokens(m);
    if (m.name === ENV_CONTEXT_MSG_NAME) envTokens += t;
    else if (m.name === COMPACTION_SUMMARY_MSG_NAME) summaryTokens += t;
    else if (m.name === ACTIVE_RULES_MSG_NAME) rulesTokens += t;
    else if (m.name === MEMORY_L1_MSG_NAME || m.name === MEMORY_RECALL_MSG_NAME) memoryTokens += t;
    else historyTokens += t;
  }

  return {
    messages: [{ role: 'system', content: staticSystemPrompt }, ...conversation],
    breakdown: {
      system: systemTokens,
      env: envTokens,
      summary: summaryTokens,
      history: historyTokens,
      rules: rulesTokens,
      memory: memoryTokens,
      total: systemTokens + envTokens + summaryTokens + historyTokens + rulesTokens + memoryTokens,
    },
    tailDropped,
  };
}
