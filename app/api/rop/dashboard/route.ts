import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { ropScope } from '@/features/tv/engine/access';
import { buildDashboard } from '@/features/tv/engine/dashboard';

// Дашборд «РОП — сегодня» для страницы /rop (задача #6446) — авторизованная
// персональная копия публичного /api/tv/dashboard. В отличие от него ответ НЕ
// одинаков для всех: состав режется по зоне ответственности сессии (ropScope —
// РОП/Директор видят свой отдел/филиал, рядовой менеджер — только себя), так что
// кэшировать и раздавать анонимно, как /today, здесь нельзя (см. комментарий в
// app/api/tv/dashboard/route.ts, почему ТОТ эндпоинт режется по IP, а не по сессии).
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.rop_today')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const scope = await ropScope(session);
    const dash = await buildDashboard(undefined, scope);
    return NextResponse.json(dash, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[rop/dashboard]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать дашборд' }, { status: 500 });
  }
}
