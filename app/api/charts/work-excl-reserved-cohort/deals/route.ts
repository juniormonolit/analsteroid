import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { fetchWorkExclReservedMilestoneDealIds, type MilestoneDrilldownKind } from '@/features/charts/engine/workExclReservedCohort';
import { fetchDealsByIds } from '@/lib/reports/dealsByIds';
import type { DealScope, ClientType, ProductGroupMode } from '@/lib/metrics/types';

// Дрилл-даун списка сделок одного дня когорты «В работе (без брони/подтв.) →
// бронь/продажа/отгрузка по дням» (задача 2574, доработка 30.07 — три линии
// вместо одной). Тот же паттерн, что app/api/charts/work-days-cohort/deals/
// route.ts, но filter заменён на kind: 'all' (весь бакет «дожили») |
// 'reserved' | 'sold' | 'shipped' (точное попадание соответствующего события
// на день N). POST {
//   day, kind: 'all'|'reserved'|'sold'|'shipped',
//   period, dealScope?, clientType?, departmentIds?, productGroupMode?, productGroupIds?
// } → { deals, total_count, total_amount }

interface PeriodInput { from: string; to: string }

function parsePeriod(v: unknown): { from: Date; to: Date } | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as PeriodInput;
  if (typeof p.from !== 'string' || typeof p.to !== 'string') return null;
  const from = new Date(p.from);
  const to = new Date(p.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from, to };
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = permError(session, 'section.charts');
  if (err) return err;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const period = parsePeriod(body.period);
  if (!period) return NextResponse.json({ error: 'Invalid period' }, { status: 400 });

  const day = Number(body.day);
  if (!Number.isInteger(day) || day < 0 || day > 31) {
    return NextResponse.json({ error: 'day должен быть целым числом 0..31' }, { status: 400 });
  }
  const kind: MilestoneDrilldownKind = body.kind === 'reserved' || body.kind === 'sold' || body.kind === 'shipped'
    ? body.kind : 'all';

  const dealScope = (['primary', 'repeat', 'all'] as const).includes(body.dealScope as DealScope)
    ? body.dealScope as DealScope : 'all';
  const clientType = (['all', 'b2c', 'b2b'] as const).includes(body.clientType as ClientType)
    ? body.clientType as ClientType : 'all';
  const departmentIds = Array.isArray(body.departmentIds)
    ? (body.departmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;

  const productGroupMode: ProductGroupMode = body.productGroupMode === 'by_max' ? 'by_max' : 'kc';
  let productGroupIds: string[] | undefined;
  if (body.productGroupIds !== undefined) {
    if (!Array.isArray(body.productGroupIds) || body.productGroupIds.length > 200
      || (body.productGroupIds as unknown[]).some(v => typeof v !== 'string' || v.length > 200)) {
      return NextResponse.json({ error: 'productGroupIds должен быть массивом строк (макс. 200 элементов, каждая ≤200 символов)' }, { status: 400 });
    }
    productGroupIds = body.productGroupIds as string[];
  }

  const dealIds = await fetchWorkExclReservedMilestoneDealIds({
    period, dealScope, clientType, departmentIds, productGroupMode, productGroupIds, day, kind,
  });
  if (dealIds === null) return NextResponse.json({ deals: [], total_count: 0, total_amount: 0 });

  const result = await fetchDealsByIds(dealIds, productGroupMode);
  return NextResponse.json(result);
}
