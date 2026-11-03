// components/shared/FileTypeIcon.tsx
// 文件类型图标 + 图片附件缩略图 hook。
// 图标来源 react-material-icon-theme（VS Code Material Icon Theme）：按完整文件名 / 扩展名识别类型；
// 库无法识别时回退 lucide 附件（回形针）图标。
// 仅依赖 render/file 下的纯函数模块，避免把 markdown/katex 等重依赖带入首页包。

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchFileObjectUrl, getCachedObjectUrl, mimeOfPath } from '../../render/file/fetcher';
import { fileExtension } from '../../render/file/detector';
import { useDarkMode } from '../../render/core/use-dark-mode';

/**
 * react-material-icon-theme 内含约 1.1MB 图标数据：改为按需动态 import，
 * 不再进入首屏 main chunk。数据加载前用回形针兜底（通常一次会话内瞬间完成）。
 */
type MaterialIconLib = typeof import('react-material-icon-theme');
let libPromise: Promise<MaterialIconLib> | null = null;
function loadMaterialIconLib(): Promise<MaterialIconLib> {
  if (!libPromise) libPromise = import('react-material-icon-theme');
  return libPromise;
}

/**
 * 哨兵：库的图标清单里没有任何命中时返回该值（库默认 fallback 是 "file" 通用文档图标，
 * 无法与「命中通用图标」区分），用于判定「无法识别」→ 回退附件（回形针）图标。
 */
const NO_ICON = '\u0000moss-no-icon';

/** 库内是否真有该图标名对应的 SVG 数据（库清单存在「解析出名字但无数据」的条目） */
function hasIconData(lib: MaterialIconLib, name: string): boolean {
  return lib.getIconSvg(name) !== null;
}

export interface FileTypeIconProps {
  /** 文件名（含扩展名）：库按「完整文件名」（.gitignore / package.json 等）与「扩展名」两级匹配 */
  fileName: string;
  /** 图标边长（px），默认 22 */
  size?: number;
  className?: string;
}

export function FileTypeIcon({ fileName, size = 22, className }: FileTypeIconProps) {
  const dark = useDarkMode();
  const [lib, setLib] = useState<MaterialIconLib | null>(null);
  useEffect(() => {
    let alive = true;
    void loadMaterialIconLib()
      .then((loaded) => {
        if (alive) setLib(loaded);
      })
      .catch(() => {
        // 图标库加载失败：保持回形针兜底，不影响消息渲染
      });
    return () => {
      alive = false;
    };
  }, []);
  // 扩展名（小写、不带点）；无扩展名 → ''（库内部按 falsy 跳过该校验）
  const ext = fileExtension(fileName);
  const iconName = useMemo(() => {
    if (!lib) return NO_ICON;
    // 必须同时传 fileName 与 fileExtension：库的 fileName 匹配是「完整文件名精确相等」，
    // 只传 fileName 时普通扩展名文件会全部落到 fallback，表现为「所有文件同一个图标」。
    const base = lib.getFileIcon({ fileName, fileExtension: ext, fallback: NO_ICON });
    if (base === NO_ICON) return NO_ICON;
    // 深色模式优先 _light 变体；再校验库内确有 SVG 数据（否则库会渲染 📄 错误态）
    const light = `${base}_light`;
    if (dark && hasIconData(lib, light)) return light;
    if (hasIconData(lib, base)) return base;
    return hasIconData(lib, light) ? light : NO_ICON;
  }, [lib, fileName, ext, dark]);

  // 数据未加载 / 无法识别 → 回退附件图标（中性色，与彩色类型图标区分）
  if (!lib || iconName === NO_ICON) {
    return <Paperclip size={size} className={cn('shrink-0 text-muted-foreground', className)} />;
  }

  // 用已解析（且已选定明暗变体）的图标名直接渲染，避免 FileIcon 二次解析落到 📄 错误态
  return <lib.MaterialIcon name={iconName} size={size} className={className} alt={fileName} />;
}

/**
 * 固定尺寸的文件类型图标组件（菜单项等需要「组件形式」图标的场景）。
 * 与 FileTypeIcon 同源同检测，避免再出现第二套文件图标。
 * 注意：MaterialIcon 用内联 style 写死宽高，className 里的 size-* 会被覆盖，
 * 因此尺寸由本工厂的 size 参数决定。
 */
export function fileTypeIconComponent(
  fileName: string,
  size = 16,
): ComponentType<{ className?: string; size?: number }> {
  const Icon = ({ className }: { className?: string; size?: number }) => (
    <FileTypeIcon fileName={fileName} size={size} className={className} />
  );
  return Icon;
}

/**
 * 图片附件缩略图：仅 enabled（确为图片）时经 /api/filesystem/raw 拉取并生成 objectURL。
 * 返回 null 表示未就绪或加载失败（调用方回退类型图标 / spinner）。
 */
export function useFileThumbnail(path: string, enabled: boolean): string | null {
  // 初值取 objectURL 缓存：同一路径已加载过（再次进入会话）时首帧即缩略图，
  // 不再「先类型图标 → 异步拉到后再换图片」（消除「先粗后精」闪动）。
  const [url, setUrl] = useState<string | null>(() => (enabled ? getCachedObjectUrl(path) : null));
  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return;
    }
    const cached = getCachedObjectUrl(path);
    if (cached !== null) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    setUrl(null);
    void fetchFileObjectUrl(path, mimeOfPath(path))
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        // 加载失败：保持 null，调用方回退类型图标
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);
  return url;
}