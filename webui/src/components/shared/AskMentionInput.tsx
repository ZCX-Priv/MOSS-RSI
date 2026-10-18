// components/shared/AskMentionInput.tsx
// ask 卡片的自由输入：复用 MentionEditor（contenteditable 内联 token 编辑器），
// 仅允许 `/`（命令/技能）与 `#`（文件引用）触发，禁用 `@`。
// 渲染口径与发送框完全一致（线格式 = `#<绝对路径>` 等），因此提交后不会露出原始路径。
// 支持粘贴文件 → 落盘为附件（回调给父层渲染附件卡片）。

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useStore, SYSTEM_WORKING_DIRECTORY } from '../../store';
import { api } from '../../api/http';
import { fileNameOf } from '../../render/file/detector';
import { resolveSkillIcon } from '@/lib/skill-icons';
import { cn } from '@/lib/utils';
import { MentionEditor, type MentionEditorHandle } from './MentionEditor';
import { MentionMenu } from './MentionMenu';
import { fileTypeIconComponent } from './FileTypeIcon';
import {
  buildMentionLookups,
  filterMentionItems,
  readRecentCommands,
  touchRecentCommand,
  type MentionItem,
  type MentionLookups,
  type TriggerMatch,
} from './mention-data';
import type { CommandItem, SkillItem } from '../../types/api';

/** 粘贴附件单文件体积上限（与后端一致）：25MB */
const PASTE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function extFromMime(mime: string): string {
  const sub = mime.split('/')[1]?.split(';')[0] ?? '';
  return /^[A-Za-z0-9]{1,5}$/.test(sub) ? sub.toLowerCase() : 'bin';
}

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

export interface AskMentionInputHandle {
  /** 线格式文本（含内联 token）；空串表示未输入 */
  getValue(): string;
  clear(): void;
  focus(): void;
}

interface AskMentionInputProps {
  placeholder: string;
  /** 初始线格式文本（受控回填；编辑器挂载时写入一次） */
  initialValue?: string;
  /** 线格式文本变化（父层可用于提交校验） */
  onChange?: (value: string) => void;
  /** 粘贴文件落盘成功 → 附件条目（path/name/size） */
  onPasteAttachments?: (files: Array<{ path: string; name: string; size: number }>) => void;
  /** 命中发送快捷键（默认 mod+enter）时的回调 */
  onSend?: () => void;
  /** 内联紧凑模式（用于「其他」行内输入）：去掉外框、单行高度 + 最大高度滚动 */
  inline?: boolean;
  className?: string;
}

