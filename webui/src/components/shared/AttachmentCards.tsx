// components/shared/AttachmentCards.tsx
// 消息流用户消息的附件卡片行：
// 缩略图 / 类型图标 + 文件名 + 大写类型标签；超过 3 个时折叠为「前 2 张 + +N」，点击展开全部。
// 点击卡片 → onOpen(path)（由调用方在右侧边栏打开预览标签页）。

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp } from 'lucide-react';
import { getAttachmentKind } from '@/lib/utils';
import { fileNameOf } from '../../render/file/detector';
import { attachmentExtLabel } from './AttachmentCard';
import { FileTypeIcon, useFileThumbnail } from './FileTypeIcon';

/** 超过该数量时折叠为「前 N-1 张 + +M」 */
const MAX_VISIBLE = 3;

interface CardProps {
  path: string;
  onOpen: (path: string) => void;
}

function MessageAttachmentCard({ path, onOpen }: CardProps) {
  const name = fileNameOf(path);
  const isImage = getAttachmentKind(name, '') === 'image';
  const thumb = useFileThumbnail(path, isImage);

  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      title={path}
      className="flex min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-border bg-muted/40 px-2 py-1.5 text-left transition-colors hover:bg-muted"
    >
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background/60">
        {isImage ? (
          thumb !== null ? (
            <img src={thumb} alt={name} className="size-full object-cover" loading="lazy" />
          ) : (
            <FileTypeIcon fileName={name} size={22} />
          )
        ) : (
          <FileTypeIcon fileName={name} size={22} />
        )}
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="max-w-[160px] truncate text-xs font-medium leading-tight">{name}</span>
        <span className="text-[10px] uppercase leading-tight tracking-wide text-muted-foreground">
          {attachmentExtLabel(name)}
        </span>
      </div>
    </button>
  );
}

export interface MessageAttachmentCardsProps {
  /** 附件绝对路径列表（parseAttachmentBlock 解析结果） */
  paths: string[];
  onOpen: (path: string) => void;
}

export function MessageAttachmentCards({ paths, onOpen }: MessageAttachmentCardsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const unique = [...new Set(paths)];
  if (unique.length === 0) return null;

  const collapsible = unique.length > MAX_VISIBLE;
  const visible = collapsible && !expanded ? unique.slice(0, MAX_VISIBLE - 1) : unique;
  const hiddenCount = unique.length - visible.length;

  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
      {visible.map((p) => (
        <MessageAttachmentCard key={p} path={p} onOpen={onOpen} />
      ))}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? t('task.attachmentCollapse') : t('task.attachmentShowMore')}
          className="flex cursor-pointer items-center justify-center rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {expanded ? <ChevronUp className="size-4" /> : `+${hiddenCount}`}
        </button>
      )}
    </div>
  );
}