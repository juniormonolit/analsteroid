import { analyticsDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { buildProductGroupFilter } from './productGroupFilter';
import { computeCalculated } from './calculated';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import { addDays, startOfDay } from 'date-fns';
import type { Metric, DealScope, ClientType, CreatedTimeFilter, FirstTouchFilter, ProductGroupMode } from '@/lib/metrics/types';

// ── График метрики из отчёта (фича Серёги 01.08) ─────────────────────────────
// Динамика ОДНОЙ метрики внутри периода отчёта с разбивкой по дням/неделям/
// месяцам (МСК), с теми же определениями, что у ячейки отчёта: тот же
// buildCollectedSQL (sqlGen), те же границы периода (from как есть, toExcl =
// startOfDay(to)+1d — как в byManagers), те же фильтры (пилюли dealScope/
// clientType по funnel_id, товарные группы через buildProductGroupFilter,
// нерабочее время, ограничение по менеджерам). Никаких параллельных формул —
// сумма бакетов collected-метрики ОБЯЗАНА сходиться с ячейкой.
//
// Ограничение строки: клиент передаёт ЯВНЫЙ список manager-id (для строки — один,
// для отдела/филиала/группы/Итого — участники видимого отчёта) — так график
// гарантированно бьётся с ячейкой при любых client-side фильтрах (отделы,
// тип аккаунта), без дублирования их логики здесь.
//
// Поддержка: collected-метрики source='deals' и calculated поверх таких.
// External (звонки, стадии-снимки, планы, медианы) и deal_events-based —
// честно «не поддержано» (у них свои движки без универсальной разбивки).

export type SeriesGranularity = 'day' | 'week' | 'month';

export interface MetricSeriesOptions {
  metricId: string;
  period: { from: Date; to: Date };
  granularity: SeriesGranularity;
  dealScope?: DealScope;
  clientType?: ClientType;
  managerIds?: string[];          // явное ограничение строк (см. шапку)
  productGroupMode?: ProductGroupMode;
  productGroupId?: string;
  productGroupIds?: string[];
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  /** «Фильтр сделок» (задача 07.08): режет сам набор сделок отчёта. */
  dealFilters?: DealFilter[];
}

export interface SeriesBucket { bucket: string; value: number | null }
export interface MetricSeriesResult {
  supported: boolean;
  reason?: string;
  buckets: SeriesBucket[];
  /** Итог за период ТЕМ ЖЕ способом, что в отчёте: сумма для collected,
   *  формула от сумм для calculated (проценты НЕ суммируются по бакетам). */
  total: number | null;
}

function collectible(m: Metric): boolean {
  return m.metricType === 'collected' && !!m.aggFn && !!m.aggField && !!m.dateField && m.source === 'deals';
}

/** Какие collected-зависимости нужны для серии; null = метрика не поддержана. */
export function seriesDeps(metric: Metric, all: Metric[]): { deps: Metric[]; reason?: string } | null {
  if (collectible(metric)) return { deps: [metric] };
  if (metric.metricType === 'calculated') {
    const byId = new Map(all.map(m => [m.id, m]));
    const deps = metric.dependencies.map(id => byId.get(id)).filter((m): m is Metric => !!m);
    if (deps.length === metric.dependencies.length && deps.every(collectible)) return { deps };
    return null;
  }
  return null;
}

const MSK = 'Europe/Moscow';

function bucketStartYmd(d: Date, unit: SeriesGranularity): string {
  // Дата в МСК
  const msk = new Date(d.getTime() + 3 * 3600_000);
  let y = msk.getUTCFullYear(), mo = msk.getUTCMonth(), day = msk.getUTCDate();
  if (unit === 'month') day = 1;
  if (unit === 'week') {
    const dow = (new Date(Date.UTC(y, mo, day)).getUTCDay() + 6) % 7; // 0=пн
    const t = new Date(Date.UTC(y, mo, day - dow));
    y = t.getUTCFullYear(); mo = t.getUTCMonth(); day = t.getUTCDate();
  }
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function nextBucketYmd(ymd: string, unit: SeriesGranularity): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = unit === 'month' ? new Date(Date.UTC(y, m, 1))
    : new Date(Date.UTC(y, m - 1, d + (unit === 'week' ? 7 : 1)));
  return t.toISOString().slice(0, 10);
}

interface FunnelMeta { id: number; isRepeat: boolean }

function allowedFunnels(funnels: FunnelMeta[], dealScope: DealScope, clientType: ClientType): Set<number> | null {
  if (dealScope === 'all' && clientType === 'all') return null;
  return new Set(funnels.filter(f => {
    const scopeOk = dealScope === 'all' || (dealScope === 'primary' ? !f.isRepeat : f.isRepeat);
    const clientOk = clientType === 'all' || (clientType === 'b2c' ? [0, 2].includes(f.id) : [1, 3].includes(f.id));
    return scopeOk && clientOk;
  }).map(f => f.id));
}

export async function fetchMetricSeries(opts: MetricSeriesOptions): Promise<MetricSeriesResult> {
  const all = await loadMetrics();
  const metric = all.find(m => m.id === opts.metricId);
  if (!metric) return { supported: false, reason: 'Метрика не найдена', buckets: [], total: null };
  const sup = seriesDeps(metric, all);
  if (!sup) {
    return {
      supported: false,
      reason: 'Эта метрика считается вне сделок (звонки/стадии/планы/медианы) — у неё свой движок без универсальной разбивки по времени',
      buckets: [], total: null,
    };
  }
  const deps = sup.deps;

  const dealScope = opts.dealScope ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const unit = opts.granularity;

  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const funnelsRes = await analyticsDb().query<{ id: number; is_repeat: boolean }>('SELECT id, is_repeat FROM funnels');
  const funnels: FunnelMeta[] = funnelsRes.rows.map(r => ({ id: r.id, isRepeat: r.is_repeat }));

  const pgFilterInput = {
    productGroupMode: opts.productGroupMode ?? 'kc',
    productGroupId: opts.productGroupId,
    productGroupIds: opts.productGroupIds,
  };
  const pgFilter = buildProductGroupFilter(pgFilterInput, 2); // после [$1=from, $2=toExcl]
  const managerParamIdx = 3 + (pgFilter?.params.length ?? 0);
  const managerIds = (opts.managerIds ?? []).filter(v => /^\d+$/.test(v));
  const offhWhere = [
    createdTimeWhere('d', opts.createdTimeFilter ?? 'all'),
    firstTouchWhere('d', opts.firstTouchFilter ?? 'all'),
    buildDealFilterWhere(opts.dealFilters).sql,
  ].filter(Boolean).join(' AND ');

  // sums[bucket][depId]
  const sums = new Map<string, Record<string, number | null>>();
  const totalSums: Record<string, number | null> = {};

  for (const dep of deps) {
    const whereParts: string[] = [];
    if (pgFilter) whereParts.push(pgFilter.sql);
    if (managerIds.length > 0) whereParts.push(`d.current_manager_id::text = ANY($${managerParamIdx}::text[])`);
    if (offhWhere) whereParts.push(offhWhere);
    const dim = {
      idExpr: `to_char(date_trunc('${unit}', (d.${dep.dateField} AT TIME ZONE '${MSK}')), 'YYYY-MM-DD')`,
      groupBy: `GROUP BY 1, d.funnel_id`,
      notNullWhere: whereParts.length ? whereParts.join(' AND ') : undefined,
      funnelBreakdown: true as const,
    };
    const sql = buildCollectedSQL([dep], dim);
    if (!sql) continue;
    const params: unknown[] = [fromIso, toExclIso, ...(pgFilter?.params ?? [])];
    if (managerIds.length > 0) params.push(managerIds);
    const res = await analyticsDb().query<Record<string, unknown> & { dimension_id: string; funnel_id: number }>(sql, params);

    // Пилюли dealScope/clientType — фильтр по funnel_id (метрики с тегом
    // scope_independent игнорируют dealScope — как в byManagers.aggregate).
    const scopeForDep: DealScope = dep.tags.includes('scope_independent') ? 'all' : dealScope;
    const allowed = allowedFunnels(funnels, scopeForDep, clientType);
    for (const row of res.rows) {
      if (allowed !== null && !allowed.has(row.funnel_id)) continue;
      const v = row[dep.id];
      if (v === null || v === undefined) continue;
      const b = row.dimension_id;
      if (!sums.has(b)) sums.set(b, {});
      const entry = sums.get(b)!;
      entry[dep.id] = (entry[dep.id] ?? 0) + Number(v);
      totalSums[dep.id] = (totalSums[dep.id] ?? 0) + Number(v);
    }
  }

  // Непрерывная шкала бакетов периода (нули там, где данных нет).
  const startYmd = bucketStartYmd(opts.period.from, unit);
  // Правая граница — в МСК: toExclIso = МСК-полночь следующего дня, но её
  // UTC-дата на день раньше (21:00Z) — резать по UTC-дате теряло последний
  // день периода (пойман сверкой: сумма дневных бакетов < ячейки на день).
  const endExclYmd = bucketStartYmd(new Date(toExclIso), "day");
  const buckets: SeriesBucket[] = [];
  for (let b = startYmd; b < endExclYmd && buckets.length < 500; b = nextBucketYmd(b, unit)) {
    const entry = sums.get(b) ?? {};
    if (metric.metricType === 'calculated') {
      const filled: Record<string, number | null> = {};
      for (const dep of deps) filled[dep.id] = entry[dep.id] ?? 0;
      const calc = computeCalculated(filled, [metric]);
      buckets.push({ bucket: b, value: calc[metric.id] ?? null });
    } else {
      buckets.push({ bucket: b, value: entry[metric.id] ?? 0 });
    }
  }

  let total: number | null;
  if (metric.metricType === 'calculated') {
    const filled: Record<string, number | null> = {};
    for (const dep of deps) filled[dep.id] = totalSums[dep.id] ?? 0;
    total = computeCalculated(filled, [metric])[metric.id] ?? null;
  } else {
    total = totalSums[metric.id] ?? 0;
  }

  return { supported: true, buckets, total };
}
