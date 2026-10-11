// render/office/WorkbookViewer.tsx
// 统一电子表格观感组件：顶部公式栏（名称框 + fx + 值）+ 行列标 + 冻结表头
// + 合并单元格 + 单元格样式 + 点击选中并回显 + 底部工作表标签 + 右下缩放 + 分页。
// 两个引擎（自写 OOXML parser / SheetJS 兜底）都归一化成 WorkbookModel 后交给本组件渲染，
// 保证任意表格格式的观感一致。纯展示组件，不感知具体解析引擎。

import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { cellRefLabel, columnLabel, type CellStyle, type MergeRange, type WorkbookModel } from './sheet-model';

/** 每屏渲染行数（超出用「加载更多」，防万行 DOM 卡顿） */
const PAGE_ROWS = 200;
const BASE_FONT_PX = 13;
/** 未提供列宽时的默认列宽（px） */
const DEFAULT_COL_PX = 88;
/** OOXML 字符宽 / SheetJS wch → px 的近似换算 */
const colWidthPx = (chars: number): number => Math.max(48, Math.round(chars * 7.5 + 5));

/** CellStyle → 内联 CSS */
function cssOf(style: CellStyle | undefined): CSSProperties | undefined {
  if (!style) return undefined;
  const css: CSSProperties = {};
  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = 'italic';
  if (style.underline) css.textDecoration = 'underline';
  if (style.strike) css.textDecoration = `${css.textDecoration ?? ''} line-through`.trim();
  if (style.fontSize) css.fontSize = `${style.fontSize}px`;
  if (style.color) css.color = style.color;
  if (style.bg) css.backgroundColor = style.bg;
  if (style.align) css.textAlign = style.align;
  if (style.valign) css.verticalAlign = style.valign;
  if (style.wrap) css.whiteSpace = 'pre-wrap';
  if (style.border) {
    css.borderLeft = css.borderRight = css.borderTop = css.borderBottom = '1px solid var(--border, #d4d4d8)';
  }
  return Object.keys(css).length > 0 ? css : undefined;
}

export interface WorkbookViewerProps {
  workbook: WorkbookModel;
  /** 空表提示用文件名 */
  fileName: string;
}

