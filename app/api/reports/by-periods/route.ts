import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import {
  fetchByPeriods,
  type PeriodsDimension, type PeriodBucketRow, type CompareMode,
} from '@/features/reports/engine/byPeriods';
import {
  bucketStartOf, nextBucket, prevBucket, yoyBucket, bucketLabel, comparisonBucketOf,
} from '@/features/reports/lib/periodBuckets';
import { seriesDeps } from '@/features/reports/engine/metricSeries';
import {
  fetchClientMetrics, clientMetricsToRecord, CLIENT_METRIC_IDS, CLIENTS_GRAND_TOTAL_KEY,
  fetchClientTimeMetrics, clientTimeMetricsToRecord, CLIENT_TIME_METRIC_IDS,
  fetchClientFollowupMetrics, clientFollowupToRecord, CLIENT_FOLLOWUP_METRIC_IDS,
  fetchClientCohortMetrics, clientCohortToRecord, CLIENT_COHORT_METRIC_IDS,
  fetchActiveClients, clientActiveToRecord, CLIENT_ACTIVE_METRIC_IDS,
  clientShareOf, CLIENT_SHARE_METRIC_IDS, CLIENT_BUYERS_METRIC_IDS,
} from '@/features/reports/engine/clientMetrics';
import { computeCalculated, computeTotals, computeDelta } from '@/features/reports/engine/calculated';
import { periodDateStrFromInstant, type CalendarUnit } from '@/lib/period';
import { validateDealFilters } from '@/lib/metrics/dealFilters';
import type { DealScope, ClientType, ProductGroupMode, AccountType, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';

// ── Отчёт «По периодам» (задача владельца 09.08) ─────────────────────────────
//
// Отдельный роут, а не ветка в /api/reports/run, по двум причинам:
//   1. вся тяжёлая часть run/route.ts (планы менеджеров, звонки, стадии-снимки,
//      медианы) к строкам-периодам неприменима — гонять её вхолостую незачем;
//   2. у этого отчёта ДРУГОЙ контракт сравнения. В «по менеджерам» сравнение —
//      это тот же набор строк за другой период. Здесь строки САМИ являются
//      периодами, поэтому глобальный «период сравнения» дублировал бы ось.
//      Сравнение построчное: каждый бакет против ПРЕДЫДУЩЕГО такого же бакета
//      (мес/мес) либо против такого же бакета год назад (LFL).
//
// «Итого» — полноценный: сумма по видимым бакетам (calculated пересчитан из сумм,
// а не усреднён по строкам), сравнение итога — агрегат ровно тех бакетов, с
// которыми сравнивались строки. Δ итога поэтому всегда равна разнице двух сумм,
// которые видит человек, а не отдельно посчитанному «периоду сравнения».

const UNITS: CalendarUnit[] = ['day', 'week', 'month', 'quarter', 'year'];
const DIMENSIONS: PeriodsDimension[] = ['managers', 'product-groups'];
const COMPARE_MODES: CompareMode[] = ['prev', 'yoy', 'none'];

// Потолок строк. Смысл — не «оптимизация», а защита от заведомо нечитаемой
// таблицы (5 лет по дням = ~1800 строк) и от 6 тяжёлых запросов ради неё.
// Превышение — честная 400 с подсказкой укрупнить шаг, а НЕ молчаливая обрезка:
// обрезанный отчёт выглядит как полный и врёт в «Итого».
const MAX_BUCKETS = 500;

function isValidPeriodInput(p: unknown): p is { from: string; to: string } {
  if (!p || typeof p !== 'object') return false;
  const from = (p as Record<string, unknown>).from;
  const to = (p as Record<string, unknown>).to;
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return !Number.isNaN(new Date(from).getTime()) && !Number.isNaN(new Date(to).getTime());
}

/** Окно сравнения — не «сдвинутые на месяц даты», а ЦЕЛЫЕ бакеты, в которые
 *  смотрят строки. Сдвигать сами даты нельзя: «30 июня минус месяц» = 30 мая, и
 *  31 мая молча выпало бы из знаменателя. */
function comparisonWindow(
  firstBucket: string, lastBucket: string, unit: CalendarUnit, mode: Exclude<CompareMode, 'none'>,
): { fromIso: string; toIso: string } {
  const shift = (b: string) => (mode === 'prev' ? prevBucket(b, unit) : yoyBucket(b, unit));
  const from = shift(firstBucket);
  const lastShifted = shift(lastBucket);
  // Правая граница — последний день последнего бакета сравнения (включительно).
  const endYmd = nextBucket(lastShifted, unit);
  const end = new Date(`${endYmd}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return {
    fromIso: `${from}T00:00:00.000Z`,
    toIso: `${end.toISOString().slice(0, 10)}T23:59:59.999Z`,
  };
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const {
    period,
    unit = 'month' as CalendarUnit,
    dimension = 'managers' as PeriodsDimension,
    compareMode = 'prev' as CompareMode,
    metricIds = ['all_core'],
    dealScope = 'all' as DealScope,
    clientType = 'all' as ClientType,
    departmentIds,
    accountType = 'all' as AccountType,
    productGroupMode = 'kc' as ProductGroupMode,
    productGroupIds,
    createdTimeFilter = 'all' as CreatedTimeFilter,
    firstTouchFilter = 'all' as FirstTouchFilter,
    dealFilters,
  } = body;

  if (!isValidPeriodInput(period)) {
    return NextResponse.json({ error: 'period.from и period.to обязательны и должны быть валидными датами' }, { status: 400 });
  }
  if (!UNITS.includes(unit)) {
    return NextResponse.json({ error: `unit должен быть одним из: ${UNITS.join(', ')}` }, { status: 400 });
  }
  if (!DIMENSIONS.includes(dimension)) {
    return NextResponse.json({ error: `dimension должен быть одним из: ${DIMENSIONS.join(', ')}` }, { status: 400 });
  }
  if (!COMPARE_MODES.includes(compareMode)) {
    return NextResponse.json({ error: `compareMode должен быть одним из: ${COMPARE_MODES.join(', ')}` }, { status: 400 });
  }
  if (productGroupIds !== undefined && (!Array.isArray(productGroupIds) || productGroupIds.length > 200
    || productGroupIds.some((v: unknown) => typeof v !== 'string' || v.length > 200))) {
    return NextResponse.json({ error: 'productGroupIds должен быть массивом строк (макс. 200 элементов)' }, { status: 400 });
  }
  const dealFiltersError = validateDealFilters(dealFilters);
  if (dealFiltersError) return NextResponse.json({ error: dealFiltersError }, { status: 400 });

  const start = Date.now();

  const periodRange = { from: new Date(period.from), to: new Date(period.to) };
  const firstBucket = bucketStartOf(periodDateStrFromInstant(periodRange.from, 'from'), unit);
  const lastBucket = bucketStartOf(periodDateStrFromInstant(periodRange.to, 'to'), unit);
  if (lastBucket < firstBucket) {
    return NextResponse.json({ error: 'Конец периода раньше начала' }, { status: 400 });
  }

  let bucketCount = 0;
  for (let b = firstBucket; b <= lastBucket; b = nextBucket(b, unit)) {
    if (++bucketCount > MAX_BUCKETS) {
      return NextResponse.json({
        error: `Слишком много периодов (> ${MAX_BUCKETS}) — укрупните шаг группировки или сузьте диапазон`,
      }, { status: 400 });
    }
  }

  const allMetrics = await loadMetrics();
  const requested = resolveMetricIds(metricIds, allMetrics);
  const withDeps = withDependencies(requested, allMetrics);
  const calculatedMetrics = withDeps.filter(m => m.metricType === 'calculated');

  // Граница поддержки — ровно та же, что у графика метрики: collected source='deals'
  // и calculated поверх таких. Остальное (планы, звонки, стадии, снимки «сейчас»)
  // в разрезе по времени не считается ни этим движком, ни каким-либо другим —
  // отдаём список явно, чтобы UI не показывал пустые колонки без объяснения.
  // При 'all_core' список не отдаём: человек не выбирал эти метрики поимённо,
  // колонок с ними в ответе нет — предупреждать не о чем, вышел бы шум на пол-экрана.
  const explicitMetrics = !metricIds.includes('all_core');
  // Метрики раздела «Клиенты» считает свой движок (clientMetrics.ts) — они
  // external, поэтому seriesDeps их не признаёт, но неподдержанными они НЕ
  // являются: правило владельца «метрика работает во всех трёх стартовых
  // сущностях» (10.08) — здесь это третья.
  const clientIds = new Set<string>([...CLIENT_METRIC_IDS, ...CLIENT_COHORT_METRIC_IDS, ...CLIENT_SHARE_METRIC_IDS, ...CLIENT_BUYERS_METRIC_IDS]);
  const unsupported = explicitMetrics
    ? requested.filter(m => seriesDeps(m, allMetrics) === null && !clientIds.has(m.id)).map(m => m.id)
    : [];
  const unsupportedSet = new Set(unsupported);

  const engineOpts = {
    unit, dimension: dimension as PeriodsDimension,
    dealScope, clientType, departmentIds, accountType,
    productGroupMode, productGroupIds,
    createdTimeFilter, firstTouchFilter, dealFilters,
  };

  const compWindow = compareMode === 'none'
    ? null
    : comparisonWindow(firstBucket, lastBucket, unit, compareMode);

  const [currentRaw, compRaw] = await Promise.all([
    fetchByPeriods({ ...engineOpts, period: periodRange }),
    compWindow
      ? fetchByPeriods({
          ...engineOpts,
          period: { from: new Date(compWindow.fromIso), to: new Date(compWindow.toIso) },
        })
      : Promise.resolve([] as PeriodBucketRow[]),
  ]);

  // Метрики раздела «Клиенты» — своим движком, с измерением «бакет периода».
  // Считаются по тем же двум окнам, что и всё остальное (текущее и сдвинутое),
  // поэтому построчное сравнение работает для них так же, как для обычных метрик.
  const needClients = withDeps.some(m => (CLIENT_METRIC_IDS as readonly string[]).includes(m.id));
  const needTime = withDeps.some(m => (CLIENT_TIME_METRIC_IDS as readonly string[]).includes(m.id));
  const clientCommon = {
    dimension: 'period' as const, periodUnit: unit, dealScope, clientType,
    departmentIds, createdTimeFilter, firstTouchFilter, dealFilters,
  };
  const compRange = compWindow
    ? { from: new Date(compWindow.fromIso), to: new Date(compWindow.toIso) }
    : periodRange;
  const needFollowup = withDeps.some(m => (CLIENT_FOLLOWUP_METRIC_IDS as readonly string[]).includes(m.id));
  const needCohort = withDeps.some(m => (CLIENT_COHORT_METRIC_IDS as readonly string[]).includes(m.id));
  const needActive = withDeps.some(m => (CLIENT_ACTIVE_METRIC_IDS as readonly string[]).includes(m.id));
  const [curClients, compClients, curTime, compTime, curFollow, compFollow, curCohort, compCohort, curActive, compActive] = await Promise.all([
    needClients ? fetchClientMetrics({ ...clientCommon, period: periodRange }) : Promise.resolve(null),
    needClients && compWindow ? fetchClientMetrics({ ...clientCommon, period: compRange }) : Promise.resolve(null),
    needTime ? fetchClientTimeMetrics({ ...clientCommon, period: periodRange }) : Promise.resolve(null),
    needTime && compWindow ? fetchClientTimeMetrics({ ...clientCommon, period: compRange }) : Promise.resolve(null),
    needFollowup ? fetchClientFollowupMetrics({ ...clientCommon, period: periodRange }) : Promise.resolve(null),
    needFollowup && compWindow ? fetchClientFollowupMetrics({ ...clientCommon, period: compRange }) : Promise.resolve(null),
    needCohort ? fetchClientCohortMetrics({ ...clientCommon, period: periodRange }) : Promise.resolve(null),
    needCohort && compWindow ? fetchClientCohortMetrics({ ...clientCommon, period: compRange }) : Promise.resolve(null),
    needActive ? fetchActiveClients({ ...clientCommon, period: periodRange }) : Promise.resolve(null),
    needActive && compWindow ? fetchActiveClients({ ...clientCommon, period: compRange }) : Promise.resolve(null),
  ]);
  const clientsFor = (
    bucket: string,
    base: Awaited<ReturnType<typeof fetchClientMetrics>> | null,
    time: Awaited<ReturnType<typeof fetchClientTimeMetrics>> | null,
    follow: Awaited<ReturnType<typeof fetchClientFollowupMetrics>> | null,
    cohort: Awaited<ReturnType<typeof fetchClientCohortMetrics>> | null,
    active: Awaited<ReturnType<typeof fetchActiveClients>> | null,
  ): Record<string, number | null> => ({
    ...(needClients ? clientMetricsToRecord(base?.get(bucket)) : {}),
    ...(needTime ? clientTimeMetricsToRecord(time?.get(bucket)) : {}),
    ...(needFollowup ? clientFollowupToRecord(follow?.get(bucket)) : {}),
    ...(needCohort ? clientCohortToRecord(cohort?.get(bucket)) : {}),
    ...(needActive ? clientActiveToRecord(active?.get(bucket)) : {}),
  });

  const enrich = (
    row: PeriodBucketRow,
    base: Awaited<ReturnType<typeof fetchClientMetrics>> | null,
    time: Awaited<ReturnType<typeof fetchClientTimeMetrics>> | null,
    follow: Awaited<ReturnType<typeof fetchClientFollowupMetrics>> | null,
    cohort: Awaited<ReturnType<typeof fetchClientCohortMetrics>> | null,
    active: Awaited<ReturnType<typeof fetchActiveClients>> | null,
  ): PeriodBucketRow => ({
    ...row,
    metrics: computeCalculated(
      { ...row.metrics, ...clientsFor(row.bucket, base, time, follow, cohort, active) },
      calculatedMetrics,
    ),
  });
  let currentRows = currentRaw.map(r => enrich(r, curClients, curTime, curFollow, curCohort, curActive));
  let compRows = compRaw.map(r => enrich(r, compClients, compTime, compFollow, compCohort, compActive));

  // «Клиенты» в «Итого» — из общего итога движка, не суммой бакетов (клиент,
  // купивший в мае и в июле, за полугодие один). Считается ДО сборки строк:
  // долям каждой строки нужен итог (та же логика, что в run/route.ts).
  let clientTotals = clientsFor(CLIENTS_GRAND_TOTAL_KEY, curClients, curTime, curFollow, curCohort, curActive);
  let clientTotalsComp = clientsFor(CLIENTS_GRAND_TOTAL_KEY, compClients, compTime, compFollow, compCohort, compActive);
  const needShares = withDeps.some(m => (CLIENT_SHARE_METRIC_IDS as readonly string[]).includes(m.id));
  const needBuyers = withDeps.some(m => (CLIENT_BUYERS_METRIC_IDS as readonly string[]).includes(m.id));
  if (needShares || needBuyers) {
    const patch = (r: PeriodBucketRow, totals: Record<string, number | null>): PeriodBucketRow => ({
      ...r,
      metrics: {
        ...r.metrics,
        ...(needShares ? clientShareOf(r.metrics, totals) : {}),
        // Строка здесь — бакет времени: «купившие клиенты» = клиенты бакета.
        ...(needBuyers ? { group_buyers_count: r.metrics.all_clients_delivered ?? null } : {}),
      },
    });
    currentRows = currentRows.map(r => patch(r, clientTotals));
    compRows = compRows.map(r => patch(r, clientTotalsComp));
    if (needShares) {
      clientTotals = { ...clientTotals, client_share_count_pct: 100, client_share_amount_pct: 100 };
      clientTotalsComp = { ...clientTotalsComp, client_share_count_pct: 100, client_share_amount_pct: 100 };
    }
    if (needBuyers) {
      clientTotals = { ...clientTotals, group_buyers_count: clientTotals.all_clients_delivered ?? null };
      clientTotalsComp = { ...clientTotalsComp, group_buyers_count: clientTotalsComp.all_clients_delivered ?? null };
    }
  }
  const compByBucket = new Map(compRows.map(r => [r.bucket, r]));

  const shiftOf = (b: string) => comparisonBucketOf(b, unit, compareMode);

  // Бакеты сравнения, реально использованные строками — из них же собирается
  // «Пред.» в «Итого» (иначе Δ итога считалась бы не от того, что видит человек).
  const usedComp: PeriodBucketRow[] = [];
  const rows = currentRows.map(row => {
    const shifted = shiftOf(row.bucket);
    const comp = shifted ? compByBucket.get(shifted) : undefined;
    if (comp) usedComp.push(comp);
    const deltas: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }> = {};
    for (const id of Object.keys(row.metrics)) {
      const current = row.metrics[id] ?? null;
      const comparison = comp?.metrics[id] ?? null;
      deltas[id] = { current, comparison, ...computeDelta(current, comparison) };
    }
    return {
      ...row,
      // Подпись базы сравнения строки — её показывает тултип/развёрнутая колонка
      // «Пред.»: «против Июль 2026» понятнее, чем безымянное число.
      comparisonLabel: shifted ? bucketLabel(shifted, unit) : null,
      deltas,
    };
  });

  const totalsCurrent = computeCalculated(
    { ...computeTotals(currentRows, allMetrics), ...clientTotals }, calculatedMetrics);
  const totalsComparison = computeCalculated(
    { ...computeTotals(usedComp, allMetrics), ...clientTotalsComp }, calculatedMetrics);
  const totals: Record<string, { current: number | null; comparison: number | null; delta: number | null; deltaPct: number | null }> = {};
  for (const id of new Set([...Object.keys(totalsCurrent), ...Object.keys(totalsComparison)])) {
    const current = totalsCurrent[id] ?? null;
    const comparison = compareMode === 'none' ? null : (totalsComparison[id] ?? null);
    totals[id] = { current, comparison, ...computeDelta(current, comparison) };
  }

  return NextResponse.json({
    rows,
    grouped: null, // группировок по отделам/филиалам у периодов нет
    totals,
    metrics: requested.filter(m => !m.isHiddenInUi && !unsupportedSet.has(m.id)),
    unsupported,
    meta: {
      period: { from: period.from, to: period.to },
      comparisonPeriod: compWindow
        ? { from: compWindow.fromIso, to: compWindow.toIso }
        : { from: period.from, to: period.to },
      unit,
      dimension,
      compareMode,
      bucketCount,
      cacheHit: false,
      durationMs: Date.now() - start,
    },
  });
}
