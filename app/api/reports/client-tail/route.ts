import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { resolveMatrixRequest } from '@/features/reports/engine/productMatrixRequest';
import { fetchClientTail } from '@/features/reports/engine/clientTail';
import { validateDealFilters, type DealFilter } from '@/lib/metrics/dealFilters';
import type { CreatedTimeFilter, FirstTouchFilter, ProductGroupMode } from '@/lib/metrics/types';

// «Вход и хвост» (задача владельца 19.10). Период, отделы, менеджер, перв./повт.,
// ЧЛ/ЮЛ и срез сессии разбирает общий resolveMatrixRequest (те же правила прав,
// что у матриц); остальные фильтры отчёта — здесь.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.client_tail')) {
    return NextResponse.json({ error: 'Нет доступа к разделу «Вход и хвост»' }, { status: 403 });
  }

  const body = await req.json();
  const parsed = await resolveMatrixRequest(session, body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });

  const dfError = validateDealFilters(body.dealFilters);
  if (dfError) return NextResponse.json({ error: dfError }, { status: 400 });

  const productGroupMode: ProductGroupMode = body.productGroupMode === 'kc' ? 'kc' : 'by_max';
  const productGroupIds = Array.isArray(body.productGroupIds)
    ? (body.productGroupIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length <= 200).slice(0, 200)
    : [];
  const createdTimeFilter = (['all', 'business_hours', 'weekday_after_hours', 'weekend'] as const)
    .find(v => v === body.createdTimeFilter) ?? 'all' as CreatedTimeFilter;
  const firstTouchFilter = (['all', 'off_hours', 'business_hours'] as const)
    .find(v => v === body.firstTouchFilter) ?? 'all' as FirstTouchFilter;
  const windowMonths = typeof body.windowMonths === 'number' && body.windowMonths > 0 ? body.windowMonths : null;

  const { period, managerIds, departmentIds, dealScope, clientType } = parsed.opts;
  const start = Date.now();
  const result = await fetchClientTail({
    period, managerIds, departmentIds, dealScope, clientType,
    productGroupMode, productGroupIds, createdTimeFilter, firstTouchFilter,
    dealFilters: (body.dealFilters ?? []) as DealFilter[],
    windowMonths,
  });
  console.log(`[client-tail] вход ${result.entry.deals} сделок, хвост ${result.tail.deals} за ${Date.now() - start} мс`);
  return NextResponse.json(result);
}
