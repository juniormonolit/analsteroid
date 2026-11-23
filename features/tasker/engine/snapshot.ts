// Снимок цифр менеджера (TASKER_SPEC.md, «Снимок»):
//   value    — ячейка менеджера в отчёте «По менеджерам» за период (dealScope 'all');
//   deptAvg  — строка «Итого» его отдела (группировка по отделам — взвешенно, как в отчёте);
//   ownAvg6m — его же ячейка за 6 полных месяцев до периода (для счётчиков — приведена к
//              длине периода, иначе сравнивали бы месяц с полугодом);
//   enoughData — сумма знаменателей метрики за период ≥ 5.
import type { Snapshot, TaskerPeriod } from '../types';
import { addDaysYmd, daysBetween, MIN_DENOMINATOR, type TaskerMetricDef } from './config';
import { cellOf, type ReportRunner, type RunRow } from './reportRunner';

function periodBody(metric: TaskerMetricDef, from: string, to: string, grouping: 'team' | 'none'): Record<string, unknown> {
  const range = { from: `${from}T00:00:00.000+03:00`, to: `${to}T23:59:59.999+03:00` };
  return {
    reportSlug: 'by-managers',
    metricIds: [metric.id, ...metric.denominatorIds],
    dealScope: 'all',
    clientType: 'all',
    productGroupMode: 'kc',
    createdTimeFilter: 'all',
    firstTouchFilter: 'all',
    grouping,
    period: range,
    comparisonPeriod: range,
  };
}

/** 6 полных календарных месяцев до начала периода. */
export function ownAvgWindow(period: TaskerPeriod): TaskerPeriod {
  const [y, m] = period.from.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1 - 6, 1)).toISOString().slice(0, 10);
  const end = addDaysYmd(`${period.from.slice(0, 7)}-01`, -1);
  return { from: start, to: end };
}

function denominatorOf(row: RunRow | undefined, metric: TaskerMetricDef): number | null {
  if (!metric.denominatorIds.length || !row) return null;
  let sum = 0, seen = false;
  for (const id of metric.denominatorIds) {
    const v = cellOf(row, id);
    if (v !== null) { sum += v; seen = true; }
  }
  return seen ? sum : 0;
}

export interface SnapshotWithMeta extends Snapshot {
  teamId: string | null;
}

/**
 * Снимки для нескольких менеджеров одним прогоном на окно (2 прогона отчёта всего).
 * Менеджер вне среза того, чей runner, просто не найдётся в строках — получит пустой снимок.
 */
export async function computeSnapshots(
  run: ReportRunner,
  managerIds: string[],
  metric: TaskerMetricDef,
  period: TaskerPeriod,
  opts: { withOwnAvg?: boolean } = {},
): Promise<Record<string, SnapshotWithMeta>> {
  const withOwn = opts.withOwnAvg !== false;
  const win = ownAvgWindow(period);
  const [cur, hist] = await Promise.all([
    run(periodBody(metric, period.from, period.to, 'team')),
    withOwn ? run(periodBody(metric, win.from, win.to, 'none')) : Promise.resolve(null),
  ]);

  const rowsById = new Map((cur.rows ?? []).map(r => [String(r.dimensionId), r]));
  const teamRows = new Map(
    (cur.grouped ?? []).filter(g => String(g.dimensionId).startsWith('__team__')).map(g => [String(g.dimensionId).slice('__team__'.length), g]),
  );
  const histById = new Map((hist?.rows ?? []).map(r => [String(r.dimensionId), r]));
  const scale = metric.additive ? daysBetween(period.from, period.to) / daysBetween(win.from, win.to) : 1;

  const out: Record<string, SnapshotWithMeta> = {};
  for (const id of managerIds) {
    const row = rowsById.get(String(id));
    const teamKey = row?.teamId ?? '__no_team__';
    const team = row ? teamRows.get(teamKey) : undefined;
    const denom = denominatorOf(row, metric);
    const value = cellOf(row, metric.id);
    const own = cellOf(histById.get(String(id)), metric.id);
    out[id] = {
      value,
      deptAvg: cellOf(team, metric.id),
      ownAvg6m: own === null ? null : own * scale,
      deptName: row?.teamName ?? null,
      enoughData: metric.denominatorIds.length ? (denom ?? 0) >= MIN_DENOMINATOR : value !== null,
      denominator: denom,
      teamId: row?.teamId ?? null,
    };
  }
  return out;
}

export function stripMeta(s: SnapshotWithMeta): Snapshot {
  const { teamId: _t, ...rest } = s;
  void _t;
  return rest;
}