export function WorkbookViewer({ workbook, fileName }: WorkbookViewerProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const [activeCell, setActiveCell] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [visibleRows, setVisibleRows] = useState(PAGE_ROWS);
  const [zoom, setZoom] = useState(1);

  const sheet = workbook.sheets[active] ?? workbook.sheets[0];

  /** 合并覆盖格（起点格之外） */
  const covered = useMemo(() => {
    const set = new Set<string>();
    if (!sheet) return set;
    for (const m of sheet.merges) {
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (r !== m.s.r || c !== m.s.c) set.add(`${r}:${c}`);
        }
      }
    }
    return set;
  }, [sheet]);

  /** 命中的合并区域（点击落在合并区内时归一化到起点） */
  const mergeAt = (r: number, c: number): MergeRange | undefined =>
    sheet?.merges.find((m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c);

  const spanOf = (r: number, c: number): { rowSpan?: number; colSpan?: number } => {
    const m = mergeAt(r, c);
    if (!m || m.s.r !== r || m.s.c !== c) return {};
    return { rowSpan: m.e.r - m.s.r + 1, colSpan: m.e.c - m.s.c + 1 };
  };

  if (!sheet || sheet.rows.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{fileName}</div>;
  }

  const colCount = sheet.colCount;
  const totalRows = sheet.rows.length;
  const rowsToRender = sheet.rows.slice(0, visibleRows);

  const selStart = mergeAt(activeCell.r, activeCell.c)?.s ?? activeCell;
  const activeValue = sheet.rows[activeCell.r]?.[activeCell.c]?.value ?? '';
  const isSelected = (r: number, c: number): boolean => r === selStart.r && c === selStart.c;

  const pickCell = (r: number, c: number) => {
    const m = mergeAt(r, c);
    setActiveCell(m ? { ...m.s } : { r, c });
  };

  const switchSheet = (index: number) => {
    setActive(index);
    setActiveCell({ r: 0, c: 0 });
    setVisibleRows(PAGE_ROWS);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {/* 公式栏：名称框 + fx + 值 */}
      <div className="flex shrink-0 items-stretch overflow-hidden rounded border border-border bg-background text-xs">
        <div
          className="sheet-namebox flex w-[4.5rem] shrink-0 items-center justify-center border-r border-border font-mono tabular-nums text-foreground"
          aria-label={t('preview.sheetNameBox')}
        >
          {cellRefLabel(activeCell.r, activeCell.c)}
        </div>
        <div className="flex shrink-0 items-center border-r border-border px-2 italic text-muted-foreground">fx</div>
        <div
          className="flex min-w-0 flex-1 items-center px-2 font-mono text-foreground"
          aria-label={t('preview.sheetFormulaBar')}
          title={activeValue}
        >
          <span className="truncate">{activeValue}</span>
        </div>
      </div>

      {/* 表格区（行号列 + 列标行冻结） */}
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border" style={{ fontSize: `${BASE_FONT_PX * zoom}px` }}>
        <table className="sheet-grid" style={{ borderSpacing: 0 }}>
          <colgroup>
            <col style={{ width: '3em' }} />
            {Array.from({ length: colCount }).map((_, c) => (
              <col
                key={c}
                style={{ width: `${sheet.colWidths[c] ? colWidthPx(sheet.colWidths[c] as number) : DEFAULT_COL_PX}px` }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sheet-hdr sticky left-0 top-0 z-30 px-1 py-0.5 text-center" />
              {Array.from({ length: colCount }).map((_, c) => (
                <th
                  key={c}
                  className={`sheet-hdr sticky top-0 z-20 px-2 py-0.5 text-center font-normal ${
                    c === activeCell.c ? 'text-foreground' : ''
                  }`}
                >
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsToRender.map((row, r) => (
              <tr key={r}>
                <th
                  className={`sheet-hdr sticky left-0 z-10 px-1 py-0.5 text-right font-normal tabular-nums ${
                    r === activeCell.r ? 'text-foreground' : ''
                  }`}
                >
                  {r + 1}
                </th>
                {Array.from({ length: colCount }).map((_, c) => {
                  if (covered.has(`${r}:${c}`)) return null;
                  const cell = (row ?? [])[c];
                  const span = spanOf(r, c);
                  return (
                    <td
                      key={c}
                      rowSpan={span.rowSpan}
                      colSpan={span.colSpan}
                      className={`sheet-cell cursor-cell px-2 py-0.5 align-bottom text-foreground ${
                        isSelected(r, c) ? 'sheet-cell-sel sheet-cell-active' : ''
                      }`}
                      style={cssOf(cell?.style)}
                      onClick={() => pickCell(r, c)}
                    >
                      {cell?.value ?? ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibleRows < totalRows && (
        <div className="shrink-0 text-center">
          <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={() => setVisibleRows((n) => n + PAGE_ROWS)}>
            {rowsToRender.length} / {totalRows}
          </Button>
        </div>
      )}

      {/* 底部状态栏：工作表标签 + 截断提示 + 缩放 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border pt-1.5">
        <div role="tablist" className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
          {workbook.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={`sheet-tab ${i === active ? 'sheet-tab-active' : ''}`}
              onClick={() => switchSheet(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {workbook.truncated && (
            <span className="text-[11px] text-muted-foreground">{t('preview.sheetTruncated')}</span>
          )}
          <Button variant="outline" size="sm" className="h-6 w-6 p-0 text-xs" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}>
            −
          </Button>
          <span className="min-w-11 text-center text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <Button variant="outline" size="sm" className="h-6 w-6 p-0 text-xs" onClick={() => setZoom((z) => Math.min(2.5, z + 0.1))}>
            +
          </Button>
        </div>
      </div>
    </div>
  );
}