export const AskMentionInput = forwardRef<AskMentionInputHandle, AskMentionInputProps>(
  function AskMentionInput({ placeholder, initialValue, onChange, onPasteAttachments, onSend, inline, className }, ref) {
    const { t } = useTranslation();
    const commands = useStore((s) => s.commands);
    const skills = useStore((s) => s.skills);
    const workingDirectory = useStore((s) => s.workingDirectory);
    const sendShortcut = useStore((s) => s.sendShortcut);

    const innerRef = useRef<MentionEditorHandle>(null);
    const [trigger, setTrigger] = useState<TriggerMatch | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const triggerRef = useRef<TriggerMatch | null>(null);

    useImperativeHandle(ref, () => ({
      getValue: () => innerRef.current?.getValue() ?? '',
      clear: () => {
        innerRef.current?.clear();
        setTrigger(null);
        triggerRef.current = null;
      },
      focus: () => innerRef.current?.focus(),
    }));

    // 初始值回填：编辑器挂载后写入一次（受控切换步骤时恢复草稿）
    useEffect(() => {
      if (initialValue) innerRef.current?.setValue(initialValue);
      // 仅挂载时执行一次（initialValue 变化由父层 remount key 处理）
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- / 菜单数据源（命令 + 技能 + 最近使用）----
    const recentRef = useRef(readRecentCommands());
    const [recentVersion, setRecentVersion] = useState(0);
    const commandItems = useMemo<MentionItem[]>(() => {
      const enabledCommands = commands.filter((c) => c.enabled !== false);
      const enabledSkills = skills.filter((s) => s.enabled !== false);
      const cmdByName = new Map(enabledCommands.map((c) => [c.name, c] as const));
      const skillByName = new Map(enabledSkills.map((s) => [s.name, s] as const));
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
      for (const c of enabledCommands) {
        if (!recentNames.has(c.name)) items.push(commandToItem(c, 'commands'));
      }
      for (const s of enabledSkills) {
        if (!recentNames.has(s.name) && !cmdByName.has(s.name)) items.push(skillToItem(s, 'skills'));
      }
      return items;
      // recentVersion：touchRecentCommand 后重算
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [commands, skills, recentVersion]);

    // ---- # 文件菜单数据源：工作目录搜索（防抖 200ms）----
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
            if (fileSearchSeqRef.current !== seq) return;
            setFileItems(
              files.map((f) => ({
                id: f.path,
                kind: 'file' as const,
                group: 'files' as const,
                name: f.name,
                desc: f.dir,
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

    const mentionItems = trigger
      ? trigger.kind === 'command'
        ? filterMentionItems(commandItems, trigger.query)
        : fileItems
      : [];

    // 名单：agents 传空数组 —— ask 回答禁用 `@`（粘贴 `@name` 也不会还原为 agent chip）
    const lookups = useMemo<MentionLookups>(
      () => buildMentionLookups(commands, skills, []),
      [commands, skills],
    );

    const handleTriggerChange = useCallback((match: TriggerMatch | null) => {
      const prev = triggerRef.current;
      if (!match && !prev) return;
      if (
        match &&
        prev &&
        prev.kind === match.kind &&
        prev.query === match.query &&
        prev.tokenStart === match.tokenStart
      ) {
        return;
      }
      if (match) setActiveIndex(0);
      triggerRef.current = match;
      setTrigger(match);
    }, []);

    const handleItemSelected = useCallback((item: MentionItem) => {
      if (item.kind === 'command' && item.data) {
        touchRecentCommand(item.data.source, item.data.name);
        recentRef.current = readRecentCommands();
        setRecentVersion((v) => v + 1);
      }
    }, []);

    const handlePasteFiles = useCallback(
      async (files: File[]) => {
        const saved: Array<{ path: string; name: string; size: number }> = [];
        for (const file of files) {
          if (file.size > PASTE_ATTACHMENT_MAX_BYTES) {
            toast.error(t('taskInput.pasteFileTooLarge', { name: file.name || '—' }));
            continue;
          }
          try {
            const dataBase64 = await fileToBase64(file);
            const name = file.name || `file-${Date.now()}.${extFromMime(file.type)}`;
            const { file: picked } = await api.saveAttachment({ name, dataBase64 });
            saved.push({ path: picked.path, name: picked.name, size: picked.size });
          } catch {
            toast.error(t('taskInput.pasteFileFailed'));
          }
        }
        if (saved.length > 0) onPasteAttachments?.(saved);
      },
      [onPasteAttachments, t],
    );

    const editorEl = (
      <MentionEditor
        ref={innerRef}
        placeholder={placeholder}
        trigger={trigger}
        items={mentionItems}
        activeIndex={activeIndex}
        onChange={(v) => onChange?.(v)}
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
        onSend={() => onSend?.()}
        allowedTriggers={['command', 'file']}
        // 内联紧凑：覆盖 MentionEditor 基类的 min-h-16 / min-w-40 / py-2，并限制最大高度滚动
        className={cn(inline ? 'min-h-0 min-w-0 py-1 max-h-24 text-sm' : 'max-h-28', className)}
      />
    );

    return (
      <div className={cn('relative', inline && 'min-w-0 flex-1')}>
        {trigger && (
          <MentionMenu
            items={mentionItems}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onSelect={(item) => innerRef.current?.commitMention(item)}
            loading={trigger.kind === 'file' && fileSearching}
            emptyText={trigger.kind === 'file' && isSystemScope ? t('taskInput.noWorkingDir') : undefined}
          />
        )}
        {inline ? (
          editorEl
        ) : (
          <div className="rounded-md border border-border bg-background px-2.5 py-1.5">{editorEl}</div>
        )}
      </div>
    );
  },
);
