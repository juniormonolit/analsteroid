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

/** Метрика «Сумма продаж» каталога — замер темы «товарная группа» (миграция 282). */
export const PG_AMOUNT_METRIC = 'all_sales_amount';

/**
 * Тело прогона «По менеджерам». Тема-показатель — ячейка метрики (+ знаменатели). Тема «товарная группа» —
 * «Сумма продаж» с фильтром по группе (productGroupId, шкала kc: тот же фильтр, что дрилл-даун отчёта
 * «По товарным группам» в менеджера); pgFilter=false — та же сумма без фильтра (знаменатель доли).
 */
function periodBody(metric: TaskerMetricDef, from: string, to: string, grouping: 'team' | 'none', pgFilter = true): Record<string, unknown> {
  const range = { from: `${from}T00:00:00.000+03:00`, to: `${to}T23:59:59.999+03:00` };
  const pg = metric.kind === 'product_group' && metric.productGroupId;
  return {
    reportSlug: 'by-managers',
    metricIds: pg ? [PG_AMOUNT_METRIC] : [metric.id, ...metric.denominatorIds],
    ...(pg && pgFilter ? { productGroupId: metric.productGroupId } : {}),
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

/** Доля продаж группы, %: сумма группы / вся сумма менеджера (отдела). Нет продаж вовсе — null. */
function share(part: number | null, whole: number | null): number | null {
  if (whole === null || whole <= 0) return null;
  return ((part ?? 0) / whole) * 100;
}

async function curTable(run: ReportRunner, metric: TaskerMetricDef, period: TaskerPeriod): Promise<CurTable> {
  if (metric.kind === 'product_group') return curTablePg(run, metric, period);
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

/** Тема «товарная группа»: сумма продаж группы или её доля. Второй прогон — без фильтра: из него список менеджеров
 *  (продавал, но не эту группу → 0 ₽ / 0%, а не «мало данных») и знаменатель доли. «Мало данных» — у менеджера
 *  за период нет ни одной продажи. */
async function curTablePg(run: ReportRunner, metric: TaskerMetricDef, period: TaskerPeriod): Promise<CurTable> {
  const isShare = metric.pgMeasure === 'share';
  const [part, whole] = await Promise.all([
    run(periodBody(metric, period.from, period.to, 'team', true)),
    run(periodBody(metric, period.from, period.to, 'team', false)),
  ]);
  const wholeRows = new Map((whole.rows ?? []).map(r => [String(r.dimensionId), r]));
  const partRows = new Map((part.rows ?? []).map(r => [String(r.dimensionId), r]));
  const rows: CurTable['rows'] = {};
  for (const [id, r] of wholeRows) {
    const p = partRows.get(id);
    const total = cellOf(r, PG_AMOUNT_METRIC);
    const amount = total !== null && total > 0 ? cellOf(p, PG_AMOUNT_METRIC) ?? 0 : null;
    const value = isShare ? share(amount, total) : amount;
    rows[id] = { value, denom: null, teamId: r.teamId ?? p?.teamId ?? null, teamName: r.teamName ?? p?.teamName ?? null };
  }
  const teams: CurTable['teams'] = {};
  for (const g of whole.grouped ?? []) {
    const id = String(g.dimensionId);
    if (!id.startsWith('__team__')) continue;
    const p = (part.grouped ?? []).find(x => String(x.dimensionId) === id);
    const total = cellOf(g, PG_AMOUNT_METRIC);
    const amount = total !== null && total > 0 ? cellOf(p, PG_AMOUNT_METRIC) ?? 0 : null;
    teams[id.slice('__team__'.length)] = isShare ? share(amount, total) : amount;
  }
  return { rows, teams };
}

async function histTable(run: ReportRunner, metric: TaskerMetricDef, win: TaskerPeriod): Promise<HistTable> {
  if (metric.kind === 'product_group') {
    const isShare = metric.pgMeasure === 'share';
    const [part, whole] = await Promise.all([
      run(periodBody(metric, win.from, win.to, 'none', true)),
      run(periodBody(metric, win.from, win.to, 'none', false)),
    ]);
    const out: HistTable = {};
    const partRows = new Map((part.rows ?? []).map(r => [String(r.dimensionId), r]));
    for (const r of whole.rows ?? []) {
      const id = String(r.dimensionId);
      const total = cellOf(r, PG_AMOUNT_METRIC);
      const amount = total !== null && total > 0 ? cellOf(partRows.get(id), PG_AMOUNT_METRIC) ?? 0 : null;
      out[id] = isShare ? share(amount, total) : amount;
    }
    return out;
  }
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
