import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { buildBigBoard } from '@/features/big-deals-kanban/engine/board';

// Канбан больших чеков (BIG_DEALS_KANBAN_SPEC.md). Право — пока section.repeat_kanban (решение 18.11),
// зона — как у канбана повторных: ropScope → scopeManagers.
// GET ?group=74,81&manager=123&product=Газобетон|Кровля&q=текст&force=1 (товарные группы — через «|»)
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const sp = new URL(req.url).searchParams;
  const groups = (sp.get('group') ?? '').split(',').filter(x => /^\d{1,6}$/.test(x)).map(Number);
  const manager = /^\d{1,10}$/.test(sp.get('manager') ?? '') ? sp.get('manager') : null;
  const products = (sp.get('product') ?? '').split('|').map(x => x.trim().slice(0, 200)).filter(Boolean).slice(0, 50);
  const q = (sp.get('q') ?? '').trim().slice(0, 200) || null;
  try {
    const board = await buildBigBoard(session, { groups, manager, products, q, force: sp.get('force') === '1' });
    return NextResponse.json(board, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-deals-kanban] GET', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка сборки доски' }, { status: 500 });
  }
}
