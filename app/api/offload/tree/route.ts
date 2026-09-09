import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { getSessionScope, scopeForbidden } from '@/lib/org/sessionScope';
import { scopeDeptIdsBitrixExact } from '@/lib/org/scopeCoverage';
import { parseAmountRange } from '@/features/charts/engine/amountParam';
import { buildOffloadTree } from '@/features/offload/engine/offload';
import type { DealScope } from '@/lib/metrics/types';

// Дерево «Разгрузки отделов» (задача 2635, этап 1): отдел → менеджер с метриками
// загрузки. POST { dealScope?, departmentIds?, amountFrom?, amountTo? }.
// Право — section.offload (по умолчанию только супер-админ, см. lib/auth/perms.ts).
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

  const dealScope = (['primary', 'repeat', 'all'] as const).includes(body.dealScope as DealScope)
    ? body.dealScope as DealScope : 'all';
  const requestedDepartmentIds = Array.isArray(body.departmentIds)
    ? (body.departmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  // Аудит 09.09: departmentIds из тела уходили в движок как есть (пусто = вся компания).
  // Теперь — пересечение со срезом сессии (lib/org/sessionScope.ts); движок матчит
  // отдел точно (fetchOpenDeals), поэтому берём все отделы среза. Без отделов — 403.
  const scope = await getSessionScope(session!);
  const departmentIds = (await scopeDeptIdsBitrixExact(scope, requestedDepartmentIds)) ?? undefined;
  if (departmentIds && departmentIds.length === 0) return scopeForbidden('Разгрузка доступна только по подконтрольным отделам');
  const amt = parseAmountRange(body);
  if (!amt.ok) return NextResponse.json({ error: amt.error }, { status: 400 });

  const result = await buildOffloadTree({ dealScope, departmentIds, amountFrom: amt.amountFrom, amountTo: amt.amountTo });
  return NextResponse.json({ result });
}
