import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewRopRating } from '@/features/big-brother/engine/rop/access';
import { buildRopLag } from '@/features/big-brother/engine/rop/lag';

// «Большой брат» → «РОПы»: задачи РОПа за неделю N × продажи отдела в N+lag (корреляция, не рейтинг).
// GET ?lag=2|3|4 (по умолчанию 2) → RopLagResponse. Только админы. Последние 18 завершённых недель, кэш 1 ч.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewRopRating(session)) return NextResponse.json({ error: 'Рейтинг РОПов — только администраторам' }, { status: 403 });
  const lag = Number(req.nextUrl.searchParams.get('lag'));
  try {
    const data = await buildRopLag([2, 3, 4].includes(lag) ? lag : 2);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother rop lag]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
