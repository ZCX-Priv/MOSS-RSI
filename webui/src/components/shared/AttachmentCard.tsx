// components/shared/AttachmentCard.tsx
// 发送框附件卡片：图标徽章 + 文件名 + "大写扩展名 大小" 副标题 + 移除按钮。
// 图片附件渲染缩略图（加载中显示环形 spinner），其余按文件类型出彩色图标。

import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatFileSize, getAttachmentKind } from '@/lib/utils';
import { FileTypeIcon, useFileThumbnail } from './FileTypeIcon';

/** 卡片副标题用的大写扩展名（无扩展名显示 FILE） */
export function attachmentExtLabel(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return 'FILE';
  return name.slice(idx + 1).toUpperCase();
}

export interface SendAttachmentCardProps {
  /** 本地绝对路径（悬浮提示展示用） */
  path: string;
  name: string;
  size: number;
  onRemove: () => void;
  /** 点击卡片在右侧边栏预览该文件；未提供时卡片不可点 */
  onOpen?: () => void;
}

export function SendAttachmentCard({ path, name, size, onRemove, onOpen }: SendAttachmentCardProps) {
  const { t } = useTranslation();
  const isImage = getAttachmentKind(name, '') === 'image';
  const thumb = useFileThumbnail(path, isImage);

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        {/* 根元素保持 div：卡片内有「移除」按钮，button 不能嵌套 button；
            onOpen 存在时补 role/tabIndex/键盘处理，获得等价的点击与键盘可达性 */}
        <div
          onClick={onOpen}
          role={onOpen ? 'button' : undefined}
          tabIndex={onOpen ? 0 : undefined}
          onKeyDown={
            onOpen
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen();
                  }
                }
              : undefined
          }
          className={cn(
            'group relative flex h-14 w-60 shrink-0 items-center gap-2.5 rounded-xl border border-border bg-muted/40 py-2 pl-1.5 pr-3 transition-colors duration-150 hover:border-foreground/20',
            onOpen && 'cursor-pointer',
          )}
        >
          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-background/80">
            {isImage ? (
              thumb !== null ? (
                <img src={thumb} alt={name} className="size-full object-cover" loading="lazy" />
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground/70" />
              )
            ) : (
              <FileTypeIcon fileName={name} size={26} />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium leading-tight">{name}</span>
            <span className="truncate text-[11px] leading-tight text-muted-foreground">
              {attachmentExtLabel(name)} {formatFileSize(size)}
            </span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              // 阻止冒泡：点「移除」不应顺带触发卡片的「打开预览」
              e.stopPropagation();
              onRemove();
            }}
            className="absolute -right-1.5 -top-1.5 flex size-[18px] cursor-pointer items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm transition-colors duration-150 hover:text-foreground"
            title={t('taskInput.removeAttachment')}
          >
            <X className="size-3" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs break-all">
        {path}
      </TooltipContent>
    </Tooltip>
  );
}