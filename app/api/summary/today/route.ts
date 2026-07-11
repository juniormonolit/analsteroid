import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveSummaryScope, parseBranchParam } from '@/lib/summary/scope';
import { applyPreset } from '@/lib/period';
import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { fetchCallsBaseMetrics, GRAND_TOTAL_KEY, type CallsBaseRow } from '@/features/reports/engine/callsMetrics';
import { cached, reportTtl } from '@/lib/cache/redis';

export interface SummaryTodayResponse {
  hasAccess: boolean;
  deals: number;
  salesAmount: number;
  calls: number;
  /** Доля сделок сегодняшнего дня от общего числа звонков сегодня (deals/calls*100) —
   *  ближайшая честная оценка «конверсии звонок→сделка» из готовых движков: точной
   *  атрибуции «эта сделка началась именно с этого звонка» в модели данных нет. */
  conversionPct: number | null;
  updatedAt: string;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const branch = parseBranchParam(req.nextUrl.searchParams.get('branch'));
  const scope = await resolveSummaryScope(session, branch);
  const updatedAt = new Date().toISOString();

  if (!scope.hasAccess) {
    const empty: SummaryTodayResponse = { hasAccess: false, deals: 0, salesAmount: 0, calls: 0, conversionPct: null, updatedAt };
    return NextResponse.json(empty);
  }

  const today = applyPreset('today');
  const toExcl = today.to.toISOString();

  // fetchByManagers уже кэширует НЕ-scoped строки в Redis/памяти (byManagers.ts::_rowCache,
  // key rpt:mgr:*) — второй Redis-слой здесь не нужен. callsMetrics.ts своего кэша не
  // имеет — оборачиваем сами (as:<BUILD_ID>:summary:today-calls:<day>). cached() зовёт
  // JSON.stringify — Map не переживает круглый рейс (стал бы "{}"), поэтому producer
  // явно приводит Map к plain object ДО сохранения.
  const dayKey = today.from.toISOString().slice(0, 10);
  const [rows, callsObj] = await Promise.all([
    fetchByManagers({ period: today, dealScope: 'all', clientType: 'all', accountType: 'managers' }),
    cached(`summary:today-calls:${dayKey}`, reportTtl(toExcl), async () => {
      const map = await fetchCallsBaseMetrics(today);
      return map ? (Object.fromEntries(map) as Record<string, CallsBaseRow>) : null;
    }),
  ]);

  let deals = 0;
  let salesAmount = 0;
  for (const row of rows) {
    if (!scope.managerIds.has(row.dimensionId)) continue;
    deals += row.metrics.deals_count ?? 0;
    salesAmount += (row.metrics.primary_sales_amount ?? 0) + (row.metrics.repeat_sales_amount ?? 0);
  }

  let calls = 0;
  if (callsObj) {
    for (const [id, row] of Object.entries(callsObj)) {
      if (id === GRAND_TOTAL_KEY || !scope.managerIds.has(id)) continue;
      calls += row.count.all;
    }
  }

  const conversionPct = calls > 0 ? Math.round((deals / calls) * 1000) / 10 : null;

  const body: SummaryTodayResponse = { hasAccess: true, deals, salesAmount, calls, conversionPct, updatedAt };
  return NextResponse.json(body);
}
