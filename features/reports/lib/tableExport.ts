// Задача 1706 (владелец, экспорт отчёта): общий слой между «Копировать в буфер»,
// «Скачать Excel/PDF/PNG» — строит один нормализованный «экспортный» снимок таблицы
// из тех же данных, что рисует ReportTable (displayRows/orderedMetrics/totals), и
// форматирует значения ПО ТИПУ МЕТРИКИ (percent/money/int/decimal/months), а не парсит
// уже отформатированные строки регэкспами. Один источник форматирования на буфер И
// Excel — иначе форматы разъезжаются независимо (это и было причиной бага: копия в
// буфер и Excel раньше форматировались раздельно, вручную, без учёта dataType).
//
// Главный фикс (боль владельца 11.07): проценты хранятся в данных отчёта как «человеческое»
// число (14.5 = 14.5%, см. lib/format/index.ts::formatValue — там же value/100 перед
// Intl 'percent'). Копия в буфер и Excel-ячейка должны нести ДОЛЮ (0.145), не 14.5 —
// иначе в Excel с процентным форматом ячейки число домножается ещё раз на 100 (1450%).
import type { DataType, Metric } from '@/lib/metrics/types';
import type { Grouping } from '@/lib/metrics/types';

export interface ExportColumn {
  id: string;
  header: string;
  dataType: DataType;
  decimalPlaces: number;
}

export interface ExportRow {
  label: string;
  isGroup: boolean;
  values: (number | null)[];
}

export interface ExportTable {
  dimensionLabel: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  totalsRow: (number | null)[] | null;
}

// Структурная форма источника — совместима и с MergedRow (SalesReportPage.tsx), и с
// GroupedMergedRow (расширяет её isGroup?/children?) без прямого импорта этих типов
// (они не экспортированы из SalesReportPage.tsx, дублировать модуль ради экспорта типа
// не стали — оставили compile-time duck typing).
export interface ExportSourceRow {
  dimensionName: string;
  isGroup?: boolean;
  deltas: Record<string, { current: number | null } | undefined>;
  children?: ExportSourceRow[];
}

export interface ExportTotals {
  [metricId: string]: { current: number | null } | undefined;
}

export function buildExportTable(params: {
  dimensionLabel: string;
  metrics: Metric[];
  rows: ExportSourceRow[];
  totals?: ExportTotals | null;
  grouping: Grouping;
  metricDecimalOverrides?: Record<string, number>;
}): ExportTable {
  const columns: ExportColumn[] = params.metrics.map(m => ({
    id: m.id,
    header: m.nameRu,
    dataType: m.dataType,
    decimalPlaces: params.metricDecimalOverrides?.[m.id] ?? m.decimalPlaces,
  }));

  const rows: ExportRow[] = [];
  const pushRow = (r: ExportSourceRow) => {
    rows.push({
      label: r.dimensionName,
      isGroup: !!r.isGroup,
      values: columns.map(c => r.deltas[c.id]?.current ?? null),
    });
  };
  for (const r of params.rows) {
    pushRow(r);
    if (r.children) for (const c of r.children) pushRow(c);
  }

  // «Итого» уже присутствует как собственная строка при grouping === 'total' (см.
  // applyClientGrouping в SalesReportPage.tsx) — отдельную строку totals добавлять не надо,
  // иначе задвоение (тот же прежний баг избежан и в handleCopyTable).
  const totalsRow = params.totals && params.grouping !== 'total'
    ? columns.map(c => params.totals![c.id]?.current ?? null)
    : null;

  return { dimensionLabel: params.dimensionLabel, columns, rows, totalsRow };
}

// Значение для буфера обмена (TSV → Google Таблицы): десятичная запятая везде, без ₽ и
// разрядных пробелов. Проценты — ДОЛЯ (14.5 → «0,145»): делим на 100, точность
// decimalPlaces+2 (сдвиг на 2 знака при делении на 100, иначе теряем точность исходного
// значения — 14.5 при decimalPlaces=1 без сдвига дал бы «0,1»/«0,15» вместо «0,145»).
export function formatCellForClipboard(value: number | null, col: ExportColumn): string {
  if (value === null || value === undefined) return '';
  if (col.dataType === 'percent') {
    return (value / 100).toFixed(col.decimalPlaces + 2).replace('.', ',');
  }
  return value.toFixed(col.decimalPlaces).replace('.', ',');
}

const CLEAN_TSV = (s: string) => s.replace(/[\t\n]/g, ' ');

export function tableToTsv(table: ExportTable): string {
  const lines: string[] = [];
  lines.push([table.dimensionLabel, ...table.columns.map(c => CLEAN_TSV(c.header))].join('\t'));
  for (const r of table.rows) {
    lines.push([CLEAN_TSV(r.label), ...table.columns.map((c, i) => formatCellForClipboard(r.values[i], c))].join('\t'));
  }
  if (table.totalsRow) {
    lines.push(['Итого', ...table.columns.map((c, i) => formatCellForClipboard(table.totalsRow![i], c))].join('\t'));
  }
  return lines.join('\n');
}
