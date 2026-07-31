import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { parseAmountRange } from '@/features/charts/engine/amountParam';
import { closeDeals, MAX_DEALS_PER_REQUEST } from '@/features/offload/engine/close';
import type { DealScope } from '@/lib/metrics/types';

// Закрытие сделок «Разгрузки отделов» (задача 2635, этап 2). ОДИН запрос = один
// batch.json Битрикса (до 25 команд) — клиент шлёт чанки ПОСЛЕДОВАТЕЛЬНО с
// паузой (требование владельца по нагрузке). POST { dealIds: number[],
// dealScope?, departmentIds?, amountFrom?, amountTo? } → { results }.
export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = permError(session, 'section.offload');
  if (err) return err;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!Array.isArray(body.dealIds) || body.dealIds.length === 0
    || body.dealIds.length > MAX_DEALS_PER_REQUEST
    || (body.dealIds as unknown[]).some(v => !Number.isInteger(Number(v)) || Number(v) <= 0)) {
    return NextResponse.json({ error: `dealIds — массив 1..${MAX_DEALS_PER_REQUEST} положительных id` }, { status: 400 });
  }
  const dealIds = (body.dealIds as unknown[]).map(Number);

  const dealScope = (['primary', 'repeat', 'all'] as const).includes(body.dealScope as DealScope)
    ? body.dealScope as DealScope : 'all';
  const departmentIds = Array.isArray(body.departmentIds)
    ? (body.departmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  const amt = parseAmountRange(body);
  if (!amt.ok) return NextResponse.json({ error: amt.error }, { status: 400 });

  const results = await closeDeals(session!, dealIds, {
    dealScope, departmentIds, amountFrom: amt.amountFrom, amountTo: amt.amountTo,
  });
  return NextResponse.json({ results });
}
