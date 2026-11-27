import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewRopRating } from '@/features/big-brother/engine/rop/access';
import { buildRopDay } from '@/features/big-brother/engine/rop/day';
import { isValidDate, mskDate } from '@/features/big-brother/engine/daily/time';

// «Большой брат» → «РОПы» → «День РОПа». GET ?date=YYYY-MM-DD (МСК, по умолчанию сегодня)&id=<Битрикс-id> →
// RopDayResponse: итог дня по всем руководителям + лента событий выбранного. Гейт — как у вкладки «РОПы» (только админы).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewRopRating(session)) return NextResponse.json({ error: 'Вкладка «РОПы» — только администраторам' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const raw = sp.get('date');
  const today = mskDate();
  const date = isValidDate(raw) && raw <= today ? raw : today;
  const id = sp.get('id');
  try {
    const data = await buildRopDay(date, id && /^\d+$/.test(id) ? id : null);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother rop/day]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
