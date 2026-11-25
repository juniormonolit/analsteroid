import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewPeople, scopedPeople } from '@/features/big-brother/engine/daily/access';
import { isValidDate, mskDate } from '@/features/big-brother/engine/daily/time';
import { personDay } from '@/features/big-brother/engine/daily/timeline';

// «Большой брат» → «Люди» → лента дня человека. GET ?date=YYYY-MM-DD (МСК, по умолчанию сегодня). Считается вживую из
// источников (подробная лента Монолитики хранится 90 дней; звонки, сделки, задачи — без ограничения).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewPeople(session)) return NextResponse.json({ error: 'Раздел — для уровня «директор и выше»' }, { status: 403 });
  const { id } = await ctx.params;
  const raw = req.nextUrl.searchParams.get('date');
  const today = mskDate();
  const date = isValidDate(raw) && raw <= today ? raw : today;
  try {
    const person = (await scopedPeople(session)).find(p => p.id === id);
    if (!person) return NextResponse.json({ error: 'Сотрудник не найден или вне вашего среза' }, { status: 404 });
    return NextResponse.json(await personDay(person, date), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother people/day]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
