import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { getSessionScope, canSeeManager, scopeForbidden } from '@/lib/org/sessionScope';
import { scopeDeptIdsBitrixExact } from '@/lib/org/scopeCoverage';
import { analyticsDb } from '@/lib/db/clients';
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
  const requestedDepartmentIds = Array.isArray(body.departmentIds)
    ? (body.departmentIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  // Аудит 09.09: закрыть можно только сделки менеджеров своего среза
  // (lib/org/sessionScope.ts) — иначе любой носитель section.offload закрывал бы
  // сделки всей компании по перебору id. Владельцы сделок — из sa.deals; хотя бы
  // одна чужая (или отсутствующая в sa) → 403 на весь запрос. departmentIds — тоже
  // пересечение со срезом.
  const scope = await getSessionScope(session!);
  if (scope.kind !== 'all') {
    const owners = await analyticsDb().query<{ deal_id: string; manager_id: string | null }>(
      'SELECT deal_id::text AS deal_id, current_manager_id::text AS manager_id FROM deals WHERE deal_id = ANY($1::bigint[])',
      [dealIds],
    );
    const ownerById = new Map(owners.rows.map(r => [Number(r.deal_id), r.manager_id]));
    if (dealIds.some(id => !ownerById.has(id) || !canSeeManager(scope, ownerById.get(id)))) {
      return scopeForbidden('Среди выбранных есть сделки менеджеров вне ваших отделов');
    }
  }
  const departmentIds = (await scopeDeptIdsBitrixExact(scope, requestedDepartmentIds)) ?? undefined;
  if (departmentIds && departmentIds.length === 0) return scopeForbidden('Разгрузка доступна только по подконтрольным отделам');
  const amt = parseAmountRange(body);
  if (!amt.ok) return NextResponse.json({ error: amt.error }, { status: 400 });

  const results = await closeDeals(session!, dealIds, {
    dealScope, departmentIds, amountFrom: amt.amountFrom, amountTo: amt.amountTo,
  });
  return NextResponse.json({ results });
}
