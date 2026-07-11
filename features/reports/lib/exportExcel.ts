// Задача 1706: «Скачать Excel (.xlsx)» — типизированные ячейки (проценты как доля
// 0-1 с числовым форматом '0.0%'-стиля, деньги с '# ##0 ₽'-стилем, числа числами, не
// строками), а не голый текст. Библиотека — `xlsx` (SheetJS Community Edition):
// уже используется в проекте (app/api/plans/export/route.ts), не тянем вторую xlsx-либу
// (exceljs) ради веса бандла. Проверено (задача 1706, скретч-тест): community-редакция
// ПОДДЕРЖИВАЕТ запись numFmt (z) на ячейку — ограничение Pro-версии касается только
// cellStyles (шрифты/заливка/границы), которые здесь и не нужны. Динамический import() —
// либа не тянется в основной бандл, только по клику «Скачать Excel».
import type { ExportTable, ExportColumn } from './tableExport';
import { downloadBlob } from './downloadBlob';

function numFmtFor(col: ExportColumn): string {
  const dec = Math.max(0, col.decimalPlaces);
  const decimals = dec > 0 ? `.${'0'.repeat(dec)}` : '';
  if (col.dataType === 'percent') return `0${decimals}%`;
  if (col.dataType === 'money') return `# ##0${decimals} ₽`; // ₽
  return `0${decimals}`;
}

export async function exportTableToExcel(table: ExportTable, filenameBase: string): Promise<void> {
  const XLSX = await import('xlsx');

  const header = [table.dimensionLabel, ...table.columns.map(c => c.header)];
  const aoa: (string | number | null)[][] = [header];
  for (const r of table.rows) aoa.push([r.label, ...r.values]);
  if (table.totalsRow) aoa.push(['Итого', ...table.totalsRow]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const dataRowCount = aoa.length - 1; // минус заголовок

  table.columns.forEach((col, colIdx) => {
    const excelCol = colIdx + 1; // колонка 0 — измерение (менеджер/товарная группа/источник)
    const fmt = numFmtFor(col);
    const isPercent = col.dataType === 'percent';
    for (let r = 1; r <= dataRowCount; r++) {
      const addr = XLSX.utils.encode_cell({ r, c: excelCol });
      const cell = ws[addr];
      if (!cell || typeof cell.v !== 'number') continue;
      // Тот же фикс, что и в буфере обмена: проценты — доля (0.145), не «человеческое»
      // число (14.5) — иначе Excel с процентным форматом домножит ещё раз на 100.
      if (isPercent) cell.v = cell.v / 100;
      cell.z = fmt;
      cell.t = 'n';
    }
  });

  ws['!cols'] = [{ wch: 26 }, ...table.columns.map(() => ({ wch: 14 }))];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Отчёт');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
  downloadBlob(
    new Blob([out as unknown as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${filenameBase}.xlsx`
  );
}
