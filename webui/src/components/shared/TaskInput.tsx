import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { useVoiceInput, useVoiceStatus } from '../../hooks/useVoiceInput';
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

/** 剪贴板图片扩展名推断（clipboard File 常无有效 name，用 mime 兜底） */
function extFromMime(mime: string): string {
  const sub = mime.split('/')[1] ?? '';
  return /^[A-Za-z0-9]{1,5}$/.test(sub) ? sub.toLowerCase() : 'png';
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
  const workingDirectory = useStore((s) => s.workingDirectory);
  const setWorkingDirectory = useStore((s) => s.setWorkingDirectory);
  const recentDirectories = useStore((s) => s.recentDirectories);
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
  // 附件（纯本地路径引用：原生对话框选择，无上传）
  // ==========================================================================
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);

  const handlePickFiles = async () => {
    try {
      const resp = await api.pickFiles();
      if (resp.files.length === 0) return; // 用户取消
      setAttachments((prev) => [
        ...prev,
        ...resp.files.map((f, i) => ({
          id: `${Date.now()}-${i}-${f.path}`,
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

  /** 粘贴图片 → 落盘为附件（不占用输入框）：base64 提交后端写入 ~/.moss/agent/attachments */
  const handlePasteImages = async (files: File[]) => {
    const saved: AttachmentItem[] = [];
    for (const file of files) {
      try {
        const dataBase64 = await fileToBase64(file);
        const name = file.name || `image-${Date.now()}.${extFromMime(file.type)}`;
        const { file: picked } = await api.saveAttachment({ name, dataBase64 });
        saved.push({
          id: `${Date.now()}-${picked.path}`,
          path: picked.path,
          name: picked.name,
          size: picked.size,
          kind: getAttachmentKind(picked.name, ''),
        });
      } catch {
        toast.error(t('taskInput.pasteImageFailed'));
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

  // ---- / 菜单数据源：commands + skills + 最近使用（localStorage） ----
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
  const voiceEnabled = Boolean(voiceStatus?.available && voiceStatus.enabled);

  const voice = useVoiceInput({
    onPartial: (text) => editorRef.current?.setVoiceDraft(text),
    onFinal: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // 定型：写入最终文本并固化（下一句从新光标继续）
      editorRef.current?.setVoiceDraft(`${trimmed} `);
      editorRef.current?.commitVoice();
    },
    onError: (message) => toast.error(t('taskInput.voiceFailed'), { description: message }),
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

  // Plus 菜单可选项：commands + skills（不含 recent 重复项）
  const plusMenuItems = commandItems.filter((it) => it.group !== 'recent');

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
          onPasteImages={handlePasteImages}
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
                onSelect={() => void handlePickFiles()}
                className="gap-2 rounded-lg px-2.5 py-1.5 text-[13px]"
              >
                <Paperclip className="size-4 text-muted-foreground" />
                <span>{t('taskInput.addAttachment')}</span>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 rounded-lg px-2.5 py-1.5 text-[13px]">
                  <Zap className="size-4 text-muted-foreground" />
                  <span>{t('taskInput.commands')}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  sideOffset={8}
                  collisionPadding={8}
                  className="w-auto min-w-[260px] max-h-72 overflow-y-auto rounded-xl"
                >
                  {plusMenuItems.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-6 py-8">
                      <Zap className="size-5 text-muted-foreground/50" />
                      <span className="text-xs text-muted-foreground">
                        {t('taskInput.noCommands')}
                      </span>
                    </div>
                  ) : (
                    plusMenuItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <DropdownMenuItem
                          key={item.id}
                          onSelect={() => {
                            if (!item.data) return;
                            editorRef.current?.insertToken({
                              kind: 'command',
                              source: item.data.source,
                              name: item.data.name,
                            });
                            handleItemSelected(item);
                          }}
                          className="gap-2 rounded-lg px-2.5 py-1.5"
                        >
                          <Icon className="size-4 shrink-0 text-muted-foreground" />
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate text-[13px] font-medium">{item.name}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {item.desc}
                            </span>
                          </div>
                        </DropdownMenuItem>
                      );
                    })
                  )}
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
              {renderDirItem(
                t('directoryPicker.system'),
                t('directoryPicker.systemDesc'),
                () => setWorkingDirectory(SYSTEM_WORKING_DIRECTORY),
                <Monitor key="system" className="size-3.5 shrink-0 text-muted-foreground" />,
              )}
              {recentDirectories.length > 0 && (
                <div className="max-h-[10.5rem] overflow-y-auto pr-1">
                  {recentDirectories.map((dir) => (
                    <div key={dir}>
                      {renderDirItem(dirName(dir), dir, () => setWorkingDirectory(dir))}
                    </div>
                  ))}
                </div>
              )}
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
              title={voice.recording ? t('taskInput.voiceStop') : t('common.voiceInput')}
              onClick={voice.toggle}
              disabled={voice.busy && !voice.recording}
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
    </>
  );
}
