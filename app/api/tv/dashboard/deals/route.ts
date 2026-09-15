import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/auth/pin';
import { resolveDrilldown, fetchDrilldownDeals, type DrilldownKind } from '@/features/tv/engine/dashboardDrilldown';
import { rateLimited, tooMany } from '@/features/tv/engine/rateLimit';

// Раскрытие «Продажи»/«Брони» в список сделок для /today (задача #6465). Публичный,
// как /api/tv/dashboard (см. комментарий там — резать по сессии тут бессмысленно,
// ответ дашборда и так отдаётся анонимно всем): защита та же — лимит на IP + noindex.
// `node`/`manager` резолвятся на ТОМ ЖЕ TvDashboard, что отдаёт /api/tv/dashboard
// (buildDashboard() без scope) — список менеджеров узла гарантированно совпадает с
// тем, что даёт node.salesCount/bookCount в карточке (см. features/tv/engine/
// dashboardDrilldown.ts).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (rateLimited(`tv:dash-deals:${ip ?? 'na'}`, 60, 60)) return tooMany();

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get('type');
  if (kind !== 'sales' && kind !== 'book') {
    return NextResponse.json({ error: 'type должен быть sales или book' }, { status: 400 });
  }
  const nodeId = searchParams.get('node');
  const managerId = searchParams.get('manager');

  try {
    const selection = await resolveDrilldown(nodeId, managerId, undefined);
    if (!selection) return NextResponse.json({ deals: [], total_count: 0, total_amount: 0 });
    const body = await fetchDrilldownDeals(kind as DrilldownKind, selection);
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' },
    });
  } catch (e) {
    console.error('[tv/dashboard/deals]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать список сделок' }, { status: 500 });
  }
}
