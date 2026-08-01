import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { fetchMetricSeries, type SeriesGranularity } from '@/features/reports/engine/metricSeries';
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
    productGroupMode: (body.productGroupMode ?? 'kc') as ProductGroupMode,
    productGroupId: typeof body.productGroupId === 'string' ? body.productGroupId : undefined,
    productGroupIds: body.productGroupIds as string[] | undefined,
    createdTimeFilter: (body.createdTimeFilter ?? 'all') as CreatedTimeFilter,
    firstTouchFilter: (body.firstTouchFilter ?? 'all') as FirstTouchFilter,
  };

  const current = await fetchMetricSeries({
    ...common,
    period: { from: new Date(body.period.from), to: new Date(body.period.to) },
  });
  let comparison = null;
  if (current.supported && validPeriod(body.comparisonPeriod)) {
    comparison = await fetchMetricSeries({
      ...common,
      period: { from: new Date(body.comparisonPeriod.from), to: new Date(body.comparisonPeriod.to) },
    });
  }

  return NextResponse.json({ granularity, current, comparison });
}
