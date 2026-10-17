// src/modules/context/compiler/view-builder.ts
// 消息视图构建（替代 agent/session.toUnifiedMessages）：
//   [静态 system 前缀] + [env-context 锚定消息] + [压缩摘要消息] + [未压缩消息尾部] + [ephemeral 尾部消息]
// 工具结果按 tool-pruner 微压缩（仅发送视图，session 原文不动）；
// skill message 模式的占位消息替换为注册表全文；发送前 pair-sanitize 最终配对修复。
// 溢出兜底：预算超限时从尾部保留（env/summary/rules/memory 锚定恒保留），alignWindowBoundaries 配对对齐。
// ephemeral 消息（L2 记忆召回）：仅本次请求视图、不持久化；插在消息流末尾——
// 保住 system+env+history 的前缀缓存命中，且近因注意力聚焦召回内容（规避 lost-in-the-middle）。

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { UnifiedImage, UnifiedMessage } from '../../llm/types';
import type {
  ContextBreakdown,
  ContextMessage,
  ContextSessionLike,
  ToolPruningConfig,
} from '../types';
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateTextBytes,
  estimateMessageBytes,
} from '../budgeter/estimator';
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

/**
 * 该消息携带的**图片**路径（role=user 取附件路径，role=tool 取工具结果图片路径；其余恒空）。
 * 只保留扩展名受支持的图片路径——非图片附件（mp4/pdf 等）从不内联为 base64，
 * 因此不参与字节核算，也不出现在「已发送」占位符里。
 */
function messageImagePaths(m: ContextMessage): string[] {
  if (m.role === 'user') return (m.attachments ?? []).filter(isImagePath);
  if (m.role === 'tool') return (m.images ?? []).filter(isImagePath);
  return [];
}

/**
 * 图片「已发送过」的占位提示（替代 base64 内联）。
 * 附原始路径 + 明确的重新查看方式：MOSS 只持久化路径、从不存 base64，
 * 原图始终在磁盘上，模型需要时可再用 read 工具读取该路径 → 首个方案天然无损。
 */
function imageSentPlaceholder(paths: readonly string[]): string {
  const list = paths.map(p => `- ${p}`).join('\n');
  return `\n\n[图片已于此前发送过，为控制请求体体积此处以占位符替代（不再内联 base64）。原始文件仍在：\n${list}\n如需重新查看，请用 read 工具读取对应路径]`;
}

/** 图片路径 → base64 内联后的预估字节（内存缓存；读不到/超限被跳过记 0，以免阻断或高估） */
const imageBytesCache = new Map<string, number>();
function imagePathBytes(p: string): number {
  const cached = imageBytesCache.get(p);
  if (cached !== undefined) return cached;
  let bytes = 0;
  try {
    const size = statSync(p).size;
    // 与 readImages 口径对齐：超过单图上限的图片不会被内联发送 → 不计入字节预算
    bytes = size > MAX_IMAGE_BYTES ? 0 : Math.ceil(size / 3) * 4; // base64 膨胀率约 4/3
  } catch {
    bytes = 0;
  }
  imageBytesCache.set(p, bytes);
  return bytes;
}

/**
 * 单条消息的完整字节估算：文本部分（estimateMessageBytes，不含图片）
 * + 该消息图片按文件真实大小折算的 base64 字节。
 * 用于请求体字节预算（token 估算对图片不可见，必须单独按字节核算）。
 */
function messageBytes(m: ContextMessage): number {
  let total = estimateMessageBytes(m);
  for (const p of messageImagePaths(m)) total += imagePathBytes(p);
  return total;
}

export interface BuildViewOptions {
  toolPruning: ToolPruningConfig;
  /** skill 内容解析回调（message 模式占位替换 / system 模式由调用方拼进 staticSystemPrompt） */
  resolveSkillPrompt?: (name: string) => string | null;
  /** 溢出兜底预算（窗口 token；undefined = 不做兜底裁剪） */
  budgetTokens?: number;
  /** 请求体字节预算（序列化后字节；undefined = 不做字节兜底裁剪） */
  budgetBytes?: number;
  /** ephemeral 尾部消息（L2 记忆召回等；不持久化，追加在消息流末尾） */
  ephemeralMessages?: ContextMessage[];
}

export interface BuiltView {
  messages: UnifiedMessage[];
  breakdown: ContextBreakdown;
  /** 兜底裁剪丢弃的头部消息数（0 = 无兜底） */
  tailDropped: number;
  /** 本次发送视图的估算字节数（文本 UTF-8 + 图片 base64；含 system 前缀） */
  bytes: number;
  /**
   * 本轮「实际以 base64 发送了图片」的**原始 session 消息**引用。
   * 调用方（governor）据此写入 imagesSentAt 并持久化 → 下轮起这些图片降级为占位符。
   */
  imageMessagesToMark: ContextMessage[];
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

