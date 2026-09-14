import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { ropScope } from '@/features/tv/engine/access';
import { resolveDrilldown, fetchDrilldownDeals, type DrilldownKind } from '@/features/tv/engine/dashboardDrilldown';

// Раскрытие «Продажи»/«Брони» в список сделок для /rop (задача #6465) — авторизованный
// аналог /api/tv/dashboard/deals. Тот же гейт, что у /api/rop/dashboard: сессия +
// section.rop_today. `node`/`manager` резолвятся на TvDashboard, построенном С
// ropScope() сессии — узел/менеджер вне зоны ответственности отсутствует в дереве/
// словаре менеджеров (см. features/tv/engine/dashboardDrilldown.ts), поэтому прямой
// вызов с чужим id не может отдать чужие сделки — только пустой список.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.rop_today')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get('type');
  if (kind !== 'sales' && kind !== 'book') {
    return NextResponse.json({ error: 'type должен быть sales или book' }, { status: 400 });
  }
  const nodeId = searchParams.get('node');
  const managerId = searchParams.get('manager');

  try {
    const scope = await ropScope(session);
    const selection = await resolveDrilldown(nodeId, managerId, scope);
    if (!selection) return NextResponse.json({ deals: [], total_count: 0, total_amount: 0 });
    const body = await fetchDrilldownDeals(kind as DrilldownKind, selection);
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[rop/dashboard/deals]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать список сделок' }, { status: 500 });
  }
}
