import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewRopRating } from '@/features/big-brother/engine/rop/access';
import { parsePeriod } from '@/features/big-brother/engine/rop/period';
import { buildRopMonth } from '@/features/big-brother/engine/rop/month';

// «Большой брат» → «РОПы» → «Месяц по РОПам». GET ?from&to (МСК, по умолчанию 30 дней) → RopMonthResponse:
// действия РОПа против результата команды и изменение к прошлому такому же периоду. Только админы (как рейтинг).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewRopRating(session)) return NextResponse.json({ error: 'Вкладка «РОПы» — только администраторам' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  try {
    const data = await buildRopMonth(parsePeriod(sp.get('from'), sp.get('to')));
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother rop/month]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
