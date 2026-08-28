import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchMetricSeries, type SeriesGranularity } from '@/features/reports/engine/metricSeries';
import { fetchBookingCallRateSeries, BOOKING_SERIES_METRICS } from '@/features/reports/engine/bookingCallRate';
import { fetchStageConversionSeries, stagePairForMetric } from '@/features/reports/engine/stageConversions';
import { validateDealFilters, type DealFilter } from '@/lib/metrics/dealFilters';
import type { DealScope, ClientType, CreatedTimeFilter, FirstTouchFilter, ProductGroupMode } from '@/lib/metrics/types';

// График метрики из отчёта (фича Серёги 01.08): серия значений одной метрики
// по бакетам времени внутри периода, с фильтрами отчёта. Доступ — как у
// /api/reports/run: любая живая сессия (раздел отчётов).

const GRANS: SeriesGranularity[] = ['day', 'week', 'month'];

function validPeriod(p: unknown): p is { from: string; to: string } {
  if (!p || typeof p !== 'object') return false;
  const { from, to } = p as Record<string, unknown>;
  return typeof from === 'string' && typeof to === 'string'
    && !Number.isNaN(new Date(from).getTime()) && !Number.isNaN(new Date(to).getTime());
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.metricId !== 'string' || !validPeriod(body.period)) {
    return NextResponse.json({ error: 'metricId и period обязательны' }, { status: 400 });
  }
  const granularity: SeriesGranularity = GRANS.includes(body.granularity) ? body.granularity : 'day';
  const managerIds = Array.isArray(body.managerIds)
    ? (body.managerIds as unknown[]).filter((v): v is string => typeof v === 'string' && /^\d+$/.test(v)).slice(0, 1000)
    : undefined;
  // Фильтр отчёта по отделам — без него график в разрезах без явного списка
  // менеджеров (товарные группы) игнорировал выбранные отделы (баг 27.08).
  const departmentIds = Array.isArray(body.departmentIds)
    ? (body.departmentIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length <= 64).slice(0, 200)
    : undefined;
  if (body.productGroupIds !== undefined && (!Array.isArray(body.productGroupIds) || body.productGroupIds.length > 200
    || (body.productGroupIds as unknown[]).some(v => typeof v !== 'string' || (v as string).length > 200))) {
    return NextResponse.json({ error: 'productGroupIds: массив строк ≤200' }, { status: 400 });
  }

  const common = {
    metricId: body.metricId as string,
    granularity,
    dealScope: (body.dealScope ?? 'all') as DealScope,
    clientType: (body.clientType ?? 'all') as ClientType,
    managerIds,
    departmentIds,
    productGroupMode: (body.productGroupMode ?? 'kc') as ProductGroupMode,
    productGroupId: typeof body.productGroupId === 'string' ? body.productGroupId : undefined,
    productGroupIds: body.productGroupIds as string[] | undefined,
    createdTimeFilter: (body.createdTimeFilter ?? 'all') as CreatedTimeFilter,
    firstTouchFilter: (body.firstTouchFilter ?? 'all') as FirstTouchFilter,
    // «Фильтр сделок» отчёта — график ОБЯЗАН считаться по тому же срезу, что
    // ячейка (контракт metricSeries: сумма бакетов сходится с ячейкой).
    dealFilters: body.dealFilters as DealFilter[] | undefined,
  };
  const dfError = validateDealFilters(body.dealFilters);
  if (dfError) return NextResponse.json({ error: dfError }, { status: 400 });

  // «Доля прозвона броней / подтв. броней» — свой движок (bookingCallRate, вне
  // сделочного SQL), но тенденцию по времени он строить умеет: перебирает сделки
  // поштучно, бакет = дата вехи (правка владельца 24.08 — «хочу смотреть
  // тенденцию в виде графика»). Замечание: фильтры отчёта, кроме списка
  // менеджеров, на эту метрику не действуют и в ячейке — расхождения с ячейкой
  // здесь нет.
  // «CR стадий» (cr_stage_*) — свой движок по deal_events (правка владельца
  // 27.08: крупнейшее семейство «относительных» метрик без графика).
  const fetchSeries = BOOKING_SERIES_METRICS[common.metricId]
    ? (o: { period: { from: Date; to: Date } }) => fetchBookingCallRateSeries({
        metricId: common.metricId, granularity, managerIds, period: o.period,
      })
    : stagePairForMetric(common.metricId)
      ? (o: { period: { from: Date; to: Date } }) => fetchStageConversionSeries({
          metricId: common.metricId, granularity, managerIds, departmentIds, period: o.period,
        })
      : (o: { period: { from: Date; to: Date } }) => fetchMetricSeries({ ...common, period: o.period });

  const current = await fetchSeries({
    period: { from: new Date(body.period.from), to: new Date(body.period.to) },
  });
  // Доп. линии (правка владельца 25.08: «показывал и период сравнения и
  // предыдущий, прям на одном графике») — параллельно: серии независимы.
  let comparison = null;
  let previous = null;
  if (current.supported) {
    [comparison, previous] = await Promise.all([
      validPeriod(body.comparisonPeriod)
        ? fetchSeries({ period: { from: new Date(body.comparisonPeriod.from), to: new Date(body.comparisonPeriod.to) } })
        : Promise.resolve(null),
      validPeriod(body.previousPeriod)
        ? fetchSeries({ period: { from: new Date(body.previousPeriod.from), to: new Date(body.previousPeriod.to) } })
        : Promise.resolve(null),
    ]);
  }

  return NextResponse.json({ granularity, current, comparison, previous });
}
