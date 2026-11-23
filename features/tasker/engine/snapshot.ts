// Снимок цифр менеджера (TASKER_SPEC.md, «Снимок»):
//   value    — ячейка менеджера в отчёте «По менеджерам» за период (dealScope 'all');
//   deptAvg  — строка «Итого» его отдела (группировка по отделам — взвешенно, как в отчёте);
//   ownAvg6m — его же ячейка за 6 полных месяцев до периода (для счётчиков — приведена к
//              длине периода, иначе сравнивали бы месяц с полугодом);
//   enoughData — сумма знаменателей метрики за период ≥ 5.
import type { Snapshot, TaskerPeriod } from '../types';
import { cached } from '@/lib/cache/redis';
import { addDaysYmd, daysBetween, MIN_DENOMINATOR, mskToday, type TaskerMetricDef } from './config';
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

/**
 * 6 полных календарных месяцев до месяца, в котором начинается период.
 *
 * Якорь — месяц дня ПОСЛЕ period.from, а не самого from: форма переводит период отчёта в дату по часовому
 * поясу браузера, и у браузера в UTC «01.11 00:00 МСК» приходит как 2026-10-31 (баг 23.11, Бибиков, CR ППП:
 * 43,7% ↔ 41,7% — окно прыгало между май–окт и апр–сен, а значение и среднее отдела почти не менялись: 31.10 —
 * суббота). Период, начинающийся в последний день месяца, по смыслу относится к следующему месяцу; для любого
 * другого начала результат прежний.
 */
export function ownAvgWindow(period: TaskerPeriod): TaskerPeriod {
  const anchor = addDaysYmd(period.from, 1);
  const [y, m] = anchor.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1 - 6, 1)).toISOString().slice(0, 10);
  const end = addDaysYmd(`${anchor.slice(0, 7)}-01`, -1);
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

// ── Компактные таблицы прогонов (то, что кэшируется) ──────────────────────────

interface CurTable {
  rows: Record<string, { value: number | null; denom: number | null; teamId: string | null; teamName: string | null }>;
  /** teamId (или '__no_team__') → значение строки «Итого» отдела. */
  teams: Record<string, number | null>;
}
type HistTable = Record<string, number | null>;

async function curTable(run: ReportRunner, metric: TaskerMetricDef, period: TaskerPeriod): Promise<CurTable> {
  const cur = await run(periodBody(metric, period.from, period.to, 'team'));
  const rows: CurTable['rows'] = {};
  for (const r of cur.rows ?? []) {
    rows[String(r.dimensionId)] = { value: cellOf(r, metric.id), denom: denominatorOf(r, metric), teamId: r.teamId ?? null, teamName: r.teamName ?? null };
  }
  const teams: CurTable['teams'] = {};
  for (const g of cur.grouped ?? []) {
    const id = String(g.dimensionId);
    if (id.startsWith('__team__')) teams[id.slice('__team__'.length)] = cellOf(g, metric.id);
  }
  return { rows, teams };
}

async function histTable(run: ReportRunner, metric: TaskerMetricDef, win: TaskerPeriod): Promise<HistTable> {
  const hist = await run(periodBody(metric, win.from, win.to, 'none'));
  const out: HistTable = {};
  for (const r of hist.rows ?? []) out[String(r.dimensionId)] = cellOf(r, metric.id);
  return out;
}

// Кэш: Redis (общий между инстансами/рестартами) + склейка одновременных одинаковых запросов в процессе —
// форма и карточка дёргают снимок параллельно, а прогон отчёта за 6 месяцев — самое дорогое здесь.
// Ключ включает срез того, кто смотрит (scopeKey): «Итого отдела» в отчёте режется его зоной.
const inflight = new Map<string, Promise<unknown>>();
function memo<T>(key: string, ttlSec: number, producer: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = cached(key, ttlSec, producer).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Период ещё «живой» (включает последние 2 дня — синк доносит задним числом) — короткий TTL. */
function ttlFor(to: string): number {
  return to >= addDaysYmd(mskToday(), -2) ? 5 * 60 : 6 * 3600;
}

/**
 * Снимки для нескольких менеджеров: два прогона отчёта (период с группировкой по отделам + окно 6 мес.),
 * параллельно, оба кэшируются целиком на срез — любой набор менеджеров того же среза берётся из кэша.
 * Менеджер вне среза того, чей runner, просто не найдётся в строках — получит пустой снимок.
 * cacheScope — ключ среза (null — без кэша: автозамер считает свежо).
 */
export async function computeSnapshots(
  run: ReportRunner,
  managerIds: string[],
  metric: TaskerMetricDef,
  period: TaskerPeriod,
  opts: { withOwnAvg?: boolean; cacheScope?: string | null } = {},
): Promise<Record<string, SnapshotWithMeta>> {
  const withOwn = opts.withOwnAvg !== false;
  const win = ownAvgWindow(period);
  const scope = opts.cacheScope;
  const v = 'v1';
  const [cur, hist] = await Promise.all([
    scope
      ? memo(`tasker:snap:${v}:cur:${scope}:${metric.id}:${period.from}:${period.to}`, ttlFor(period.to), () => curTable(run, metric, period))
      : curTable(run, metric, period),
    !withOwn ? Promise.resolve(null)
      : scope
        ? memo(`tasker:snap:${v}:hist:${scope}:${metric.id}:${win.from}:${win.to}`, ttlFor(win.to), () => histTable(run, metric, win))
        : histTable(run, metric, win),
  ]);
  const scale = metric.additive ? daysBetween(period.from, period.to) / daysBetween(win.from, win.to) : 1;

  const out: Record<string, SnapshotWithMeta> = {};
  for (const id of managerIds) {
    const row = cur.rows[String(id)];
    const denom = row?.denom ?? (metric.denominatorIds.length && row ? 0 : null);
    const value = row?.value ?? null;
    const own = hist?.[String(id)] ?? null;
    out[id] = {
      value,
      deptAvg: row ? cur.teams[row.teamId ?? '__no_team__'] ?? null : null,
      ownAvg6m: own === null ? null : own * scale,
      deptName: row?.teamName ?? null,
      enoughData: metric.denominatorIds.length ? (denom ?? 0) >= MIN_DENOMINATOR : value !== null,
      denominator: row ? denom : null,
      teamId: row?.teamId ?? null,
    };
  }
  return out;
}

/** Ключ кэша снимка по срезу сессии: админ — общий, остальные — свой (зона у каждого своя). */
export function snapshotCacheScope(scopeKind: string, sessionId: string): string {
  return scopeKind === 'all' ? 'all' : `u${sessionId}`;
}

export function stripMeta(s: SnapshotWithMeta): Snapshot {
  const { teamId: _t, ...rest } = s;
  void _t;
  return rest;
}
