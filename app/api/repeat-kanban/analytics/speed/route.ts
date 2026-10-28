import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canSeeKanbanAnalytics } from '@/features/repeat-kanban/engine/analyticsAccess';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { fetchKanbanSpeed } from '@/features/repeat-kanban/engine/speed';
import { parsePeriod } from '@/features/repeat-kanban/engine/saLookups';

// «Аналитика канбана повторных» → вкладка «Пул и скорость»: ждут приёмки, зависло, приёмка и разбор
// отказов, очередь (engine/speed.ts). Доступ и зона — как у аналитики.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban') || !(await canSeeKanbanAnalytics(session))) return NextResponse.json({ error: 'Аналитика — РОПам и выше' }, { status: 403 });
  const raw = req.nextUrl.searchParams.get('date') ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const period = parsePeriod(req.nextUrl.searchParams.get('period'));
  try {
    const scope = await ropScope(session);
    const managerIds = scope.full ? null : (await scopeManagers(scope)).map(m => m.id);
    return NextResponse.json(await fetchKanbanSpeed({ date, period, managerIds }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban speed]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось посчитать скорость' }, { status: 500 });
  }
}
