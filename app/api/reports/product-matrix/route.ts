import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getSessionScope, scopeDeptIdsBitrix, canSeeManager } from '@/lib/org/sessionScope';
import { fetchProductMatrix } from '@/features/reports/engine/productMatrix';

// «Товарная матрица» (задача владельца 10.08): вероятности перехода
// категория → категория. Вся математика — в движке; фильтр категорий — на
// клиенте (см. шапку productMatrix.ts: вероятности от всех переходов, чтобы
// скрытие колонок не меняло числа в оставшихся).

function isValidPeriodInput(p: unknown): p is { from: string; to: string } {
  if (!p || typeof p !== 'object') return false;
  const from = (p as Record<string, unknown>).from;
  const to = (p as Record<string, unknown>).to;
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return !Number.isNaN(new Date(from).getTime()) && !Number.isNaN(new Date(to).getTime());
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json();
  if (!isValidPeriodInput(body.period)) {
    return NextResponse.json({ error: 'period.from и period.to обязательны и должны быть валидными датами' }, { status: 400 });
  }
  // Фильтры среза (задача 10.09, «Матрица переходов»): менеджеры/отделы/пилюли —
  // по закрывающей сделке. Срез сессии (аудит 09.09): админ — всё; РОП/Директор —
  // пересечение со своими отделами (пустой запрос = весь свой срез); МОП — только он.
  const scope = await getSessionScope(session);
  let managerIds = Array.isArray(body.managerIds)
    ? (body.managerIds as unknown[]).filter((v): v is string => typeof v === 'string' && /^\d+$/.test(v)).slice(0, 500)
    : [];
  let departmentIds = Array.isArray(body.departmentIds)
    ? (body.departmentIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length <= 64).slice(0, 200)
    : [];
  if (scope.kind !== 'all') {
    if (managerIds.length) {
      const eff = managerIds.filter(id => canSeeManager(scope, id));
      if (eff.length === 0) return NextResponse.json({ error: 'Эти менеджеры вам недоступны' }, { status: 403 });
      managerIds = eff;
    } else if (scope.kind === 'self') {
      managerIds = [...scope.managerIds];
      if (managerIds.length === 0) return NextResponse.json({ error: 'Аккаунт не привязан к менеджеру Битрикса' }, { status: 403 });
    }
    if (scope.kind === 'depts') {
      const effD = await scopeDeptIdsBitrix(scope, departmentIds.length ? departmentIds : undefined);
      if (effD !== null && effD.length === 0) return NextResponse.json({ error: 'Запрошенные отделы вне вашего доступа' }, { status: 403 });
      departmentIds = effD ?? [];
    }
  }
  const dealScope = ['primary', 'repeat', 'all'].includes(body.dealScope) ? body.dealScope : 'all';
  const clientType = ['b2c', 'b2b', 'all'].includes(body.clientType) ? body.clientType : 'all';

  const start = Date.now();
  const result = await fetchProductMatrix({
    period: { from: new Date(body.period.from), to: new Date(body.period.to) },
    managerIds, departmentIds, dealScope, clientType,
  });
  return NextResponse.json({ ...result, meta: { durationMs: Date.now() - start } });
}
