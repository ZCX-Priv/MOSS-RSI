// src/modules/context/compiler/view-builder.ts
// 消息视图构建（替代 agent/session.toUnifiedMessages）：
//   [静态 system 前缀] + [env-context 锚定消息] + [压缩摘要消息] + [未压缩消息尾部] + [ephemeral 尾部消息]
// skill message 模式的占位消息替换为注册表全文；发送前 pair-sanitize 最终配对修复。
//
// 图片策略（图片留存 + 旧图优先淘汰）：
//   - 图片默认**持续内联**（不再“发送一次即降级为路径”），使模型随时可见图内容；
//   - 当请求体字节超预算或图片总量超上限时，按「已看过(imagesSentAt)优先、旧者优先」淘汰，
//     未看过的新图不淘汰，且恒保留最新一张图片内联；
//   - 图片可用 governor 预计算的 optimizedImages（发送前压缩）替代磁盘原图。
// 溢出兜底：token/字节预算超限时从尾部保留（env/summary/rules/memory 锚定恒保留），alignWindowBoundaries 配对对齐。
// ephemeral 消息（L2 记忆召回）：仅本次请求视图、不持久化；插在消息流末尾——
// 保住 system+env+history 的前缀缓存命中，且近因注意力聚焦召回内容（规避 lost-in-the-middle）。

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { UnifiedImage, UnifiedMessage } from '../../llm/types';
import type {
  ContextBreakdown,
  ContextMessage,
  ContextSessionLike,
} from '../types';
import type { OptimizedImage } from './image-optimizer';
import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateTextBytes,
  estimateMessageBytes,
} from '../budgeter/estimator';
import { sanitizeMessages, alignWindowBoundaries } from '../healer/pair-sanitize';
import { renderRefTag, stripOwnRefTag } from '../refs';
import { ENV_CONTEXT_MSG_NAME } from './env-context';

/** 摘要消息 name 标识（与 compressor 一致） */
export const COMPACTION_SUMMARY_MSG_NAME = 'compaction-summary';
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
/** L1+L2 合并后的背景记忆消息 name（ephemeral；仅本次请求视图） */
export const MEMORY_CONTEXT_MSG_NAME = 'memory-context';

/** 单张图片大小上限（与主流 provider 限制对齐；超出跳过，避免单张巨图导致整轮请求失败） */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 扩展名 → MIME（仅主流视觉模型支持的格式）。
 * 不含 svg：主流视觉模型不支持 image/svg+xml，SVG 按文本/代码处理。
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
 * 图片被淘汰时的占位提示（替代 base64 内联）。
 * 附原始路径 + 明确的重新查看方式：MOSS 只持久化路径、从不存 base64，
 * 原图始终在磁盘上，模型需要时可再用 read 工具读取该路径。
 */
function imageSentPlaceholder(paths: readonly string[]): string {
  const list = paths.map(p => `- ${p}`).join('\n');
  return `\n\n[图片因请求体体积控制此处以占位符替代（不再内联 base64）。原始文件仍在：\n${list}\n如需重新查看，请用 read 工具读取对应路径]`;
}

/** 单张图片内联后的预估字节（优化结果优先；无优化则按文件大小折算 base64 膨胀） */
function imagePathBytes(p: string, optimized?: Map<string, OptimizedImage>): number {
  const opt = optimized?.get(p);
  if (opt) return Math.ceil(opt.bytes / 3) * 4;
  try {
    const size = statSync(p).size;
    // 与 readImages 口径对齐：超过单图上限的图片不会被内联发送 → 不计入字节预算
    return size > MAX_IMAGE_BYTES ? 0 : Math.ceil(size / 3) * 4; // base64 膨胀率约 4/3
  } catch {
    return 0;
  }
}

/**
 * 单条消息的完整字节估算：文本部分（estimateMessageBytes，不含图片）
 * + 该消息图片的 base64 字节（优化结果优先）。
 */
function messageBytes(
  m: ContextMessage,
  optimized?: Map<string, OptimizedImage>,
  includeThinking = false,
): number {
  let total = estimateMessageBytes(m, includeThinking);
  if (m.metadata?.imageEvicted === true) return total;
  for (const p of messageImagePaths(m)) total += imagePathBytes(p, optimized);
  return total;
}

