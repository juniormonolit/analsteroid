import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getSessionScope, scopeManagerIds } from '@/lib/org/sessionScope';
import { canViewTaskDiscipline } from '@/features/big-brother/engine/rop/access';
import { parsePeriod } from '@/features/big-brother/engine/rop/period';
import { buildDiscipline, STALE_DAYS_DEFAULT } from '@/features/big-brother/engine/tasks/build';

// «Большой брат» → дисциплина задач. GET ?from&to (МСК, по умолчанию 30 дней)&scope=all|services&stale=N (дней, 1–90)
// → DisciplineResponse. Доступ — «директор и выше»; Директор видит свой срез (lib/org/sessionScope.ts), админ — всех.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewTaskDiscipline(session)) return NextResponse.json({ error: 'Раздел — для уровня «директор и выше»' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const staleRaw = Number(sp.get('stale'));
  const staleDays = Number.isInteger(staleRaw) && staleRaw >= 1 && staleRaw <= 90 ? staleRaw : STALE_DAYS_DEFAULT;
  try {
    const scope = await getSessionScope(session);
    const data = await buildDiscipline({
      period: parsePeriod(sp.get('from'), sp.get('to')),
      managerIds: scopeManagerIds(scope),
      scope: sp.get('scope') === 'services' ? 'services' : 'all',
      staleDays,
    });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother tasks]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
