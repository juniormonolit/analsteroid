import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { analyticsPeriod, buildBigAnalytics } from '@/features/big-deals-kanban/engine/analytics';
import { filtersFromQuery } from '@/features/big-deals-kanban/engine/filters';

// Аналитика канбана больших чеков по менеджерам → BigAnalyticsResponse.
// GET ?<фильтры доски, как у GET /api/big-deals-kanban>&from=YYYY-MM-DD&to=YYYY-MM-DD&by=responsible|creator|assigner (дата создания задачи, МСК;
// по умолчанию последние 90 дней, не глубже 365). Видимость — та же зона, что у доски.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  try {
    const { createdFrom: _f, createdTo: _t, ...filters } = filtersFromQuery(sp);
    const data = await buildBigAnalytics(session, filters, analyticsPeriod(sp.get('from'), sp.get('to')), sp.get('by') === 'creator' ? 'creator' : sp.get('by') === 'assigner' ? 'assigner' : 'responsible');
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-deals-kanban analytics]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка аналитики' }, { status: 500 });
  }
}
