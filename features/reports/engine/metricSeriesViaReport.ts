import { NextRequest } from 'next/server';
import { loadMetrics, withDependencies } from '@/lib/metrics/catalog';
import { computeTotals } from './calculated';
import { STAGE_SNAPSHOT_GROUPS, DEALS_IN_WORK_METRIC_IDS } from './stageSnapshot';
import { bucketStartYmd, nextBucketYmd, type MetricSeriesOptions, type MetricSeriesResult, type SeriesBucket, type SeriesGranularity } from './metricSeries';
import type { Metric, ReportRow } from '@/lib/metrics/types';

// ── Универсальный график: любая метрика каталога ─────────────────────────────
//
// До 15.09 график строился только для collected-метрик по сделкам и calculated
// поверх них — 147 метрик из 423 (аудит владельца: «а хули нельзя график по
// звонкам построить?»). Остальные считаются своими движками (звонки, стадии,
// клиенты, планы, дела, активность, рейтинг), у которых нет универсальной
// разбивки по времени.
//
// Решение: не переписывать десяток движков, а посчитать бакет ТЕМ ЖЕ кодом, что
// строит сам отчёт — POST /api/reports/run с периодом = бакет. Плюсы: точка
// графика по построению равна ячейке отчёта за тот же период (никаких
// параллельных формул), новые метрики получают график сразу, без правок здесь.
// Минус — N запросов на серию, поэтому: не больше MAX_BUCKETS точек, запросы
// пачками по CONCURRENCY, и в run уходит ТОЛЬКО нужная метрика (остальные
// движки в этом проходе не включаются).
//
// Значение точки берём так же, как его видит человек в отчёте:
//   строка одного менеджера/группы → значение ЕЁ ячейки;
//   несколько строк               → computeTotals по ним (как строка отдела);
//   без ограничения               → totals ответа (строка «Итого» отчёта).

const MAX_BUCKETS = 62;
const CONCURRENCY = 5;

/** Снимки «на сейчас» — истории для графика не существует (см. stageSnapshot.ts). */
const SNAPSHOT_IDS = new Set<string>([
  ...Object.values(STAGE_SNAPSHOT_GROUPS).map(g => g.metricId),
  ...DEALS_IN_WORK_METRIC_IDS,
  'manager_login',
]);

export function snapshotReason(metricId: string): string | null {
  if (!SNAPSHOT_IDS.has(metricId)) return null;
  return metricId === 'manager_login'
    ? 'Это не число, а подпись строки — графика у неё нет'
    : 'Это снимок на текущий момент: сколько сделок стоит в стадии прямо сейчас. Истории стадий по дням в отчёте нет, поэтому график был бы прямой линией из сегодняшнего значения';
}

function bucketsOf(period: { from: Date; to: Date }, unit: SeriesGranularity): string[] {
  const out: string[] = [];
  let cur = bucketStartYmd(period.from, unit);
  const end = bucketStartYmd(period.to, unit);
  for (let guard = 0; guard <= MAX_BUCKETS + 1 && cur <= end; guard++) {
    out.push(cur);
    cur = nextBucketYmd(cur, unit);
  }
  return out;
}

/** Границы бакета как ISO — точно те же «стенные часы» МСК, что у отчёта. */
function bucketRange(ymd: string, unit: SeriesGranularity): { from: string; to: string } {
  const next = nextBucketYmd(ymd, unit);
  const [ny, nm, nd] = next.split('-').map(Number);
  const lastDay = new Date(Date.UTC(ny, nm - 1, nd - 1)).toISOString().slice(0, 10);
  return { from: `${ymd}T00:00:00.000+03:00`, to: `${lastDay}T23:59:59.999+03:00` };
}

type RunRow = ReportRow & { deltas?: Record<string, { current: number | null }> };
interface RunResponse {
  rows: RunRow[];
  totals?: Record<string, { current: number | null }>;
}

async function runForPeriod(body: Record<string, unknown>): Promise<RunResponse> {
  // Импорт внутри функции: модуль роута тянет половину движков отчёта, а
  // универсальный график нужен не каждому запросу серии.
  const { POST } = await import('@/app/api/reports/run/route');
  const req = new NextRequest('http://internal/api/reports/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  if (!res.ok) {
    const err = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(err?.error ?? `run ${res.status}`);
  }
  return res.json() as Promise<RunResponse>;
}

