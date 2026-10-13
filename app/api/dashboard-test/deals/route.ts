import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { getSessionScope, canSeeManager, scopeForbidden } from '@/lib/org/sessionScope';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { buildDashboardTest } from '@/features/dashboard-test/engine/build';
import { fetchManagerDeals } from '@/features/dashboard-test/engine/deals';

// Сделки менеджера за день дашборда: ?manager=<id>&type=sales|book. Гейт тот же, что у
// самого дашборда. Менеджер и день берутся из того же расчёта, что отдал страницу:
// менеджера нет в дашборде — пустой список, а не чужие данные.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.dashboard_test')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get('type');
  const managerId = searchParams.get('manager') ?? '';
  if (kind !== 'sales' && kind !== 'book') {
    return NextResponse.json({ error: 'type должен быть sales или book' }, { status: 400 });
  }
  const scope = await getSessionScope(session);
  // менеджер вне среза сессии — отказ, как у остальных роутов данных (сделки чужого менеджера)
  if (!canSeeManager(scope, managerId)) return scopeForbidden();
  try {
    const dash = await buildDashboardTest(scope);
    if (!dash.managers[managerId]) {
      return NextResponse.json({ day: dash.day, kind, managerId, deals: [], totalCount: 0, totalAmount: 0 }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(await fetchManagerDeals(kind, managerId, dash.day), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[dashboard-test/deals]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать список сделок' }, { status: 500 });
  }
}