/** 单条消息的内联图片字节（不含文本） */
function messageImageBytes(m: ContextMessage, optimized?: Map<string, OptimizedImage>): number {
  let total = 0;
  for (const p of messageImagePaths(m)) total += imagePathBytes(p, optimized);
  return total;
}

/**
 * 按路径读取图片为多模态内容（优化结果优先；否则磁盘原图）。
 * 过大的图片跳过并记入 skipped；读盘失败静默跳过，不阻断整轮请求。
 */
function readImages(
  paths: readonly string[],
  optimized?: Map<string, OptimizedImage>,
): { images: UnifiedImage[]; skipped: string[] } {
  const images: UnifiedImage[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    if (!isImagePath(p)) continue;
    const opt = optimized?.get(p);
    if (opt) {
      if (opt.bytes > MAX_IMAGE_BYTES) {
        skipped.push(p);
        continue;
      }
      images.push({ data: opt.data, mimeType: opt.mimeType, path: p });
      continue;
    }
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
  /**
   * 是否把 thinking 纳入发送视图与 token/字节核算。
   * - Anthropic：带签名时恒为 true；
   * - DeepSeek 思考模型：true（携带 tools 的请求必须完整回传历史 reasoning_content）；
   * - 其余 OpenAI 兼容：默认 false（仅 replayOpenAICompat 显式开启时为 true）。
   */
  includeThinking?: boolean;
  /** 溢出兜底预算（窗口 token；undefined = 不做兜底裁剪） */
  budgetTokens?: number;
  /** 请求体字节预算（序列化后字节；undefined = 不做字节兜底裁剪） */
  budgetBytes?: number;
  /** ephemeral 尾部消息（L2 记忆召回等；不持久化，追加在消息流末尾） */
  ephemeralMessages?: ContextMessage[];
  /** governor 预计算的图片优化结果（path → 优化结果）；缺失则读磁盘原图 */
  optimizedImages?: Map<string, OptimizedImage>;
  /** 图片淘汰策略（字节超预算/图片总量超限时生效）。protectUnseen=true 时未看过的新图不淘汰 */
  imageEviction?: { enabled: boolean; protectUnseen: boolean };
  /** 图片内联字节总量上限（0/undefined=不限制；超限也触发淘汰） */
  maxTotalImageBytes?: number;
  /**
   * 仅估算：跳过图片读盘与 base64 编码（图片字节仍按文件大小计入预算）。
   * 用于 governor 的预览视图——预览只需要 breakdown/bytes，不应付出两次图片编码成本。
   */
  skipImageEncoding?: boolean;
  /**
   * 是否给消息正文加 <acp tokens type>ref</acp> 标签（模型可见）。
   * 关闭时模型无法按 ref 指定压缩区间；工具调用参数永不加标签。
   */
  renderRefs?: boolean;
}

export interface BuiltView {
  messages: UnifiedMessage[];
  breakdown: ContextBreakdown;
  /** 兜底裁剪丢弃的头部消息数（0 = 无兜底） */
  tailDropped: number;
  /** 因图片淘汰而降级为占位符的图片张数 */
  evictedImages: number;
  /** 本次发送视图的估算字节数（文本 UTF-8 + 图片 base64；含 system 前缀） */
  bytes: number;
  /**
   * 本轮「实际以 base64 发送了图片」的**原始 session 消息**引用。
   * 调用方（governor）据此写入 imagesSentAt 并持久化 → 之后该图视为「已看过」，
   * 在字节超预算时优先被淘汰。
   */
  imageMessagesToMark: ContextMessage[];
}

/** 是否为恒保留的锚定消息（env-context / 压缩摘要 / 规则 / L1 记忆） */
function isAnchorMessage(m: ContextMessage): boolean {
  return (
    m.name === ENV_CONTEXT_MSG_NAME ||
    m.name === COMPACTION_SUMMARY_MSG_NAME ||
    m.name === ACTIVE_RULES_MSG_NAME ||
    m.name === MEMORY_L1_MSG_NAME
  );
}

/**
 * 构建发送视图。
 * @param session 会话（鸭子类型；不被修改——视图对象全部新建）
 * @param staticSystemPrompt 静态系统提示词
 */
export function buildRequestView(
  session: ContextSessionLike,
  staticSystemPrompt: string,
  opts: BuildViewOptions,
): BuiltView {
  const optimized = opts.optimizedImages;
  // keepAllThinking：是否保留全部历史 thinking（Anthropic / DeepSeek 思考模型）
  const keepAllThinking = opts.includeThinking === true;
  // 估算口径与实际保留内容一致（视图里只剩要发送的 thinking）
  const includeThinking = keepAllThinking;

  // ===== 1. 可见消息（未软删、未压缩；触顶提示/系统错误消息纯 UI 不发 LLM） =====
  const visible = session.messages.filter(
    m =>
      !m.deletedAt &&
      !m.compacted &&
      m.name !== MAX_TURNS_NOTICE_MSG_NAME &&
      m.name !== SYSTEM_ERROR_MSG_NAME &&
      // 旧版本把记忆注入成持久 user 消息（且可能落在用户请求之后）。
      // 现在记忆改为每轮 ephemeral 背景块；历史里的旧注入一律从发送视图剔除，
      // 避免旧会话继续把记忆当成尾随用户指令（「收到/明白」复现）。
      m.name !== MEMORY_L1_MSG_NAME &&
      m.name !== MEMORY_RECALL_MSG_NAME &&
      // 丢弃「只有 thinking、没有正文/工具调用/图片」的中断 assistant 消息：
      // thinking 被裁掉后会变成空 assistant 消息，DeepSeek 思考模式会因此报 400。
      !(
        m.role === 'assistant' &&
        m.content.trim() === '' &&
        !(m.toolCalls && m.toolCalls.length > 0) &&
        !(m.images && m.images.length > 0)
      ),
  );
  // ===== 2. 视图消息准备（全部新建对象不动原消息） =====
  // originalOf：视图对象 → 原始 session 消息。视图可能被复制（图片淘汰等），
  // 而标记 imagesSentAt 必须落在原始 session 对象上才能持久化生效。
  const originalOf = new WeakMap<ContextMessage, ContextMessage>();
  const prepared: ContextMessage[] = visible.map((raw) => {
    let next: ContextMessage = raw;

    // 2c. provider 不回传 thinking 时，从发送视图彻底移除（不只估算排除）：
    // OpenAI 兼容默认不回传 reasoning_content，若仍留在视图里，
    // 既不会被 provider 发送，又会让 breakdown/字节预算虚高。
    // DeepSeek 思考模型由调用方传 includeThinking=true（携带 tools 时必须全量回传历史思考）。
    if (!keepAllThinking && (next.thinking || next.thinkingSignature)) {
      next = { ...next, thinking: undefined, thinkingSignature: undefined };
    }

    originalOf.set(next, raw);
    return next;
  });

  // ===== 2.5 ephemeral 尾部消息（L2 记忆召回等；不参与持久化/压缩/兜底裁剪） =====
  const ephemeral = opts.ephemeralMessages ?? [];

  // ===== 3. 预算裁剪：token 尾部保留 → 图片淘汰 → 字节尾部裁剪 =====
  const systemTokens = estimateTextTokens(staticSystemPrompt);
  const ephemeralTokens = ephemeral.reduce((s, m) => s + estimateMessageTokens(m, includeThinking), 0);
  const tokenBudget =
    opts.budgetTokens !== undefined
      ? opts.budgetTokens - systemTokens - ephemeralTokens - 500 // 500 token 余量
      : Number.POSITIVE_INFINITY;

  const systemBytes = estimateTextBytes(staticSystemPrompt);
  const ephemeralBytes = ephemeral.reduce((s, m) => s + messageBytes(m, optimized, includeThinking), 0);
  const byteBudget =
    opts.budgetBytes !== undefined
      ? opts.budgetBytes - systemBytes - ephemeralBytes - 2048 // 2 KiB 余量（JSON 结构开销）
      : Number.POSITIVE_INFINITY;
  const imageTotalBudget =
    opts.maxTotalImageBytes !== undefined && opts.maxTotalImageBytes > 0
      ? opts.maxTotalImageBytes
      : Number.POSITIVE_INFINITY;

  let tailDropped = 0;
  let windowed = prepared;
  /** 被淘汰图片的消息（不再内联 base64，改占位符） */
  const evictedImagePaths = new Map<ContextMessage, string[]>();
  let evictedImages = 0;

  if (opts.budgetTokens !== undefined || opts.budgetBytes !== undefined || imageTotalBudget !== Number.POSITIVE_INFINITY) {
    const anchors = prepared.filter(isAnchorMessage);
    const anchorTokens = anchors.reduce((s, m) => s + estimateMessageTokens(m, includeThinking), 0);
    const anchorBytes = anchors.reduce((s, m) => s + messageBytes(m, optimized, includeThinking), 0);
    const rest = prepared.filter(m => !isAnchorMessage(m));

    // (A) token 尾部保留：从后往前累积，超 token 预算即停（至少保留 1 条普通消息）
    const keptRest: ContextMessage[] = [];
    let usedTokens = tokenBudget - anchorTokens;
    for (let i = rest.length - 1; i >= 0; i--) {
      const t = estimateMessageTokens(rest[i], includeThinking);
      if (usedTokens - t < 0 && keptRest.length >= 1) break;
      keptRest.unshift(rest[i]);
      usedTokens -= t;
    }
    tailDropped = rest.length - keptRest.length;
    windowed =
      tailDropped > 0
        ? prepared.filter(m => isAnchorMessage(m) || keptRest.includes(m))
        : prepared;
    if (tailDropped > 0) {
      // 开头孤立 tool 清理 + 配对对齐
      windowed = alignWindowBoundaries(windowed, windowed);
    }

    // (B) 图片淘汰：字节超预算或图片总量超限时，按「已看过优先、旧者优先」淘汰；
    //     未看过的新图不淘汰（保护），且恒保留最新一张图片内联。
    if (opts.imageEviction?.enabled !== false) {
      const imgBearing = windowed.filter(m => messageImagePaths(m).length > 0);
      const newest = imgBearing.length > 0 ? imgBearing[imgBearing.length - 1] : undefined;
      const protectUnseen = opts.imageEviction?.protectUnseen !== false;
      const candidates = imgBearing.filter(m => m !== newest);
      const seenOnes = candidates.filter(m => m.imagesSentAt);
      const unseenOnes = candidates.filter(m => !m.imagesSentAt);
      const evictOrder = protectUnseen ? seenOnes : [...seenOnes, ...unseenOnes];

      let inlineImgBytes = windowed.reduce((s, m) => s + messageImageBytes(m, optimized), 0);
      let totalBytes = windowed.reduce((s, m) => s + messageBytes(m, optimized, includeThinking), 0);

      for (const m of evictOrder) {
        const overBytes = totalBytes > byteBudget;
        const overImgCap = inlineImgBytes > imageTotalBudget;
        if (!overBytes && !overImgCap) break;
        const paths = messageImagePaths(m);
        if (paths.length === 0) continue;
        const removed = messageImageBytes(m, optimized);
        evictedImagePaths.set(m, paths);
        evictedImages += paths.length;
        inlineImgBytes -= removed;
        totalBytes -= removed;
      }

      // 重建 windowed：被淘汰的消息用占位符副本替换（不动原对象，保留 originalOf 语义）
      if (evictedImagePaths.size > 0) {
        windowed = windowed.map(m => {
          const paths = evictedImagePaths.get(m);
          if (!paths) return m;
          return {
            role: m.role,
            content: `${m.content}${imageSentPlaceholder(paths)}`,
            ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
            ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
            ...(m.name ? { name: m.name } : {}),
            ...(m.isError !== undefined ? { isError: m.isError } : {}),
            // 用元数据标记“图片已淘汰”，这样后续 sanitize/加 ref 标签产生副本时不会丢失状态
            metadata: { ...(m.metadata ?? {}), imageEvicted: true },
            ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            ...(m.thinking ? { thinking: m.thinking } : {}),
            ...(m.ref ? { ref: m.ref } : {}),
          };
        });
      }
    }

    // (C) 字节兜底尾部裁剪：图片淘汰后仍超字节预算 → 从头部丢消息（保留锚定与 ≥1 条普通消息）
    if (byteBudget !== Number.POSITIVE_INFINITY) {
      const currentBytes = windowed.reduce((s, m) => s + messageBytes(m, optimized, includeThinking), 0);
      if (currentBytes > byteBudget) {
        const anchorsW = windowed.filter(isAnchorMessage);
        const restW = windowed.filter(m => !isAnchorMessage(m));
        const keptW: ContextMessage[] = [];
        let usedBytes = byteBudget - anchorsW.reduce((s, m) => s + messageBytes(m, optimized, includeThinking), 0);
        for (let i = restW.length - 1; i >= 0; i--) {
          const b = messageBytes(restW[i], optimized, includeThinking);
          if (usedBytes - b < 0 && keptW.length >= 1) break;
          keptW.unshift(restW[i]);
          usedBytes -= b;
        }
        const extraDropped = restW.length - keptW.length;
        if (extraDropped > 0) {
          tailDropped += extraDropped;
          const keptSet = new Set(keptW);
          windowed = windowed.filter(m => isAnchorMessage(m) || keptSet.has(m));
          windowed = alignWindowBoundaries(windowed, windowed);
        }
      }
    }
  }

  // ===== 4. 发送前自愈：tool_use/tool_result 配对完整性 =====
  const sanitized = sanitizeMessages(windowed);
  // 4.5 消息引用标签（模型可见）：只加在正文前面，工具调用参数保持字节不变。
  // 标签是渲染态，不落盘；旧标签先剥离，保证重复渲染幂等。
  const tagged = sanitized.messages.map(m => {
    if (!opts.renderRefs || !m.ref) return m;
    const next: ContextMessage = {
      ...m,
      content: `${renderRefTag(m)}${stripOwnRefTag(m.content, m.ref)}`,
    };
    originalOf.set(next, originalOf.get(m) ?? m);
    return next;
  });
  // ephemeral 注入位置：最后一条「真实用户消息」之前。
  // 不能追加到消息流末尾——那样记忆/提醒会成为模型看到的最后一条 user 指令，
  // 模型会只回复「收到/明白」而不执行任务（长会话中的高频复现问题）。
  // 工具循环中最后一条消息是 tool 结果，插入到用户请求之前同样不会破坏 tool 配对。
  let insertAt = tagged.length;
  for (let i = tagged.length - 1; i >= 0; i -= 1) {
    const m = tagged[i];
    if (m.role === 'user' && !m.name) {
      insertAt = i;
      break;
    }
  }
  const full = [
    ...tagged.slice(0, insertAt),
    ...ephemeral,
    ...tagged.slice(insertAt),
  ];

  // ===== 5. 转 UnifiedMessage =====
  // 多模态图片在此实时读盘编码（base64 不落库，仅存在于本次请求视图）；
  // 优化结果优先（governor 预计算）；仅「尚未被淘汰」的消息真正内联图片。
  const imageMessagesToMark: ContextMessage[] = [];
  const conversation: UnifiedMessage[] = full.map(m => {
    const evicted = m.metadata?.imageEvicted === true;
    const paths = evicted ? [] : messageImagePaths(m);
    // 预览视图只估算：不读盘、不 base64；图片字节已由 messageBytes/stat 计入预算。
    const { images, skipped } = opts.skipImageEncoding
      ? { images: [] as UnifiedImage[], skipped: [] as string[] }
      : readImages(paths, optimized);
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
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.thinkingSignature ? { thinkingSignature: m.thinkingSignature } : {}),
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
  let envTokens = 0;
  let summaryTokens = 0;
  let historyTokens = 0;
  let rulesTokens = 0;
  let memoryTokens = 0;
  for (const m of full) {
    const t = estimateMessageTokens(m, includeThinking);
    if (m.name === ENV_CONTEXT_MSG_NAME) envTokens += t;
    else if (m.name === COMPACTION_SUMMARY_MSG_NAME) summaryTokens += t;
    else if (m.name === ACTIVE_RULES_MSG_NAME) rulesTokens += t;
    else if (
      m.name === MEMORY_L1_MSG_NAME ||
      m.name === MEMORY_RECALL_MSG_NAME ||
      m.name === MEMORY_CONTEXT_MSG_NAME
    ) {
      memoryTokens += t;
    }
    else historyTokens += t;
  }

  // ===== 7. 请求体字节估算（文本 UTF-8 + 图片 base64；system 前缀计入） =====
  const bodyBytes =
    estimateTextBytes(staticSystemPrompt) + full.reduce((s, m) => s + messageBytes(m, optimized, includeThinking), 0);

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
    evictedImages,
    bytes: bodyBytes,
    imageMessagesToMark,
  };
}

/**
 * 会话可见消息中的全部图片路径（去重）；供 governor 在构建视图前预优化。
 */
export function collectSessionImagePaths(session: ContextSessionLike): string[] {
  const out = new Set<string>();
  for (const m of session.messages) {
    if (m.deletedAt || m.compacted) continue;
    for (const p of messageImagePaths(m)) out.add(p);
  }
  return [...out];
}
