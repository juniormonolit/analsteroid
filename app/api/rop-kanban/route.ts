import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasRopKanbanPilot } from '@/lib/auth/perms';
import { ropScope } from '@/features/tv/engine/access';
import { buildKanbanBoard } from '@/features/rop-kanban/engine/kanban';

// Канбан РОПа, пилот (задача #9625). Только чтение. Гейт — личный доступ
// section.rop_kanban_pilot (джокер section.* и супер-админ его НЕ открывают, см.
// hasRopKanbanPilot); зона данных — ropScope() сессии, как у /api/rop/dashboard.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasRopKanbanPilot(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const raw = new URL(req.url).searchParams.get('manager');
  const manager = raw && /^\d{1,10}$/.test(raw) ? raw : null;
  try {
    const scope = await ropScope(session);
    const board = await buildKanbanBoard(scope, manager);
    return NextResponse.json(board, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[rop-kanban]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать канбан' }, { status: 500 });
  }
}
