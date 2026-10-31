// webui/src/components/shared/mention-data.ts
// 输入框 / @ # 触发菜单的类型、触发解析与过滤工具。
// 数据源由调用方动态注入（commands/skills/agents/文件搜索 API），本模块不含静态数据。

import type { ComponentType } from 'react';
import { idbGetSync, idbSet } from '../../utils/idb';

export type MentionKind = 'command' | 'agent' | 'file';

/**
 * 菜单项图标组件。
 * lucide 图标组件天然满足；文件项由 `fileTypeIconComponent()` 包装 `FileTypeIcon`
 * （与附件卡片同源的 VS Code Material 图标主题，避免出现第二套文件图标）。
 */
export type MentionIconComponent = ComponentType<{ className?: string; size?: number }>;

/**
 * / 菜单的命令项类型：command（~/.moss/commands/）或 skill（~/.moss/skills/）。
 * 两者都通过 / 菜单调起、一次性注入（渲染后作为单条用户消息发送）。
 */
export type MentionCommandSource = 'command' | 'skill';

/** 分组 key，对应 i18n taskInput.mentionGroups.<group> */
export type MentionGroup = 'recent' | 'commands' | 'skills' | 'agents' | 'files';

export interface MentionItem {
  id: string;
  kind: MentionKind;
  group: MentionGroup;
  name: string;
  desc: string;
  icon: MentionIconComponent;
  /** 图标着色类（各项独立色彩；对彩色 Material 图标无着色作用） */
  iconClass: string;
  /** command/skill 项的注入载荷（选中时快照；发送时渲染 $ARGUMENTS） */
  data?: MentionChipData;
}

export type MentionTrigger = '/' | '@' | '#';

export interface TriggerMatch {
  kind: MentionKind;
  trigger: MentionTrigger;
  /** 触发符后的过滤关键字 */
  query: string;
  /** 触发符在文本中的下标（含触发符，删除区间起点） */
  tokenStart: number;
}

/** command/skill chip 载荷：选中时刻的注入快照 */
export interface MentionChipData {
  /** 来源体系：command（自定义命令）/ skill（技能） */
  source: MentionCommandSource;
  name: string;
  /** prompt 模板（可含 $ARGUMENTS 占位符） */
  prompt: string;
}

const TRIGGER_KIND: Record<MentionTrigger, MentionKind> = {
  '/': 'command',
  '@': 'agent',
  '#': 'file',
};

/**
 * 解析光标前最近一个 token：以 / @ # 开头（前面是行首或空白）则命中。
 * 返回 null 表示未命中（菜单应关闭）。
 */
