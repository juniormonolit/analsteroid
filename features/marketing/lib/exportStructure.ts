// Выгрузка структуры «Ещё → Источники» в Excel (задача владельца 22.10). Два листа:
// «Источники» — каждый source_id строкой, по колонке на группировку (название группы,
// пусто = не распределено), плюс сделки и заметка — удобно фильтровать/сверять в Excel;
// «Группы» — сводка: группировка → группа → источников / сделок за 90 дн. / всего.
// Библиотека — `xlsx` (SheetJS), как features/reports/lib/exportExcel.ts; динамический
// import — в основной бандл не попадает.
import { downloadBlob } from '@/features/reports/lib/downloadBlob';

export interface ExportGrouping { id: number; name: string }
export interface ExportGroup { id: number; groupingId: number; name: string }
export interface ExportSource {
  sourceId: string; name: string; category: string; note: string | null; inDirectory: boolean;
  deals: number; deals90: number; lastAt: string | null; assign: Record<number, number>;
}

const UNASSIGNED = 'Не распределено';

export async function exportStructureToExcel(
  groupings: ExportGrouping[], groups: ExportGroup[], sources: ExportSource[],
): Promise<void> {
  const XLSX = await import('xlsx');
  const groupName = new Map(groups.map(g => [g.id, g]));
  const groupOf = (s: ExportSource, gr: ExportGrouping) => {
    const g = groupName.get(s.assign[gr.id]);
    return g && g.groupingId === gr.id ? g.name : '';
  };

  // Лист 1: источники
  const head = ['ID', 'Название', 'Тип', 'Новый', ...groupings.map(g => g.name), 'Сделок за 90 дн.', 'Сделок всего', 'Последняя сделка', 'Заметка'];
  const rows = [...sources]
    .sort((a, b) => b.deals90 - a.deals90 || b.deals - a.deals)
    .map(s => [
      s.sourceId,
      s.name && s.name !== s.sourceId ? s.name : '',
      s.category === 'marketing' ? 'маркетинг' : s.category === 'system' ? 'системный' : s.category,
      s.inDirectory ? '' : 'да',
      ...groupings.map(gr => groupOf(s, gr)),
      s.deals90,
      s.deals,
      s.lastAt ? new Date(s.lastAt) : null,
      s.note ?? '',
    ]);
  const ws1 = XLSX.utils.aoa_to_sheet([head, ...rows], { cellDates: true });
  const dateCol = 4 + groupings.length + 2;
  for (let r = 1; r <= rows.length; r++) {
    const cell = ws1[XLSX.utils.encode_cell({ r, c: dateCol })];
    if (cell) cell.z = 'dd.mm.yyyy';
  }
  ws1['!cols'] = [{ wch: 10 }, { wch: 48 }, { wch: 11 }, { wch: 7 }, ...groupings.map(() => ({ wch: 20 })), { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 40 }];
  ws1['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: head.length - 1 } }) };
  ws1['!freeze'] = { xSplit: 2, ySplit: 1 };

  // Лист 2: сводка по группам
  const sum: (string | number)[][] = [['Группировка', 'Группа', 'Источников', 'Сделок за 90 дн.', 'Сделок всего']];
  for (const gr of groupings) {
    const acc = new Map<string, { n: number; d90: number; d: number }>();
    for (const g of groups.filter(x => x.groupingId === gr.id)) acc.set(g.name, { n: 0, d90: 0, d: 0 });
    acc.set(UNASSIGNED, { n: 0, d90: 0, d: 0 });
    for (const s of sources) {
      const a = acc.get(groupOf(s, gr) || UNASSIGNED)!;
      a.n++; a.d90 += s.deals90; a.d += s.deals;
    }
    for (const [name, a] of acc) {
      if (name === UNASSIGNED && a.n === 0) continue;
      sum.push([gr.name, name, a.n, a.d90, a.d]);
    }
  }
  const ws2 = XLSX.utils.aoa_to_sheet(sum);
  ws2['!cols'] = [{ wch: 22 }, { wch: 34 }, { wch: 12 }, { wch: 16 }, { wch: 14 }];
  ws2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sum.length - 1, c: 4 } }) };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Источники');
  XLSX.utils.book_append_sheet(wb, ws2, 'Группы');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  downloadBlob(
    new Blob([out as unknown as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `Структура источников ${stamp}.xlsx`,
  );
}
