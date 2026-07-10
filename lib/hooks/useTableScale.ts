'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type TableScalePct = 85 | 100 | 115;

// «Масштаб таблиц» ЛК (бриф 09.07, п.3): серверное per-user состояние (users.table_scale),
// общий queryKey ['table-scale'] — тот же паттерн, что useUiMode. Множитель (0.85/1/1.15)
// пробрасывается в ReportTable/DrilldownDrawer как tableScale и масштабирует кегль + высоту
// строк ВСЕХ таблиц отчётов пропорционально от базовых 30px (см. ReportTable.tsx).
export function useTableScale() {
  const qc = useQueryClient();
  const { data } = useQuery<{ tableScale: TableScalePct }>({
    queryKey: ['table-scale'],
    queryFn: async () => {
      const res = await fetch('/api/me/table-scale');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    staleTime: 60_000,
  });

  const tableScalePct = data?.tableScale ?? 100;

  async function setTableScale(pct: TableScalePct) {
    qc.setQueryData(['table-scale'], { tableScale: pct });
    await fetch('/api/me/table-scale', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableScale: pct }),
    });
    qc.invalidateQueries({ queryKey: ['table-scale'] });
  }

  return {
    tableScalePct,
    tableScaleMult: tableScalePct / 100,
    setTableScale,
  };
}