export function detectTrigger(text: string, cursorPos: number): TriggerMatch | null {
  const before = text.slice(0, cursorPos);
  const m = /(^|\s)([/@#])([^\s/@#]*)$/.exec(before);
  if (!m) return null;
  const trigger = m[2] as MentionTrigger;
  const query = m[3];
  return {
    kind: TRIGGER_KIND[trigger],
    trigger,
    query,
    tokenStart: before.length - query.length - 1,
  };
}

// ============================================================================
// 内联 token（/ @ #）：编辑器 DOM ↔ 线格式文本的唯一真源
// ----------------------------------------------------------------------------
// 线格式 = 编辑器序列化文本 = 剪贴板文本 = 持久化的 content = LLM 可见文本：
//   command/skill → `/名称`    agent → `@名称`    file → `#<绝对路径>`
// 反解析只依赖两种确定依据：`#<…>` 定界符 + 已知名单（命令/技能/智能体）匹配，
// 不做裸文本模糊猜测（避免 http://、foo@bar.com、C# 被误判为 token）。
// ============================================================================

/** 编辑器内联 token 的三态联合类型 */
export type ComposerToken =
  | { kind: 'command'; source: MentionCommandSource; name: string }
  | { kind: 'agent'; id: string; name: string }
  | { kind: 'file'; path: string };

/**
 * 文件 token 线格式：`#<绝对路径>`。
 * `<>` 作定界符：Windows 路径不允许 `<>` 字符，且含空格的路径也能无损还原。
 */
export const FILE_TOKEN_RE = /#<([^<>\n]+)>/g;

/** token → 线格式文本 */
export function tokenWireText(token: ComposerToken): string {
  switch (token.kind) {
    case 'command':
      return `/${token.name}`;
    case 'agent':
      return `@${token.name}`;
    case 'file':
      return `#<${token.path}>`;
  }
}

/**
 * chip 视觉变体：skill 与 command 必须视觉可分（skill=蓝 / command=紫，与 / 菜单的
 * violet/blue 语义一致）；agent / file 直接沿用 kind。编辑器 chip 与消息气泡 chip 共用。
 */
export function chipVariant(token: ComposerToken): 'command' | 'skill' | 'agent' | 'file' {
  if (token.kind === 'command') return token.source === 'skill' ? 'skill' : 'command';
  return token.kind;
}

/** 线格式反解析所需的已知名单（由调用方从 store 注入，本模块不持有数据源） */
export interface MentionLookups {
  /** 自定义命令（含图标名，供 chip 图标与 / 菜单共用同一真源） */
  commands: Array<{ name: string; icon?: string }>;
  /** 技能 */
  skills: Array<{ name: string; icon?: string }>;
  agents: Array<{ id: string; name: string }>;
}

/** 从 store 数据构建名单（编辑器粘贴还原 / 气泡渲染 / 标题剥离共用一处口径） */
export function buildMentionLookups(
  commands: Array<{ name: string; enabled?: boolean; icon?: string }>,
  skills: Array<{ name: string; enabled?: boolean; icon?: string }>,
  agents: Array<{ id: string; name: string }>,
): MentionLookups {
  return {
    commands: commands
      .filter((c) => c.enabled !== false)
      .map((c) => ({ name: c.name, icon: c.icon })),
    skills: skills.filter((s) => s.enabled !== false).map((s) => ({ name: s.name, icon: s.icon })),
    agents: agents.map((a) => ({ id: a.id, name: a.name })),
  };
}

/** 命令/技能图标名反查（chip 图标用；粘贴还原出的 chip 也能拿到图标） */
export function findCommandIcon(
  lookups: MentionLookups,
  source: MentionCommandSource,
  name: string,
): string | undefined {
  const list = source === 'skill' ? lookups.skills : lookups.commands;
  return list.find((c) => c.name === name)?.icon;
}

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'token'; token: ComposerToken };

/** 正则转义（名称可能含 `-`、`.`、中文等，全部按字面量处理） */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 触发符 + 名称的交替匹配：长名在前（避免 `co` 抢先匹配 `commit`） */
function buildNameRe(names: string[], sigil: string): RegExp | null {
  const uniq = [...new Set(names.filter((n) => n.length > 0))].sort((a, b) => b.length - a.length);
  if (uniq.length === 0) return null;
  // 左边界 `^` 或空白（与 detectTrigger 的触发边界一致）；右边界不额外限定，
  // 由「最长已知名优先」保证不会切碎名称。
  return new RegExp(`(^|[\\s\\u00A0])${escapeRe(sigil)}(?:${uniq.map(escapeRe).join('|')})`, 'g');
}

/**
 * 线格式文本 → 片段序列（气泡渲染 / 粘贴还原共用）。
 * 优先级：文件定界符 > 命令/技能名 > 智能体名；三者互斥不重叠。
 */
export function parseMentionText(text: string, lookups: MentionLookups): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = segments[segments.length - 1];
    if (last && last.type === 'text') last.text += t;
    else segments.push({ type: 'text', text: t });
  };

  // 第 1 步：切出文件 token 的确定区间
  const fileSpans: Array<{ start: number; end: number; token: ComposerToken }> = [];
  FILE_TOKEN_RE.lastIndex = 0;
  for (let m = FILE_TOKEN_RE.exec(text); m !== null; m = FILE_TOKEN_RE.exec(text)) {
    fileSpans.push({
      start: m.index,
      end: m.index + m[0].length,
      token: { kind: 'file', path: m[1] },
    });
  }

  // 第 2 步：在文件 token 之间的文本片段上匹配命令/技能与智能体
  const commandNames = lookups.commands.map((c) => c.name);
  const skillNames = lookups.skills.map((s) => s.name);
  const commandRe = buildNameRe([...commandNames, ...skillNames], '/');
  const skillSet = new Set(skillNames);
  const commandSet = new Set(commandNames);
  const agentRe = buildNameRe(lookups.agents.map((a) => a.name), '@');
  const agentByName = new Map(lookups.agents.map((a) => [a.name, a] as const));

  const nameReSpans: Array<{ start: number; end: number; token: ComposerToken }> = [];
  const collect = (
    source: string,
    from: number,
    to: number,
    re: RegExp | null,
    toToken: (name: string) => ComposerToken | null,
  ) => {
    if (!re) return;
    re.lastIndex = 0;
    const slice = source.slice(from, to);
    for (let m = re.exec(slice); m !== null; m = re.exec(slice)) {
      // m[1] = 左边界（'' 或空白）；m[0] 剩余部分 = 触发符 + 名称
      const name = m[0].slice(m[1].length + 1);
      const start = from + m.index + m[1].length;
      const token = toToken(name);
      if (token) nameReSpans.push({ start, end: start + name.length + 1, token });
      // 空匹配保护（名称非空已由 buildNameRe 过滤）
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  };

  // 用文件 token 切分出「纯文本区间」，逐区间做名称匹配
  const textRanges: Array<[number, number]> = [];
  let cursor = 0;
  for (const span of fileSpans) {
    textRanges.push([cursor, span.start]);
    cursor = span.end;
  }
  textRanges.push([cursor, text.length]);
  for (const [from, to] of textRanges) {
    collect(text, from, to, commandRe, (name) => {
      if (!commandSet.has(name) && !skillSet.has(name)) return null;
      return { kind: 'command', source: skillSet.has(name) && !commandSet.has(name) ? 'skill' : 'command', name };
    });
    collect(text, from, to, agentRe, (name) => {
      const agent = agentByName.get(name);
      return agent ? { kind: 'agent', id: agent.id, name: agent.name } : null;
    });
  }

  // 第 3 步：按位置合并（文件 token 与名称 token 不可能重叠）
  const all = [...fileSpans, ...nameReSpans].sort((a, b) => a.start - b.start);
  cursor = 0;
  for (const item of all) {
    if (item.start < cursor) continue; // 防御：重叠则跳过后者
    pushText(text.slice(cursor, item.start));
    segments.push({ type: 'token', token: item.token });
    cursor = item.end;
  }
  pushText(text.slice(cursor));
  return segments;
}

