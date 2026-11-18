import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { buildBigBoard } from '@/features/big-deals-kanban/engine/board';
import { filtersFromQuery, parseSort } from '@/features/big-deals-kanban/engine/filters';

// Канбан больших чеков (BIG_DEALS_KANBAN_SPEC.md). Право — пока section.repeat_kanban (решение 18.11),
// зона — как у канбана повторных: ropScope → scopeManagers (видимость — engine/visibility.ts).
// GET ?group=74,81&manager=123&product=Газобетон|Кровля&q=текст&smin=&smax=&cfrom=YYYY-MM-DD&cto=
//     &states=control,pending&cols=reserve,invoice&dmin=&idle=&stuck=1&nocalls=1&deal=won|lost|open
//     &sort=default|sum|days|created|idle&force=1
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  try {
    const board = await buildBigBoard(session, { ...filtersFromQuery(sp), sort: parseSort(sp.get('sort')), force: sp.get('force') === '1' });
    return NextResponse.json(board, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-deals-kanban] GET', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка сборки доски' }, { status: 500 });
  }
}
