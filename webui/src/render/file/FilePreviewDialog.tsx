// render/file/FilePreviewDialog.tsx
// 全屏文件预览弹层：Dialog 外壳 + FilePreviewPane（渲染分发在 pane 内，与侧边栏预览共用）。

import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { fileNameOf } from './detector';
import { FilePreviewPane } from './FilePreviewPane';

export interface FilePreviewDialogProps {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FilePreviewDialog({ path, open, onOpenChange }: FilePreviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="overflow-hidden">
        <DialogHeader>
          <DialogTitle className="truncate pr-6 font-mono text-sm" title={path}>
            {fileNameOf(path)}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="gap-0 overflow-y-hidden px-0 py-0">
          <FilePreviewPane path={path} active={open} heightClass="h-full" />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}