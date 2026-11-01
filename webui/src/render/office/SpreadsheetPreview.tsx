// render/office/SpreadsheetPreview.tsx
// 通用电子表格预览（SheetJS）：xls / xlsb / ods / xlt 等非 OOXML 格式的兜底引擎。
// SheetJS 社区版不保留单元格样式（样式为 Pro 特性），故仅还原「值 + 合并 + 列宽」，
// 再交给统一观感组件 WorkbookViewer 渲染，保证与 OOXML 引擎观感一致。
// 本组件经 React.lazy 懒加载（FilePreviewPane 分发）。

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { WorkbookViewer } from './WorkbookViewer';
import type { MergeRange, SheetCell, SheetModel, WorkbookModel } from './sheet-model';

type CellValue = string | number | boolean | Date | null | undefined;

/** 单元格值 → 展示字符串（SheetJS cell.v 已按 raw:false 尽量格式化，这里兜底） */
function cellToString(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export interface SpreadsheetPreviewProps {
  buffer: ArrayBuffer;
  /** 原扩展名（xls/xlsb/ods/xlt…），用于空表提示文案 */
  ext: string;
  fileName: string;
}

export function SpreadsheetPreview({ buffer, ext, fileName }: SpreadsheetPreviewProps) {
  const [workbook, setWorkbook] = useState<WorkbookModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWorkbook(null);
    setError(null);
    void (async () => {
      try {
        // 动态 import（SheetJS 体积较大，仅在打开非 OOXML 表格时加载）
        const XLSX = await import('@e965/xlsx');
        const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
        const sheets: SheetModel[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const aoa = XLSX.utils.sheet_to_json<CellValue[]>(ws, {
            header: 1,
            raw: false,
            defval: '',
            blankrows: true,
          });
          const rows: SheetCell[][] = aoa.map((r) => (Array.isArray(r) ? r.map((v) => ({ value: cellToString(v) })) : []));
          // 列数：优先用 !ref（真实尺寸），再取行最大长度兜底
          let colCount = 1;
          if (ws['!ref']) {
            const range = XLSX.utils.decode_range(ws['!ref']);
            colCount = Math.max(colCount, range.e.c + 1);
          }
          for (const row of rows) colCount = Math.max(colCount, row.length);
          const merges: MergeRange[] = (ws['!merges'] ?? []).map((m) => ({
            s: { r: m.s.r, c: m.s.c },
            e: { r: m.e.r, c: m.e.c },
          }));
          const cols = ws['!cols'] ?? [];
          const colWidths = Array.from({ length: colCount }, (_, c) => cols[c]?.wch);
          return { name, rows, colCount, merges, colWidths };
        });
        if (!cancelled) setWorkbook({ sheets, truncated: false });
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buffer]);

  if (error !== null) {
    return <div className="flex h-full items-center justify-center text-sm text-destructive">{error}</div>;
  }
  if (workbook === null) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" />
        <span className="text-sm">{fileName}</span>
      </div>
    );
  }
  if (workbook.sheets.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{ext.toUpperCase()}</div>;
  }
  return <WorkbookViewer workbook={workbook} fileName={fileName} />;
}