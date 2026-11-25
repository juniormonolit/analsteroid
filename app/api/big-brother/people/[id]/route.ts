import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewPeople, scopedPeople } from '@/features/big-brother/engine/daily/access';
import { personCalendar } from '@/features/big-brother/engine/daily/timeline';

// «Большой брат» → «Люди» → карточка: календарь активности по дням за год (activity_daily). Человек — только из среза.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewPeople(session)) return NextResponse.json({ error: 'Раздел — для уровня «директор и выше»' }, { status: 403 });
  const { id } = await ctx.params;
  try {
    const person = (await scopedPeople(session)).find(p => p.id === id);
    if (!person) return NextResponse.json({ error: 'Сотрудник не найден или вне вашего среза' }, { status: 404 });
    const cal = await personCalendar(id).catch(e => {
      if ((e as { code?: string })?.code === '42P01') return { from: '', to: '', days: [] };
      throw e;
    });
    return NextResponse.json(cal, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother people/id]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
