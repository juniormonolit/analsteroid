import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { parseAmountRange } from '@/features/charts/engine/amountParam';
import { getManagerDeals, type StageMode } from '@/features/offload/engine/offload';
import type { DealScope } from '@/lib/metrics/types';

// Сделки одного менеджера для «Разгрузки отделов» (ленивая подгрузка при
// раскрытии). POST { managerId, stageMode?, dealScope?, departmentIds?,
// amountFrom?, amountTo? } → { deals } (отсортированы «самые мёртвые сверху»).
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

  const managerId = String(body.managerId ?? '');
  if (!/^\d+$/.test(managerId)) {
    return NextResponse.json({ error: 'managerId (числовой bitrix id) обязателен' }, { status: 400 });
  }
  const stageMode: StageMode = body.stageMode === 'work' || body.stageMode === 'new' ? body.stageMode : 'both';
  const dealScope = (['primary', 'repeat', 'all'] as const).includes(body.dealScope as DealScope)
    ? body.dealScope as DealScope : 'all';
  const departmentIds = Array.isArray(body.departmentIds)
    ? (body.departmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  const amt = parseAmountRange(body);
  if (!amt.ok) return NextResponse.json({ error: amt.error }, { status: 400 });

  const deals = await getManagerDeals(
    { dealScope, departmentIds, amountFrom: amt.amountFrom, amountTo: amt.amountTo },
    managerId, stageMode,
  );
  return NextResponse.json({ deals });
}
