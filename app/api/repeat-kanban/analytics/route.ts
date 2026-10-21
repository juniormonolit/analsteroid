import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canSeeRepeatKanbanAnalytics } from '@/lib/auth/modulesAccess';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { fetchKanbanAnalytics } from '@/features/repeat-kanban/engine/analytics';

// «Аналитика канбана повторных» v1: кто что делал за день, проработанность по отделам по
// ежедневным снимкам, журнал. Зона — как у доски: руководство видит всех, РОП — свою зону.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban') || !canSeeRepeatKanbanAnalytics(session)) return NextResponse.json({ error: 'Аналитика — директорам и выше' }, { status: 403 });
  const raw = req.nextUrl.searchParams.get('date') ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  try {
    const scope = await ropScope(session);
    const managerIds = scope.full ? null : (await scopeManagers(scope)).map(m => m.id);
    const p = req.nextUrl.searchParams.get('period');
    const period = p === 'week' || p === 'month' ? p : 'day';
    return NextResponse.json(await fetchKanbanAnalytics({ date, period, managerIds }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban analytics]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать аналитику' }, { status: 500 });
  }
}
