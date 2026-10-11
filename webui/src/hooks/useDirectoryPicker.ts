// webui/src/hooks/useDirectoryPicker.ts
// 文件夹选择 hook：打开内置前端文件夹选择器（FolderPickerDialog），选中后落地工作目录 + 最近使用。
// 已弃用系统原生文件夹对话框（改为纯前端选择器：默认磁盘页、跨平台一致、图标与文件标签页同款）。

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useStore } from '../store';

export function useDirectoryPicker() {
  const { t } = useTranslation();
  const setWorkingDirectory = useStore((s) => s.setWorkingDirectory);
  const addRecentDirectory = useStore((s) => s.addRecentDirectory);
  /** 内置文件夹选择器弹窗开关 */
  const [browseOpen, setBrowseOpen] = useState(false);

  /** 触发选择：打开前端文件夹选择器 */
  const pickDirectory = useCallback(() => {
    setBrowseOpen(true);
  }, []);

  /** 选择器确认：写入工作目录 + 最近使用 */
  const onBrowserPicked = useCallback(
    (path: string) => {
      setWorkingDirectory(path);
      addRecentDirectory(path);
      setBrowseOpen(false);
      toast.success(t('directoryPicker.resolved'));
    },
    [setWorkingDirectory, addRecentDirectory, t],
  );

  const closeBrowser = useCallback(() => setBrowseOpen(false), []);

  return {
    pickDirectory,
    /** 内置文件夹选择器弹窗开关 */
    browseOpen,
    onBrowserPicked,
    closeBrowser,
  };
}