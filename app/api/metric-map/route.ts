import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { canSeeDept, canSeeManager, getSessionScope, scopeForbidden } from '@/lib/org/sessionScope';
import {
  defaultCompare, getMetricMap, parseScope, resolveDeptUuid, validPeriod,
} from '@/features/metric-map/engine/service';

// «Карта показателей» (задача владельца 23.11). Контракт ответа — features/metric-map/types.ts.
// GET /api/metric-map?scope=company|department:<id>|manager:<id>|product_group:<id>
//                    &from=YYYY-MM-DD&to=YYYY-MM-DD[&compareFrom=..&compareTo=..]
// Права: раздел — section.metric_map; данные — срезом сессии (lib/org/sessionScope):
// компания и товарные группы — только с полным доступом, отдел — свой/подконтрольный,
// менеджер — кого вправе видеть (МОП — только себя).
export async function GET(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.metric_map');
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const scope = parseScope(sp.get('scope'));
  if (!scope) return NextResponse.json({ error: 'Неверный scope' }, { status: 400 });
  const from = sp.get('from'), to = sp.get('to');
  if (!validPeriod(from, to)) return NextResponse.json({ error: 'from/to — даты YYYY-MM-DD, from ≤ to' }, { status: 400 });
  let compareFrom = sp.get('compareFrom'), compareTo = sp.get('compareTo');
  if (!compareFrom && !compareTo) [compareFrom, compareTo] = defaultCompare(from!, to!);
  if (!validPeriod(compareFrom, compareTo)) return NextResponse.json({ error: 'compareFrom/compareTo — даты YYYY-MM-DD' }, { status: 400 });

  const access = await getSessionScope(session!);
  if (access.kind !== 'all') {
    if (scope.type === 'company' || scope.type === 'product_group') return scopeForbidden();
    if (scope.type === 'manager' && !canSeeManager(access, scope.id)) return scopeForbidden();
    if (scope.type === 'department') {
      const uuid = await resolveDeptUuid(scope.id!);
      if (!uuid || !canSeeDept(access, uuid)) return scopeForbidden();
    }
  }

  try {
    const started = Date.now();
    const data = await getMetricMap({ scope, from: from!, to: to!, compareFrom: compareFrom!, compareTo: compareTo! });
    console.log(`[metric-map] ${sp.get('scope') ?? 'company'} ${from}..${to}: ${Date.now() - started} мс`);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[metric-map] ошибка расчёта:', msg);
    return NextResponse.json({ error: msg === 'Отдел не найден' ? msg : 'Не удалось посчитать карту' }, { status: msg === 'Отдел не найден' ? 404 : 500 });
  }
}
