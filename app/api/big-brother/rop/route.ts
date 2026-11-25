import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewRopRating } from '@/features/big-brother/engine/rop/access';
import { parsePeriod } from '@/features/big-brother/engine/rop/period';
import { buildRopRating } from '@/features/big-brother/engine/rop/build';

// «Большой брат» → рейтинг РОПов. GET ?from=YYYY-MM-DD&to=YYYY-MM-DD (МСК, по умолчанию 30 дней) → RopRatingResponse.
// Только админы: superadmin / Администратор или action.big_brother_rop (BIG_BROTHER_SPEC.md, «Доступ»).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewRopRating(session)) return NextResponse.json({ error: 'Рейтинг РОПов — только администраторам' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  try {
    const data = await buildRopRating(parsePeriod(sp.get('from'), sp.get('to')));
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother rop]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
