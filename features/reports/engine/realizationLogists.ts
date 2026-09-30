import type { DateRange } from '@/lib/period';
import type { ReportRow } from '@/lib/metrics/types';
import { loadPeriodRows, loadOverdue, loadLogists, loadCallLogistMap, loadCallAgg } from '@/lib/realizations/data';
import { callLogists, callAggToMetrics, callWorkdays, CALLS_DATA_FROM, EMPTY_CALL_AGG, type CallAgg } from '@/lib/realizations/callMetrics';
import { buildSummary } from '@/lib/realizations/metrics';
import { REGION_LABEL, type Region } from '@/lib/realizations/region';
import { summaryToMetrics } from '@/lib/realizations/logistMetrics';
import { mskYmd } from '@/lib/realizations/period';

// Движок «Сводки по логистам» / «Регионов» для /api/reports/run (задача #8126).
// Считает ТОЙ ЖЕ buildSummary, что прежний /api/realizations/summary (удалён в #8126) — формулы не
// меняются; «Итого» — общая строка buildSummary (медианы по всей совокупности).


/** «Глимнурова Эльвина (СПБ) Л106» → «Глимнурова Эльвина Л106»: регион уже в группе/подписи (находка 12). */
export function logistDisplayName(label: string): string {
  return label.replace(/\s*\((СПБ|МСК|КРД)\)\s*/i, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Звонки (задача #8314) по строкам отчёта: ключ строки — логист 1С или регион.
 * Ошибка чтения звонков не роняет сводку: колонки «Звонки» будут «—».
 */
async function loadCallsFor(from: string, to: string, today: string, by: 'logist' | 'region') {
  const workdays = callWorkdays(from, to, today);
  const empty = { owned: new Set<string>(), byKey: new Map<string, CallAgg>(), total: null as CallAgg | null, workdays, extra: new Map<string, { name: string; region: Region }>() };
  if (to < CALLS_DATA_FROM) return empty; // до начала сбора звонков данных нет — «—», а не нули
  try {
    const logists = callLogists(await loadCallLogistMap(), from, to);
    const ids: string[] = [], keys: string[] = [];
    const owned = new Set<string>();
    const extra = new Map<string, { name: string; region: Region }>();
    for (const o of logists.values()) {
      const key = by === 'logist' ? o.logistId : o.region;
      ids.push(o.logistId); keys.push(key); owned.add(key);
      if (by === 'logist') extra.set(o.logistId, { name: o.name, region: o.region });
    }
    const { byKey, total } = ids.length ? await loadCallAgg(from, to, ids, keys) : { byKey: new Map<string, CallAgg>(), total: null };
    return { owned, byKey, total: total ?? EMPTY_CALL_AGG, workdays, extra };
  } catch (e) {
    console.error('[reports/run realizations calls]', (e as Error).message ?? e);
    return empty;
  }
}

export async function fetchLogistReport(period: DateRange, by: 'logist' | 'region'): Promise<{ rows: ReportRow[]; grand: Record<string, number | null> }> {
  const from = mskYmd(period.from);
  const to = mskYmd(period.to);
  const today = mskYmd(new Date());
  const [rows, overdue, logists, calls] = await Promise.all([
    loadPeriodRows(from, to), loadOverdue(), loadLogists('2024-01-01'), loadCallsFor(from, to, today, by),
  ]);
  const names = new Map(logists.map(l => [l.id, l.name] as const));
  const s = buildSummary(rows, overdue, by, today, names);
  // Строка со звонками: у ключа есть учётка Битрикса → число (0, если звонков не было), иначе «—».
  const callMetrics = (key: string) => callAggToMetrics(calls.owned.has(key) ? calls.byKey.get(key) ?? EMPTY_CALL_AGG : null, calls.workdays);
  const out: ReportRow[] = s.rows.map(r => {
    const region = (by === 'region' ? r.key : r.region ?? 'Без региона') as Region;
    return {
      dimensionId: r.key,
      dimensionName: by === 'region' ? REGION_LABEL[region] ?? r.label : logistDisplayName(r.label),
      dimensionSubtitle: by === 'logist' ? REGION_LABEL[region] : undefined,
      teamId: by === 'logist' ? region : null,
      teamName: by === 'logist' ? REGION_LABEL[region] ?? region : null,
      branchName: null,
      metrics: { ...summaryToMetrics(r), ...callMetrics(r.key) },
    };
  });
  // Логисты/регионы, у которых за период есть звонки, но нет заявок, — отдельной строкой,
  // иначе их звонки попали бы в «Итого», но не в строки.
  const present = new Set(s.rows.map(r => r.key));
  for (const [key, agg] of calls.byKey) {
    if (present.has(key) || agg.total === 0) continue;
    const info = calls.extra.get(key);
    const region = (by === 'region' ? key : info?.region ?? 'Без региона') as Region;
    out.push({
      dimensionId: key,
      dimensionName: by === 'region' ? REGION_LABEL[region] ?? key : logistDisplayName(info?.name ?? key),
      dimensionSubtitle: by === 'logist' ? REGION_LABEL[region] : undefined,
      teamId: by === 'logist' ? region : null,
      teamName: by === 'logist' ? REGION_LABEL[region] ?? region : null,
      branchName: null,
      metrics: callMetrics(key),
    });
  }
  return { rows: out, grand: { ...summaryToMetrics(s.total), ...callAggToMetrics(calls.total, calls.workdays) } };
}
