import type { DateRange } from '@/lib/period';
import type { ReportRow } from '@/lib/metrics/types';
import { loadPeriodRows, loadOverdue, loadLogists } from '@/lib/realizations/data';
import { buildSummary } from '@/lib/realizations/metrics';
import { REGION_LABEL, type Region } from '@/lib/realizations/region';
import { summaryToMetrics } from '@/lib/realizations/logistMetrics';
import { mskYmd } from '@/lib/realizations/period';

// Движок «Сводки по логистам» / «Регионов» для /api/reports/run (задача #8126).
// Считает ТОЙ ЖЕ buildSummary, что прежний /api/realizations/summary — формулы не
// меняются; «Итого» — общая строка buildSummary (медианы по всей совокупности).


/** «Глимнурова Эльвина (СПБ) Л106» → «Глимнурова Эльвина Л106»: регион уже в группе/подписи (находка 12). */
export function logistDisplayName(label: string): string {
  return label.replace(/\s*\((СПБ|МСК|КРД)\)\s*/i, ' ').replace(/\s{2,}/g, ' ').trim();
}

export async function fetchLogistReport(period: DateRange, by: 'logist' | 'region'): Promise<{ rows: ReportRow[]; grand: Record<string, number | null> }> {
  const from = mskYmd(period.from);
  const to = mskYmd(period.to);
  const [rows, overdue, logists] = await Promise.all([loadPeriodRows(from, to), loadOverdue(), loadLogists('2024-01-01')]);
  const names = new Map(logists.map(l => [l.id, l.name] as const));
  const today = mskYmd(new Date());
  const s = buildSummary(rows, overdue, by, today, names);
  return {
    rows: s.rows.map(r => {
      const region = (by === 'region' ? r.key : r.region ?? 'Без региона') as Region;
      return {
        dimensionId: r.key,
        dimensionName: by === 'region' ? REGION_LABEL[region] ?? r.label : logistDisplayName(r.label),
        dimensionSubtitle: by === 'logist' ? REGION_LABEL[region] : undefined,
        teamId: by === 'logist' ? region : null,
        teamName: by === 'logist' ? REGION_LABEL[region] ?? region : null,
        branchName: null,
        metrics: summaryToMetrics(r),
      };
    }),
    grand: summaryToMetrics(s.total),
  };
}
