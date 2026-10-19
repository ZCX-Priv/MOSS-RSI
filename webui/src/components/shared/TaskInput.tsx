import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus,
  Mic,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  FolderInput,
  Loader2,
  Square,
  Monitor,
  Paperclip,
  Zap,
  Bot,
  Search,
  Settings2,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import type { OverlayType } from '../../types';
import { useStore, SYSTEM_WORKING_DIRECTORY } from '../../store';
import { ModelSelector } from '../overlays/ModelSelector';
import { PermissionModeSelector } from '../overlays/PermissionModeSelector';
import { useDirectoryPicker } from '../../hooks/useDirectoryPicker';
import { DirectoryBrowserDialog } from '../overlays/DirectoryBrowserDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  resolveWorkingDirectoryName,
  getAttachmentKind,
  type AttachmentKind,
} from '@/lib/utils';
import { resolveSkillIcon } from '@/lib/skill-icons';
import { api } from '../../api/http';
import { MentionMenu } from './MentionMenu';
import { VoiceWaveform } from './VoiceWaveform';
import { useVoiceInput, useVoiceStatus, useVoiceModels } from '../../hooks/useVoiceInput';
import { isLocalAsrSupported } from '@/lib/asr-local';
import { MentionEditor, type MentionEditorHandle } from './MentionEditor';
import { SendAttachmentCard } from './AttachmentCard';
import { fileTypeIconComponent } from './FileTypeIcon';
import { buildAttachmentBlock } from '@/lib/attachment-block';
import { buildInjectBlock } from '@/lib/inject-block';
import { fileNameOf } from '../../render/file/detector';
import {
  buildMentionLookups,
  filterMentionItems,
  parseMentionText,
  readRecentCommands,
  renderPromptTemplate,
  tokenWireText,
  touchRecentCommand,
  type ComposerToken,
  type MentionGroup,
  type MentionItem,
  type MentionLookups,
  type MentionSegment,
  type TriggerMatch,
} from './mention-data';
import type { CommandItem, SkillItem } from '../../types/api';

interface AttachmentItem {
  id: string;
  /** 本地绝对路径（纯路径引用：文件留在原位，agent 经 filesys 工具读取） */
  path: string;
  name: string;
  size: number;
  kind: AttachmentKind;
}

/** 粘贴附件单文件体积上限（与后端 PASTE_MAX_BYTES 一致）：25MB */
const PASTE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** 语音采集错误码 → i18n 文案键（未知码按原始错误文本原样展示） */
const VOICE_ERROR_KEYS: Record<string, string> = {
  INSECURE_CONTEXT: 'taskInput.voiceErrInsecure',
  MEDIA_DEVICES_UNAVAILABLE: 'taskInput.voiceErrNoMediaDevices',
  NOT_ALLOWED: 'taskInput.voiceErrPermission',
  NOT_FOUND: 'taskInput.voiceErrNoDevice',
  NOT_READABLE: 'taskInput.voiceErrBusy',
  NOT_SUPPORTED: 'taskInput.voiceErrUnsupported',
  AUDIO_WORKLET_UNAVAILABLE: 'taskInput.voiceErrWorklet',
  WS_NOT_CONNECTED: 'taskInput.voiceErrWs',
  LOCAL_MODEL_UNAVAILABLE: 'taskInput.voiceErrLocalModel',
  LOCAL_ENGINE_FAILED: 'taskInput.voiceErrLocalEngine',
};

/** 剪贴板文件扩展名推断（clipboard File 常无有效 name，用 mime 兜底；未知类型回退 bin） */
function extFromMime(mime: string): string {
  const sub = mime.split('/')[1]?.split(';')[0] ?? '';
  return /^[A-Za-z0-9]{1,5}$/.test(sub) ? sub.toLowerCase() : 'bin';
}

/** File → base64（去掉 dataURL 前缀；后端按 base64 解码落盘） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** command → / 菜单项 */
function commandToItem(c: CommandItem, group: 'recent' | 'commands'): MentionItem {
  return {
    id: `cmd:${c.name}`,
    kind: 'command',
    group,
    name: c.name,
    desc: c.argumentHint ? `${c.description} ${c.argumentHint}` : c.description,
    icon: resolveSkillIcon(c.icon),
    iconClass: 'text-violet-400',
    data: { source: 'command', name: c.name, prompt: c.prompt },
  };
}

