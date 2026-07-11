import { NextRequest, NextResponse } from 'next/server';
import { subDays } from 'date-fns';
import { getSession } from '@/lib/auth/session';
import { resolveSummaryScope, parseBranchParam } from '@/lib/summary/scope';
import { applyPreset, periodDateStrFromInstant } from '@/lib/period';
import { fetchDailySalesByManager, aggregateDailySales, type DailySalesPoint } from '@/features/reports/engine/dailySales';
import { cached, reportTtl } from '@/lib/cache/redis';

export interface SummaryDailySalesResponse {
  hasAccess: boolean;
  days: DailySalesPoint[];
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const branch = parseBranchParam(req.nextUrl.searchParams.get('branch'));
  const scope = await resolveSummaryScope(session, branch);

  const today = applyPreset('today');
  // 30 календарных дней, включая сегодня (today-29..today) — живой график, не
  // капается по вчера (в отличие от «Топ-5»/воронки): "Сегодня"-плитка рядом уже
  // показывает частичные данные текущего дня тем же принципом.
  const period = { from: subDays(today.from, 29), to: today.to };
  const fromDayStr = periodDateStrFromInstant(period.from, 'from');
  const toDayStr = periodDateStrFromInstant(period.to, 'to');

  if (!scope.hasAccess) {
    const empty: SummaryDailySalesResponse = { hasAccess: false, days: [] };
    return NextResponse.json(empty);
  }

  const dayKey = `${fromDayStr}:${toDayStr}`;
  const rows = await cached(`summary:daily-sales:${dayKey}`, reportTtl(period.to.toISOString()), () => fetchDailySalesByManager(period));

  const days = aggregateDailySales(rows, scope.managerIds, fromDayStr, toDayStr);

  const body: SummaryDailySalesResponse = { hasAccess: true, days };
  return NextResponse.json(body);
}