function valueOf(resp: RunResponse, metric: Metric, forTotals: Metric[], opts: MetricSeriesOptions & { reportSlug?: string }): number | null {
  const wanted = opts.managerIds?.length
    ? new Set(opts.managerIds)
    : opts.productGroupId
      ? new Set([opts.productGroupId])
      : null;
  if (!wanted) return resp.totals?.[metric.id]?.current ?? null;

  const rows = (resp.rows ?? []).filter(r => wanted.has(r.dimensionId));
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].deltas?.[metric.id]?.current ?? rows[0].metrics?.[metric.id] ?? null;
  // Несколько строк — сворачиваем ровно так же, как отчёт сворачивает отдел:
  // суммы складываются, проценты пересчитываются формулой (computeTotals).
  const asMetrics = rows.map(r => ({
    metrics: Object.fromEntries(Object.entries(r.deltas ?? {}).map(([id, d]) => [id, d.current])) as Record<string, number | null>,
  }));
  return computeTotals(asMetrics, forTotals)[metric.id] ?? null;
}

export async function fetchMetricSeriesViaReport(
  opts: MetricSeriesOptions & { reportSlug?: string },
): Promise<MetricSeriesResult> {
  const all = await loadMetrics();
  const metric = all.find(m => m.id === opts.metricId);
  if (!metric) return { supported: false, reason: 'Метрика не найдена', buckets: [], cumulativeBuckets: [], total: null };

  const snapshot = snapshotReason(metric.id);
  if (snapshot) return { supported: false, reason: snapshot, buckets: [], cumulativeBuckets: [], total: null };

  const unit = opts.granularity;
  const buckets = bucketsOf(opts.period, unit);
  if (buckets.length > MAX_BUCKETS) {
    return {
      supported: false,
      reason: `Для этой метрики точка графика считается отдельным проходом отчёта, поэтому их не больше ${MAX_BUCKETS}. Укрупните шаг — неделя или месяц`,
      buckets: [], cumulativeBuckets: [], total: null,
    };
  }

  const forTotals = withDependencies([metric], all);
  const baseBody: Record<string, unknown> = {
    reportSlug: opts.reportSlug ?? 'by-managers',
    metricIds: [metric.id],
    dealScope: opts.dealScope ?? 'all',
    clientType: opts.clientType ?? 'all',
    departmentIds: opts.departmentIds,
    productGroupMode: opts.productGroupMode ?? 'kc',
    productGroupIds: opts.productGroupIds,
    createdTimeFilter: opts.createdTimeFilter ?? 'all',
    firstTouchFilter: opts.firstTouchFilter ?? 'all',
    dealFilters: opts.dealFilters,
    grouping: 'none',
  };

  const values: (number | null)[] = new Array(buckets.length).fill(null);
  let failed: string | null = null;
  for (let i = 0; i < buckets.length; i += CONCURRENCY) {
    const chunk = buckets.slice(i, i + CONCURRENCY);
    const res = await Promise.all(chunk.map(async (ymd, j) => {
      const range = bucketRange(ymd, unit);
      try {
        const resp = await runForPeriod({ ...baseBody, period: range, comparisonPeriod: range });
        return { idx: i + j, value: valueOf(resp, metric, forTotals, opts) };
      } catch (e) {
        failed ??= e instanceof Error ? e.message : String(e);
        return { idx: i + j, value: null };
      }
    }));
    for (const r of res) values[r.idx] = r.value;
  }
  if (failed && values.every(v => v === null)) {
    return { supported: false, reason: `Не удалось построить: ${failed}`, buckets: [], cumulativeBuckets: [], total: null };
  }

  const out: SeriesBucket[] = buckets.map((bucket, i) => ({ bucket, value: values[i] }));

  // «Итого» и накопление — одним проходом по всему периоду тем же способом:
  // для процентов и медиан складывать точки нельзя, поэтому итог считает отчёт.
  let total: number | null = null;
  try {
    const whole = await runForPeriod({
      ...baseBody,
      period: { from: opts.period.from.toISOString(), to: opts.period.to.toISOString() },
      comparisonPeriod: { from: opts.period.from.toISOString(), to: opts.period.to.toISOString() },
    });
    total = valueOf(whole, metric, forTotals, opts);
  } catch { /* итог не критичен — график уже есть */ }

  // Накопление: честно только для аддитивных метрик (суммы и счётчики). Для
  // процентов/медиан накопленная точка требовала бы пересчёта формулы по
  // накопленным зависимостям — их движки этого не отдают, поэтому повторяем
  // обычные точки (тумблер «С накоплением» не соврёт, а покажет то же).
  const additive = metric.metricType === 'collected'
    || (metric.metricType === 'external' && metric.aggregationFn === 'sum');
  let acc = 0;
  let seen = false;
  const cumulative: SeriesBucket[] = out.map(b => {
    if (!additive) return b;
    if (b.value !== null) { acc += b.value; seen = true; }
    return { bucket: b.bucket, value: seen ? acc : null };
  });

  return { supported: true, buckets: out, cumulativeBuckets: cumulative, total };
}
