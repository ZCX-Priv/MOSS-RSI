// render/data/CsvPreview.tsx
// CSV/TSV 表格预览：自写 RFC4180 解析 → 统一电子表格观感组件 WorkbookViewer
// 与 xlsx 家族观感一致：行号/列标/公式栏/单元格选中。
// 行/列超阈值或解析异常 → 回退 CodeFileViewer（文本 + 行号）。
// 本组件经 React.lazy 懒加载（FilePreviewPane 分发）。

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { parseDelimited, delimiterForExt } from './csv';
import { CodeFileViewer } from '../code/CodeFileViewer';
import { WorkbookViewer } from '../office/WorkbookViewer';
import { fileNameOf } from '../file/detector';
import type { SheetCell, SheetModel, WorkbookModel } from '../office/sheet-model';

/** 表格渲染上限：超过则回退文本视图（避免超大表格卡死 DOM） */
const MAX_ROWS = 3_000;
const MAX_COLS = 200;
/** 列宽启发式上下限（按最长单元格字符数估算，clamp 到该区间） */
const MIN_COL_CHARS = 8;
const MAX_COL_CHARS = 40;

export interface CsvPreviewProps {
  text: string;
  path: string;
  ext: string;
}

/** 解析后的二维数组 → 单表 WorkbookModel（无样式/合并，仅值 + 估算列宽） */
function toWorkbook(rows: string[][], sheetName: string): WorkbookModel {
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const cells: SheetCell[][] = rows.map((r) =>
    Array.from({ length: colCount }, (_, c) => ({ value: r[c] ?? '' })),
  );
  const colWidths = Array.from({ length: colCount }, (_, c) => {
    const maxLen = rows.reduce((m, r) => Math.max(m, (r[c] ?? '').length), 0);
    return Math.min(MAX_COL_CHARS, Math.max(MIN_COL_CHARS, maxLen));
  });
  const sheet: SheetModel = { name: sheetName, rows: cells, colCount, merges: [], colWidths };
  return { sheets: [sheet], truncated: false };
}

export function CsvPreview({ text, path, ext }: CsvPreviewProps) {
  const { t } = useTranslation();

  const parsed = useMemo(() => {
    try {
      const rows = parseDelimited(text, delimiterForExt(ext));
      const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
      if (rows.length === 0 || rows.length > MAX_ROWS || cols > MAX_COLS) return null;
      return rows;
    } catch {
      return null;
    }
  }, [text, ext]);

  if (parsed === null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-1">
        <div className="shrink-0 rounded border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
          {t('preview.dataParseFailed')}
        </div>
        <div className="min-h-0 flex-1">
          <CodeFileViewer text={text} path={path} />
        </div>
      </div>
    );
  }

  const fileName = fileNameOf(path);
  const sheetName = fileName.replace(/\.[^.]+$/, '') || 'CSV';
  const workbook = toWorkbook(parsed, sheetName);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkbookViewer workbook={workbook} fileName={fileName} />
    </div>
  );
}