  // ===== 2. 视图消息准备（图片占位降级 + 微压缩 + skill 占位替换；全部新建对象不动原消息） =====
  // originalOf：视图对象 → 原始 session 消息。视图可能被复制（占位/修剪），
  // 而标记 imagesSentAt 必须落在原始 session 对象上才能持久化生效。
  const originalOf = new WeakMap<ContextMessage, ContextMessage>();
  const prepared: ContextMessage[] = visible.map(raw => {
    let next: ContextMessage = raw;

    // 2a. 图片已发送过 → 降级为占位符（剥离图片路径，避免下游读盘内联 base64）
    const imgPaths = messageImagePaths(raw);
    if (raw.imagesSentAt && imgPaths.length > 0) {
      next = {
        role: raw.role,
        content: `${raw.content}${imageSentPlaceholder(imgPaths)}`,
        ...(raw.toolCalls ? { toolCalls: raw.toolCalls } : {}),
        ...(raw.toolCallId ? { toolCallId: raw.toolCallId } : {}),
        ...(raw.name ? { name: raw.name } : {}),
        ...(raw.isError !== undefined ? { isError: raw.isError } : {}),
        ...(raw.metadata ? { metadata: raw.metadata } : {}),
        ...(raw.timestamp ? { timestamp: raw.timestamp } : {}),
        imagesSentAt: raw.imagesSentAt,
      };
    }

    // 2b. 工具结果微压缩（仅发送视图，session 原文不动）
    if (next.role === 'tool' && opts.toolPruning.enabled) {
      const pruned = pruneToolResultView(next.content, opts.toolPruning);
      if (pruned !== next.content) next = { ...next, content: pruned };
    }

    // 2c. skill message 模式占位消息 → 注册表全文
    if (next.role === 'system' && next.name === SKILL_INJECT_MSG_NAME && opts.resolveSkillPrompt) {
      const skillName =
        (next.metadata as { skillName?: string } | undefined)?.skillName ??
        /^# Active Skill: (.+)$/.exec(next.content)?.[1] ??
        session.activeSkill?.name;
      if (skillName) {
        const prompt = opts.resolveSkillPrompt(skillName);
        if (prompt) next = { ...next, content: `# Active Skill: ${skillName}\n\n${prompt}` };
      }
    }

    originalOf.set(next, raw);
    return next;
  });

  // ===== 2.5 ephemeral 尾部消息（L2 记忆召回等；不参与持久化/压缩/兜底裁剪） =====
  const ephemeral = opts.ephemeralMessages ?? [];

  // ===== 3. 溢出兜底裁剪（压缩失败/关闭时的最后防线；ephemeral 不参与裁剪） =====
  // 同时受 token 预算与请求体字节预算约束：图片 base64 对 token 估算不可见，
  // 只靠 token 预算会漏掉「字节已超限但 token 看起来正常」的图片型溢出（413 根因）。
  let tailDropped = 0;
  let windowed = prepared;
  if (opts.budgetTokens !== undefined || opts.budgetBytes !== undefined) {
    const systemTokens = estimateTextTokens(staticSystemPrompt);
    const ephemeralTokens = ephemeral.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const tokenBudget =
      opts.budgetTokens !== undefined
        ? opts.budgetTokens - systemTokens - ephemeralTokens - 500 // 500 token 余量
        : Number.POSITIVE_INFINITY;

    const systemBytes = estimateTextBytes(staticSystemPrompt);
    const ephemeralBytes = ephemeral.reduce((s, m) => s + messageBytes(m), 0);
    const byteBudget =
      opts.budgetBytes !== undefined
        ? opts.budgetBytes - systemBytes - ephemeralBytes - 2048 // 2 KiB 余量（JSON 结构开销）
        : Number.POSITIVE_INFINITY;

    const anchors = prepared.filter(isAnchorMessage);
    const anchorTokens = anchors.reduce((s, m) => s + estimateMessageTokens(m), 0);
    const anchorBytes = anchors.reduce((s, m) => s + messageBytes(m), 0);
    const rest = prepared.filter(m => !isAnchorMessage(m));

    // 保持相对顺序：锚定消息 + 从后往前保留的普通消息
    const keptRest: ContextMessage[] = [];
    let usedTokens = tokenBudget - anchorTokens;
    let usedBytes = byteBudget - anchorBytes;
    for (let i = rest.length - 1; i >= 0; i--) {
      const t = estimateMessageTokens(rest[i]);
      const b = messageBytes(rest[i]);
      // 至少保留 1 条普通消息（避免空尾部）；否则任一预算超限即停止
      if ((usedTokens - t < 0 || usedBytes - b < 0) && keptRest.length >= 1) break;
      keptRest.unshift(rest[i]);
      usedTokens -= t;
      usedBytes -= b;
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
  // 仅「尚未发送过」的消息会真正内联图片；已发送过的消息在步骤 2a 已降级为占位符（无路径）。
  const imageMessagesToMark: ContextMessage[] = [];
  const conversation: UnifiedMessage[] = full.map(m => {
    const paths = messageImagePaths(m);
    const { images, skipped } = readImages(paths);
    if (images.length > 0) {
      // 回填原始 session 消息（视图对象可能被复制，标记必须落在原始对象上）
      imageMessagesToMark.push(originalOf.get(m) ?? m);
    }
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

  // ===== 7. 请求体字节估算（文本 UTF-8 + 图片 base64；system 前缀计入） =====
  const bodyBytes =
    estimateTextBytes(staticSystemPrompt) + full.reduce((s, m) => s + messageBytes(m), 0);

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
    bytes: bodyBytes,
    imageMessagesToMark,
  };
}
