import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasRopKanbanPilot } from '@/lib/auth/perms';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { getRestrictions, sanitizeDisabledCycles, setRestriction } from '@/features/rop-kanban/engine/cycles';
import { CYCLES } from '@/features/rop-kanban/engine/config';

// Галочки «менеджер × цикл» (аналог getManagerCycleSettings/saveManagerCycleSettings Битрикса).
// Только менеджеры зоны ropScope() сессии; пишется ТОЛЬКО system.rop_manager_cycles.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasRopKanbanPilot(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const scope = await ropScope(session);
    const managers = await scopeManagers(scope);
    const restrictions = await getRestrictions(managers.map(m => m.id));
    return NextResponse.json({ managers, cycles: CYCLES, restrictions }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[rop-kanban/cycles GET]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить настройки' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasRopKanbanPilot(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  let body: { managerId?: unknown; disabledCycles?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }
  const managerId = typeof body.managerId === 'string' || typeof body.managerId === 'number' ? String(body.managerId) : '';
  if (!/^\d{1,10}$/.test(managerId)) return NextResponse.json({ error: 'managerId обязателен' }, { status: 400 });
  try {
    const scope = await ropScope(session);
    const managers = await scopeManagers(scope);
    // Менеджер вне зоны ответственности — менять нельзя (как и читать).
    if (!managers.some(m => m.id === managerId)) return NextResponse.json({ error: 'Менеджер вне вашей зоны' }, { status: 403 });
    const disabled = sanitizeDisabledCycles(body.disabledCycles);
    await setRestriction(managerId, disabled, session.login);
    return NextResponse.json({ ok: true, managerId, disabledCycles: disabled });
  } catch (e) {
    console.error('[rop-kanban/cycles POST]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось сохранить' }, { status: 500 });
  }
}
