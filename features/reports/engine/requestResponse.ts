import type { DateRange } from '@/lib/period';
import type { ReportRow } from '@/lib/metrics/types';
import { aggregate, deptOf, projectRegion, type AggRow } from '@/lib/supplyPanel/metrics';
import { periodBounds, requireSnapshot } from '@/lib/supplyPanel/http';
import { RESPONSE_METRIC_IDS, spKey } from '@/lib/realizations/responseMetrics';

// Движок отчёта «Ответы на запросы» (slug 'requests-response' / 'requests-response-categories')
// по методике Панели снабжения: агрегат lib/supplyPanel/metrics.aggregate над снимком.
// «Итого» и подытоги регионов/департаментов — готовые срезы панели (total / region /
// dept), а не сумма строк: средние считаются по событиям, сделка у нескольких
// снабженцев в итоге одна.

export type ResponseBy = 'user' | 'group';

export interface ResponseResult {
  rows: ReportRow[];
  grand: Record<string, number | null>;
  /** Подытоги групп отчёта: grouping 'branch' → регион, 'team' → департамент. */
  groups: { branch: Record<string, Record<string, number | null>>; team: Record<string, Record<string, number | null>> };
  pulledAt: string | null;
}

function toMetrics(r: AggRow): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const id of RESPONSE_METRIC_IDS) {
    const v = (r as unknown as Record<string, unknown>)[spKey(id)!];
    out[id] = typeof v === 'number' ? v : null;
  }
  return out;
}

export async function fetchRequestResponse(period: DateRange, by: ResponseBy): Promise<ResponseResult> {
  const s = await requireSnapshot();
  const [d0, d1] = periodBounds(period.from, period.to);
  const agg = aggregate(s.facts, d0, d1);
  const rows: ReportRow[] = by === 'user'
    ? agg.user.map(r => ({
      dimensionId: String(r.key ?? 'none'),
      dimensionName: r.name,
      teamId: r.dep ?? null,
      teamName: r.dep ? `Департамент ${r.dep}` : null,
      branchName: r.reg ?? null,
      metrics: toMetrics(r),
    }))
    : agg.group.map(r => {
      const g = typeof r.key === 'number' ? r.key : null;
      const dep = deptOf(s.facts, g);
      return {
        dimensionId: String(r.key ?? 'none'),
        dimensionName: r.name,
        teamId: dep,
        teamName: `Департамент ${dep}`,
        branchName: projectRegion(s.facts, g),
        metrics: toMetrics(r),
      };
    });
  const groups: ResponseResult['groups'] = { branch: {}, team: {} };
  for (const r of agg.region) groups.branch[String(r.key)] = toMetrics(r);
  for (const r of agg.dept) groups.team[String(r.key)] = toMetrics(r);
  return { rows, grand: toMetrics(agg.total), groups, pulledAt: s.pulledAt };
}
