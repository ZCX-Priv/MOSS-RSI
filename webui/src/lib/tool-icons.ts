// webui/src/lib/tool-icons.ts
// 工具图标白名单映射：icon 字符串（lucide kebab-case）→ LucideIcon 组件。
// 白名单即「仅限于图标库」的边界：白名单外的 icon 字符串回退 Wrench。

import {
  Wrench, Plug, FileText, FilePlus, FilePen, Trash2, Terminal,
  FolderSearch, Search, ListChecks, HelpCircle, Sparkles, List, BookOpen,
  FileCode, Copy, FolderInput, CalendarClock, Bot, Brain, Globe, Monitor,
  AppWindow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** icon 字符串 → LucideIcon 白名单（lucide 图标库子集） */
export const TOOL_ICON_MAP: Record<string, LucideIcon> = {
  'file-text': FileText,
  'file-plus': FilePlus,
  'file-pen': FilePen,
  'trash-2': Trash2,
  'terminal': Terminal,
  'folder-search': FolderSearch,
  'search': Search,
  'list-checks': ListChecks,
  'help-circle': HelpCircle,
  'sparkles': Sparkles,
  'plug': Plug,
  'list': List,
  'book-open': BookOpen,
  'file-code': FileCode,
  'copy': Copy,
  'folder-input': FolderInput,
  'calendar-clock': CalendarClock,
  'bot': Bot,
  'brain': Brain,
  'globe': Globe,
  'monitor': Monitor,
  'app-window': AppWindow,
};

/** 按 toolName + toolIconMap 解析图标组件，未知/缺失回退 Wrench */
export function resolveToolIcon(
  toolName: string,
  toolIconMap: Record<string, string>,
): LucideIcon {
  if (toolName.startsWith('mcp__')) return Plug; // MCP 工具统一插头图标
  const iconKey = toolIconMap[toolName];
  if (!iconKey) return Wrench;
  return TOOL_ICON_MAP[iconKey] ?? Wrench;
}