/** skill → / 菜单项 */
function skillToItem(s: SkillItem, group: 'recent' | 'skills'): MentionItem {
  return {
    id: `skill:${s.name}`,
    kind: 'command',
    group,
    name: s.name,
    desc: s.description,
    icon: resolveSkillIcon(s.icon),
    iconClass: 'text-blue-600',
    data: { source: 'skill', name: s.name, prompt: s.prompt ?? '' },
  };
}

interface TaskInputProps {
  placeholder?: string;
  onOpenOverlay?: (overlay: OverlayType) => void;
  /** 发送回调：text = 最终消息文本（含附件块 / 命令注入块），attachments = 附件绝对路径（结构化字段） */
  onSend?: (text: string, attachments: string[]) => void;
  isGenerating?: boolean;
  /** 仅首屏空白（会话无消息且未生成）时显示工作目录 Badge */
  showDirectoryBadge?: boolean;
  onAbort?: () => void;
  /** 点击附件卡片：在右侧边栏打开该文件预览（未提供时卡片不可点） */
  onOpenAttachment?: (path: string) => void;
}

export function TaskInput({
  placeholder,
  onOpenOverlay,
  onSend,
  isGenerating = false,
  showDirectoryBadge = true,
  onAbort,
  onOpenAttachment,
}: TaskInputProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workingDirectory = useStore((s) => s.workingDirectory);
  const setWorkingDirectory = useStore((s) => s.setWorkingDirectory);
  const recentDirectories = useStore((s) => s.recentDirectories);
  /** 最近使用目录的自定义显示名（path → alias） */
  const recentDirectoryAliases = useStore((s) => s.recentDirectoryAliases);
  /** 输入框回填通道（「编辑队列消息」用） */
  const composerInjection = useStore((s) => s.composerInjection);
  const clearComposerInjection = useStore((s) => s.clearComposerInjection);
  const sendShortcut = useStore((s) => s.sendShortcut);
  const skills = useStore((s) => s.skills);
  const commands = useStore((s) => s.commands);
  const agents = useStore((s) => s.agents);
  const {
    pickDirectory,
    browseOpen,
    onBrowserPicked,
    closeBrowser,
  } = useDirectoryPicker();

  // ==========================================================================
  // 附件（纯本地路径引用：内建选择器「文件模式」选路径 / 粘贴落盘；均不向模型传内容）
  // ==========================================================================
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  /** 内建文件选择器弹窗开关（新增附件用；与工作目录弹窗相互独立） */
  const [attachBrowseOpen, setAttachBrowseOpen] = useState(false);

  /** 「添加附件」：打开内建文件选择器（文件模式，默认定位工作区目录） */
  const openAttachPicker = () => setAttachBrowseOpen(true);

  /** 内建选择器确认选中文件：解析为附件条目（后端 stat + 自动授权父目录） */
  const handleAttachSelected = async (paths: string[]) => {
    setAttachBrowseOpen(false);
    if (paths.length === 0) return;
    try {
      const resp = await api.resolvePaths(paths);
      if (resp.files.length === 0) return;
      const now = Date.now();
      setAttachments((prev) => [
        ...prev,
        ...resp.files.map((f, i) => ({
          id: `${now}-${i}-${f.path}`,
          path: f.path,
          name: f.name,
          size: f.size,
          kind: getAttachmentKind(f.name, ''),
        })),
      ]);
    } catch {
      toast.error(t('taskInput.pickFileFailed'));
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  /** 粘贴文件（图片/任意文件）→ 落盘为附件（不占用输入框）：base64 提交后端写入 ~/.moss/agent/attachments */
  const handlePasteFiles = async (files: File[]) => {
    const saved: AttachmentItem[] = [];
    for (const file of files) {
      // 体积上限：超限跳过并提示（后端同值兜底）
      if (file.size > PASTE_ATTACHMENT_MAX_BYTES) {
        toast.error(t('taskInput.pasteFileTooLarge', { name: file.name || '—' }));
        continue;
      }
      try {
        const dataBase64 = await fileToBase64(file);
        const name = file.name || `file-${Date.now()}.${extFromMime(file.type)}`;
        const { file: picked } = await api.saveAttachment({ name, dataBase64 });
        saved.push({
          id: `${Date.now()}-${picked.path}`,
          path: picked.path,
          name: picked.name,
          size: picked.size,
          kind: getAttachmentKind(picked.name, ''),
        });
      } catch {
        toast.error(t('taskInput.pasteFileFailed'));
      }
    }
    if (saved.length > 0) {
      setAttachments((prev) => [...prev, ...saved]);
    }
  };

  // 附件单行横向滚动：哪边还有未滚动到内容，才渲染哪边的箭头（不占位，避免多余空白）
  const attachmentsScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateAttachmentArrows = () => {
    const el = attachmentsScrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(max > 1 && el.scrollLeft < max - 1);
  };

  const scrollAttachments = (dir: -1 | 1) => {
    attachmentsScrollRef.current?.scrollBy({ left: dir * 220, behavior: 'smooth' });
  };

  // 附件增删 / 容器尺寸变化时重算箭头显隐
  useEffect(() => {
    const el = attachmentsScrollRef.current;
    if (!el) return;
    updateAttachmentArrows();
    const observer = new ResizeObserver(() => updateAttachmentArrows());
    observer.observe(el);
    return () => observer.disconnect();
  }, [attachments.length]);

  // ==========================================================================
  // / @ # 触发菜单（菜单状态在本层；token 与文本都在 MentionEditor 的 contenteditable 内）
  // ==========================================================================
  const [input, setInput] = useState('');
  const [trigger, setTrigger] = useState<TriggerMatch | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const editorRef = useRef<MentionEditorHandle>(null);
  /** 最近一次提交的内容与时间（同内容 300ms 内重复提交视为同一次，防止重复发送） */
  const lastSubmitRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  /** 触发状态镜像（避免在 setState 更新器里做副作用） */
  const triggerRef = useRef<TriggerMatch | null>(null);
  /** 已消费的回填序号（去重：同一 seq 只回填一次） */
  const lastInjectionSeqRef = useRef(0);

  // 「编辑队列消息」回填：文本写入编辑器 + 恢复其附件（消费后清空回填通道）
  useEffect(() => {
    if (!composerInjection || composerInjection.seq === lastInjectionSeqRef.current) return;
    lastInjectionSeqRef.current = composerInjection.seq;
    editorRef.current?.setValue(composerInjection.text);
    const inject = composerInjection.attachments;
    if (inject && inject.length > 0) {
      setAttachments((prev) => {
        const existing = new Set(prev.map((a) => a.path));
        const added = inject
          .filter((p) => !existing.has(p))
          .map((p, i) => ({
            id: `inject-${composerInjection.seq}-${i}-${p}`,
            path: p,
            name: p.split(/[\\/]/).filter(Boolean).pop() ?? p,
            size: 0,
            kind: getAttachmentKind(p, ''),
          }));
        return added.length > 0 ? [...prev, ...added] : prev;
      });
    }
    clearComposerInjection();
  }, [composerInjection, clearComposerInjection]);

  // ---- / 菜单与「+ → 命令」子菜单共用数据源：commands + skills + 最近使用（localStorage） ----
  const recentRef = useRef(readRecentCommands());
  const [recentVersion, setRecentVersion] = useState(0);

  const commandItems = useMemo<MentionItem[]>(() => {
    const enabledCommands = commands.filter((c) => c.enabled !== false);
    const enabledSkills = skills.filter((s) => s.enabled !== false);
    const cmdByName = new Map(enabledCommands.map((c) => [c.name, c] as const));
    const skillByName = new Map(enabledSkills.map((s) => [s.name, s] as const));

    // recent 分组：最近使用记录中仍存在的项
    const items: MentionItem[] = [];
    const recentNames = new Set<string>();
    for (const r of recentRef.current) {
      if (r.source === 'command' && cmdByName.has(r.name)) {
        items.push(commandToItem(cmdByName.get(r.name)!, 'recent'));
        recentNames.add(r.name);
      } else if (r.source === 'skill' && skillByName.has(r.name)) {
        items.push(skillToItem(skillByName.get(r.name)!, 'recent'));
        recentNames.add(r.name);
      }
    }
    // commands 分组（自定义命令）
    for (const c of enabledCommands) {
      if (!recentNames.has(c.name)) items.push(commandToItem(c, 'commands'));
    }
    // skills 分组（同名 command 优先，skill 跳过）
    for (const s of enabledSkills) {
      if (!recentNames.has(s.name) && !cmdByName.has(s.name)) items.push(skillToItem(s, 'skills'));
    }
    return items;
    // recentVersion：touchRecentCommand 后触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, skills, recentVersion]);

  // ---- @ 智能体菜单数据源：真实 agents ----
  const agentItems = useMemo<MentionItem[]>(
    () =>
      agents.map((a) => ({
        id: a.id,
        kind: 'agent' as const,
        group: 'agents' as const,
        name: a.name,
        desc: a.description ?? '',
        icon: Bot,
        iconClass: 'text-emerald-400',
      })),
    [agents],
  );

  // ---- # 文件菜单数据源：工作目录递归搜索（防抖 200ms，后端已按 q 过滤） ----
  const [fileItems, setFileItems] = useState<MentionItem[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const isSystemScope = !workingDirectory || workingDirectory === SYSTEM_WORKING_DIRECTORY;
  const fileSearchSeqRef = useRef(0);

  useEffect(() => {
    if (!trigger || trigger.kind !== 'file' || isSystemScope) {
      setFileItems([]);
      setFileSearching(false);
      return;
    }
    const q = trigger.query.trim();
    const seq = ++fileSearchSeqRef.current;
    setFileSearching(true);
    const timer = setTimeout(() => {
      api
        .searchFiles(workingDirectory, q)
        .then(({ files }) => {
          if (fileSearchSeqRef.current !== seq) return; // 过期响应丢弃
          setFileItems(
            files.map((f) => ({
              id: f.path,
              kind: 'file' as const,
              group: 'files' as const,
              name: f.name,
              desc: f.dir,
              // 与附件卡片同源的文件类型图标（VS Code Material 图标主题），不再自建 lucide 映射
              icon: fileTypeIconComponent(f.name),
              iconClass: '',
            })),
          );
          setFileSearching(false);
        })
        .catch(() => {
          if (fileSearchSeqRef.current !== seq) return;
          setFileItems([]);
          setFileSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [trigger, workingDirectory, isSystemScope]);

  // ---- 当前触发类型对应的菜单项 ----
  const mentionItems = trigger
    ? trigger.kind === 'command'
      ? filterMentionItems(commandItems, trigger.query)
      : trigger.kind === 'agent'
        ? filterMentionItems(agentItems, trigger.query)
        : fileItems // 文件菜单：后端已按 query 过滤，前端直接展示
    : [];

  /** 线格式反解析名单（编辑器粘贴还原 / 发送时命令模板现查 共用口径） */
  const lookups = useMemo<MentionLookups>(
    () => buildMentionLookups(commands, skills, agents),
    [commands, skills, agents],
  );

  /** 触发状态由编辑器上报：仅在 token 段变化时重置高亮项；等价状态不触发重渲染 */
  const handleTriggerChange = (match: TriggerMatch | null) => {
    const prev = triggerRef.current;
    if (!match && !prev) return;
    if (
      match &&
      prev &&
      prev.kind === match.kind &&
      prev.query === match.query &&
      prev.tokenStart === match.tokenStart
    ) {
      return; // 等价（selectionchange 会高频触发）→ 不改状态
    }
    if (match) setActiveIndex(0);
    triggerRef.current = match;
    setTrigger(match);
  };

  /** 菜单项选中的副作用：切智能体 / 记录最近命令（token 插入本身由编辑器完成） */
  const handleItemSelected = (item: MentionItem) => {
    if (item.kind === 'agent') {
      // 切换当前智能体（发送 payload.agentId 自动生效）
      useStore.getState().setCurrentAgent(item.id);
      return;
    }
    if (item.kind === 'command' && item.data) {
      touchRecentCommand(item.data.source, item.data.name);
      recentRef.current = readRecentCommands();
      setRecentVersion((v) => v + 1);
    }
  };

  /** 菜单点击：token 替换触发词（编辑器内部完成删除 + 插入 + 光标落位） */
  const selectMention = (item: MentionItem) => {
    editorRef.current?.commitMention(item);
  };

  /** 「+ → 命令」子菜单项选中：插入命令/技能 token（复用 / 菜单的插入口径） */
  const selectPlusItem = (item: MentionItem) => {
    if (!item.data) return;
    editorRef.current?.insertToken({
      kind: 'command',
      source: item.data.source,
      name: item.data.name,
    });
    handleItemSelected(item);
  };

  /** 按名单现查命令/技能模板（查不到 → 该 token 原样保留为普通文本） */
  const findCommandPrompt = (token: ComposerToken & { kind: 'command' }): string | null => {
    if (token.source === 'skill') {
      return skills.find((s) => s.name === token.name)?.prompt ?? null;
    }
    return commands.find((c) => c.name === token.name)?.prompt ?? null;
  };

  const handleSend = () => {
    const raw = (editorRef.current?.getValue() ?? input).trim();
    if (!raw && attachments.length === 0) return;

    // 命令：一次性注入语义不变（模板 + $ARGUMENTS = 去掉命令 token 的正文），
    // 但不再替换正文 —— 可见正文保留用户原文（含 /命令、@智能体、#路径），
    // 模板作为「注入块」追加在消息末尾：LLM 可见、UI 不可见（stripInjectBlock）。
    const segments = parseMentionText(raw, lookups);
    const commandSeg = segments.find(
      (s): s is MentionSegment & { type: 'token' } => s.type === 'token' && s.token.kind === 'command',
    );
    let injectBlock = '';
    if (commandSeg) {
      const prompt = findCommandPrompt(commandSeg.token as ComposerToken & { kind: 'command' });
      if (prompt !== null) {
        const args = segments
          .filter((s) => s !== commandSeg)
          .map((s) => (s.type === 'text' ? s.text : tokenWireText(s.token)))
          .join('')
          .trim();
        injectBlock = buildInjectBlock(renderPromptTemplate(prompt, args));
      }
    }

    // 附件仅限「+ 添加附件」：`#` 引用已在正文内联（绝对路径），不再并入附件
    const uniquePaths = [...new Set(attachments.map((a) => a.path))];
    // 顺序约定（inject-block 尾部锚定）：正文 → 附件块 → 注入块
    const message = [
      raw,
      uniquePaths.length > 0
        ? buildAttachmentBlock(uniquePaths, t('taskInput.attachmentListLabel'))
        : '',
      injectBlock,
    ]
      .filter(Boolean)
      .join('\n\n');
    // 重复提交门禁：同一内容在 300ms 内只受理一次。
    // 覆盖「双击发送 / 快捷键与点击事件同时触发 / 事件重复派发」——
    // 否则第二次提交会因生成态已置位而进入排队队列，任务结束后被自动续发（等于发两遍）。
    const now = Date.now();
    if (lastSubmitRef.current.text === message && now - lastSubmitRef.current.at < 300) {
      return;
    }
    lastSubmitRef.current = { text: message, at: now };

    onSend?.(message, uniquePaths);
    setAttachments([]);
    editorRef.current?.clear();
  };

  // ==========================================================================
  // 语音输入（默认关闭；仅在 设置>服务商>语音 开启且后端可用时显示麦克风按钮）
  // ==========================================================================
  const { status: voiceStatus } = useVoiceStatus();
  const { models: voiceModels } = useVoiceModels();
  const voiceEnabled = Boolean(voiceStatus?.available && voiceStatus.enabled);
  // 服务端可用：配置了在线语音服务商，或运行时可用且已安装本地模型
  const serverVoiceReady =
    Boolean(voiceStatus?.providerId) ||
    Boolean(voiceStatus?.runtimeAvailable && (voiceStatus?.installed?.length ?? 0) > 0);
  // 浏览器端本地推理（WASM）：需要已安装的流式 zipformer 模型
  const localModel = voiceModels.find((m) => m.state === 'installed' && m.engine === 'zipformer');
  const localWasmReady = isLocalAsrSupported() && Boolean(localModel);
  // 执行位置：优先服务端本地引擎；不可用时用浏览器端 WASM
  const voiceEngine: 'server' | 'local' | null = serverVoiceReady
    ? 'server'
    : localWasmReady
      ? 'local'
      : null;
  const voiceReady = voiceEngine !== null;

  const voice = useVoiceInput({
    engine: voiceEngine ?? 'server',
    localModelId: localModel?.id,
    onNotice: (key) => toast.info(t(key)),
    onPartial: (text) => editorRef.current?.setVoiceDraft(text),
    onFinal: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // 定型：写入最终文本并固化（下一句从新光标继续）
      editorRef.current?.setVoiceDraft(`${trimmed} `);
      editorRef.current?.commitVoice();
    },
    onError: (code) => {
      const key = VOICE_ERROR_KEYS[code];
      toast.error(t('taskInput.voiceFailed'), { description: key ? t(key) : code });
    },
  });

  const canSend = Boolean(input.trim()) || attachments.length > 0;

  const folderLabel =
    resolveWorkingDirectoryName(workingDirectory) ?? t('directoryPicker.system');
  const showDirBadge = showDirectoryBadge && !isGenerating;

  const dirName = (path: string) => {
    const seg = path.split(/[\\/]/).filter(Boolean).pop();
    return seg ?? path;
  };

  const renderDirItem = (name: string, path: string, onSelect: () => void, icon?: React.ReactNode) => (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <DropdownMenuItem onSelect={onSelect} className="gap-2 py-1.5">
          {icon ?? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />}
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{path}</span>
          </div>
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right">
        <span className="font-mono">{path}</span>
      </TooltipContent>
    </Tooltip>
  );

  /** 「命令」子菜单：搜索词 */
  const [plusQuery, setPlusQuery] = useState('');
  /** 「命令」子菜单开关（受控：打开时聚焦搜索框、关闭时清空搜索词） */
  const [plusOpen, setPlusOpen] = useState(false);
  /** 搜索框引用（打开子菜单时自动聚焦） */
  const plusSearchRef = useRef<HTMLInputElement>(null);

  /** 命令 + 技能 + 最近使用（与 / 主菜单同源；分组标题与排他逻辑一致） */
  const filteredPlus = useMemo(
    () => filterMentionItems(commandItems, plusQuery),
    [commandItems, plusQuery],
  );

  /** 按 group 顺序聚合为 [{ group, items }]（最近使用 → 命令 → 技能） */
  const plusGroups = useMemo(() => {
    const groups: Array<{ group: MentionGroup; items: MentionItem[] }> = [];
    for (const it of filteredPlus) {
      const last = groups[groups.length - 1];
      if (last && last.group === it.group) last.items.push(it);
      else groups.push({ group: it.group, items: [it] });
    }
    return groups;
  }, [filteredPlus]);

  // 打开「命令」子菜单时聚焦搜索框（radix 默认会聚焦菜单项，这里主动抢回焦点）
  useEffect(() => {
    if (plusOpen) plusSearchRef.current?.focus();
  }, [plusOpen]);

  return (
    <>
    <Card className="relative w-full gap-0 overflow-visible rounded-2xl border border-border bg-transparent p-2 shadow-none ring-0">
      {trigger && (
        <MentionMenu
          items={mentionItems}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onSelect={selectMention}
          loading={trigger.kind === 'file' && fileSearching}
          emptyText={
            trigger.kind === 'file' && isSystemScope ? t('taskInput.noWorkingDir') : undefined
          }
        />
      )}
      {attachments.length > 0 && (
        <div className="flex items-center gap-1 px-1 pt-1">
          {canScrollLeft && (
            <button
              type="button"
              onClick={() => scrollAttachments(-1)}
              title={t('taskInput.scrollAttachmentsLeft')}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <div
            ref={attachmentsScrollRef}
            onScroll={updateAttachmentArrows}
            className="no-scrollbar flex flex-1 items-center gap-2 overflow-x-auto scroll-smooth py-1"
          >
            {attachments.map((a) => (
              <SendAttachmentCard
                key={a.id}
                path={a.path}
                name={a.name}
                size={a.size}
                onRemove={() => removeAttachment(a.id)}
                onOpen={onOpenAttachment ? () => onOpenAttachment(a.path) : undefined}
              />
            ))}
          </div>
          {canScrollRight && (
            <button
              type="button"
              onClick={() => scrollAttachments(1)}
              title={t('taskInput.scrollAttachmentsRight')}
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-start gap-1">
        <MentionEditor
          ref={editorRef}
          placeholder={placeholder ?? t('taskInput.placeholder')}
          trigger={trigger}
          items={mentionItems}
          activeIndex={activeIndex}
          onChange={setInput}
          onTriggerChange={handleTriggerChange}
          onActiveIndexChange={setActiveIndex}
          onMenuClose={() => {
            triggerRef.current = null;
            setTrigger(null);
          }}
          onItemSelected={handleItemSelected}
          onDuplicateFile={(path) =>
            toast.info(t('taskInput.fileAlreadyReferenced', { name: fileNameOf(path) }))
          }
          onPasteFiles={handlePasteFiles}
          lookups={lookups}
          sendShortcut={sendShortcut}
          onSend={handleSend}
          className="max-h-[40vh]"
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 px-1 pt-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" title={t('common.attachment')}>
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              collisionPadding={8}
              className="w-auto min-w-[220px] rounded-xl p-1"
            >
              <DropdownMenuItem
                onSelect={openAttachPicker}
                className="gap-2 rounded-lg px-2.5 py-1.5 text-[13px]"
              >
                <Paperclip className="size-4 text-muted-foreground" />
                <span>{t('taskInput.addAttachment')}</span>
              </DropdownMenuItem>
              <DropdownMenuSub
                open={plusOpen}
                onOpenChange={(o) => {
                  setPlusOpen(o);
                  if (!o) setPlusQuery('');
                }}
              >
                <DropdownMenuSubTrigger className="gap-2 rounded-lg px-2.5 py-1.5 text-[13px]">
                  <Zap className="size-4 text-muted-foreground" />
                  <span>{t('taskInput.commands')}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  sideOffset={8}
                  collisionPadding={8}
                  className="w-72 rounded-xl p-0"
                >
                  {/* 搜索框 */}
                  <div className="relative p-1.5">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      ref={plusSearchRef}
                      value={plusQuery}
                      onChange={(e) => setPlusQuery(e.target.value)}
                      placeholder={t('taskInput.searchCommandsSkills')}
                      spellCheck={false}
                      className="h-8 w-full rounded-lg border border-input bg-muted/40 pl-8 pr-2 text-xs text-foreground outline-none"
                      onKeyDown={(e) => {
                        // Escape 放行给 radix（关闭菜单）；其余按键阻断冒泡，
                        // 避免 radix 菜单的方向键导航 / 字母 typeahead 抢焦点
                        if (e.key === 'Escape') return;
                        e.stopPropagation();
                        // Enter：选中首个匹配项
                        if (e.key === 'Enter') {
                          const first = filteredPlus[0];
                          if (first) {
                            e.preventDefault();
                            selectPlusItem(first);
                          }
                        }
                      }}
                    />
                  </div>
                  {/* 可滚动的分组列表 */}
                  <div className="max-h-80 overflow-y-auto px-1 pb-1">
                    {plusGroups.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {t('taskInput.noResults')}
                      </div>
                    ) : (
                      plusGroups.map((section) => (
                        <div key={section.group}>
                          <div className="px-2 pb-0.5 pt-1.5 text-[11px] text-muted-foreground">
                            {t(`taskInput.mentionGroups.${section.group}`)}
                          </div>
                          {section.items.map((item) => {
                            const Icon = item.icon;
                            return (
                              <DropdownMenuItem
                                key={item.id}
                                onSelect={() => selectPlusItem(item)}
                                className="items-start gap-2 rounded-lg px-2 py-1.5"
                              >
                                <Icon className={`mt-0.5 size-4 shrink-0 ${item.iconClass}`} />
                                <div className="flex min-w-0 flex-1 flex-col">
                                  <span className="truncate text-[13px] font-medium">{item.name}</span>
                                  <span className="truncate text-xs text-muted-foreground">
                                    {item.desc}
                                  </span>
                                </div>
                              </DropdownMenuItem>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                  <DropdownMenuSeparator className="mx-0" />
                  {/* 底部：管理技能（跳转 插件库 → 技能页；radix 随 onSelect 自动关闭菜单） */}
                  <DropdownMenuItem
                    onSelect={() => navigate('/plugins/skills')}
                    className="items-start gap-2 rounded-lg px-2.5 py-1.5 text-[13px]"
                  >
                    <Settings2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span>{t('taskInput.manageSkills')}</span>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          <PermissionModeSelector fullLabel={!showDirBadge} />
          {showDirBadge && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Badge
                variant="secondary"
                className="min-w-0 shrink gap-1 h-7 rounded-[min(var(--radius-md),12px)] border border-border bg-transparent px-3 py-1 font-normal cursor-pointer [&>svg]:size-3.5"
                title={
                  isSystemScope
                    ? t('directoryPicker.systemTitle')
                    : workingDirectory
                }
              >
                {isSystemScope ? (
                  <Monitor className="size-3 shrink-0" />
                ) : (
                  <FolderOpen className="size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{folderLabel}</span>
                <ChevronDown className="size-3 shrink-0 opacity-70" />
              </Badge>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" collisionPadding={8} className="min-w-[18rem]">
              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                {t('directoryPicker.recent')}
              </div>
              {/* 「本机（全盘访问）」与最近目录同列同一滚动容器：
                  不再单独固定在列表之上，与其他文件夹条目对齐（同宽、同缩进、一起滚动） */}
              <div className="max-h-[10.5rem] overflow-y-auto pr-1">
                <div key="__system__">
                  {renderDirItem(
                    t('directoryPicker.system'),
                    t('directoryPicker.systemDesc'),
                    () => setWorkingDirectory(SYSTEM_WORKING_DIRECTORY),
                    <Monitor key="system" className="size-3.5 shrink-0 text-muted-foreground" />,
                  )}
                </div>
                {recentDirectories.map((dir) => (
                  <div key={dir}>
                    {renderDirItem(
                      recentDirectoryAliases[dir]?.trim() || dirName(dir),
                      dir,
                      () => setWorkingDirectory(dir),
                    )}
                  </div>
                ))}
              </div>
              <DropdownMenuSeparator className="mx-2" />
              <DropdownMenuItem onSelect={() => pickDirectory()} className="gap-1.5">
                <FolderInput className="size-3.5" />
                <span>{t('directoryPicker.pickFolder')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <ModelSelector />
          {voiceEnabled && (
            <Button
              variant={voice.recording ? 'destructive' : 'ghost'}
              size="icon-sm"
              title={
                voice.recording
                  ? t('taskInput.voiceStop')
                  : voiceReady
                    ? t('common.voiceInput')
                    : t('taskInput.voiceUnavailableTitle')
              }
              onClick={voice.toggle}
              disabled={(voice.busy && !voice.recording) || (!voice.recording && !voiceReady)}
            >
              {voice.recording ? (
                <VoiceWaveform level={voice.level} />
              ) : voice.busy ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Mic />
              )}
            </Button>
          )}
          {isGenerating && !canSend ? (
            <Button
              size="icon-sm"
              variant="destructive"
              onClick={onAbort}
              title={t('common.stop')}
              disabled={!onAbort}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant={canSend ? 'default' : 'secondary'}
              onClick={handleSend}
              title={isGenerating ? t('taskInput.sendWhileGenerating') : t('common.send')}
              disabled={!canSend}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </Card>
    <DirectoryBrowserDialog
      open={browseOpen}
      onSelect={onBrowserPicked}
      onClose={closeBrowser}
    />
    <DirectoryBrowserDialog
      open={attachBrowseOpen}
      mode="file"
      initialPath={isSystemScope ? undefined : workingDirectory}
      onSelectFiles={(paths) => void handleAttachSelected(paths)}
      onClose={() => setAttachBrowseOpen(false)}
    />
    </>
  );
}