/** 剥离全部 token 后的纯文本（任务标题 / 队列预览用；未命中名单的 `/x` 原样保留） */
export function stripMentionTokens(text: string, lookups: MentionLookups): string {
  const plain = parseMentionText(text, lookups)
    .map((seg) => (seg.type === 'text' ? seg.text : ''))
    .join('');
  return plain
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 路径切段（归一化分隔符；丢弃空段） */
function splitPathSegments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter(Boolean);
}

/**
 * 计算「最小区分标签」：每个路径取最短的尾部 k 段，使其在给定集合内唯一。
 * 例：`D:\a\src\index.js` + `D:\b\server\index.js`
 *    → `src/index.js` / `server/index.js`
 */
export function computeFileLabels(paths: string[]): Map<string, string> {
  const unique = [...new Set(paths)];
  const segLists = unique.map(splitPathSegments);
  const labels = new Map<string, string>();
  unique.forEach((path, i) => {
    const segs = segLists[i];
    if (segs.length === 0) {
      labels.set(path, path);
      return;
    }
    let k = 1;
    while (k < segs.length) {
      const candidate = segs.slice(segs.length - k).join('/');
      const clash = unique.some(
        (_, j) => j !== i && segLists[j].slice(-k).join('/') === candidate,
      );
      if (!clash) break;
      k++;
    }
    labels.set(path, segs.slice(segs.length - k).join('/'));
  });
  return labels;
}

/** 按关键字过滤（匹配名称或描述，大小写不敏感），保持传入分组顺序 */
export function filterMentionItems(items: MentionItem[], query: string): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) => it.name.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q),
  );
}

/**
 * 一次性注入模板渲染（command 与 skill 统一）：
 * - 模板含 $ARGUMENTS → 替换为 args（args 为空则替换为空串）
 * - 模板不含占位符且 args 非空 → 模板 + 空行 + args
 */
export function renderPromptTemplate(prompt: string, args: string): string {
  if (prompt.includes('$ARGUMENTS')) {
    return prompt.replace(/\$ARGUMENTS/g, args);
  }
  const trimmedArgs = args.trim();
  return trimmedArgs ? `${prompt}\n\n${trimmedArgs}` : prompt;
}

// ============================================================================
// 最近使用命令（IndexedDB 持久化，最多 5 条去重；选中时移到最前）
// 存储结构：["cmd:<name>" | "skill:<name>"]；旧版纯 name 数据视为 skill:name 兼容。
// 同步读取依赖 main.tsx 启动时把该 key 预填充到 idb 内存缓存（含旧 localStorage 迁移）。
// ============================================================================

const RECENT_COMMANDS_KEY = 'moss.recent-commands';
const RECENT_COMMANDS_MAX = 5;

/** 解析存储条目 → {source, name}；旧版纯 name 视为 skill */
function parseRecentEntry(entry: string): { source: MentionCommandSource; name: string } {
  if (entry.startsWith('cmd:')) return { source: 'command', name: entry.slice(4) };
  if (entry.startsWith('skill:')) return { source: 'skill', name: entry.slice(6) };
  return { source: 'skill', name: entry };
}

export function readRecentCommands(): Array<{ source: MentionCommandSource; name: string }> {
  try {
    const parsed = idbGetSync<unknown>(RECENT_COMMANDS_KEY);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .map(parseRecentEntry);
  } catch {
    return [];
  }
}

/** 记录一次命令使用：置顶去重，超出上限截断 */
export function touchRecentCommand(source: MentionCommandSource, name: string): void {
  const key = source === 'command' ? `cmd:${name}` : `skill:${name}`;
  try {
    const prev = readRecentCommands().map(
      (e) => (e.source === 'command' ? `cmd:${e.name}` : `skill:${e.name}`),
    );
    const next = [key, ...prev.filter((k) => k !== key)].slice(0, RECENT_COMMANDS_MAX);
    void idbSet(RECENT_COMMANDS_KEY, next);
  } catch {
    // 持久化失败（隐私模式等）：静默放弃
  }
}
