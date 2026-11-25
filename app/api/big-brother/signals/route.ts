import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewPeople, scopedPeople } from '@/features/big-brother/engine/daily/access';
import { isValidDate, mskDate } from '@/features/big-brother/engine/daily/time';
import { buildSignalFeed } from '@/features/big-brother/engine/signals/load';
import { loadBotReaction } from '@/features/big-brother/engine/signals/botReaction';
import type { SignalsResponse } from '@/features/big-brother/engine/signals/types';

// «Большой брат» → «Сигналы»: лента сигналов риска на дату (?date, МСК, по умолчанию сегодня) + реакция на бота за 30 дней.
// Только подсказка директору: никаких автодействий. Доступ — «директор и выше», срез — getSessionScope.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewPeople(session)) return NextResponse.json({ error: 'Раздел — для уровня «директор и выше»' }, { status: 403 });
  const raw = req.nextUrl.searchParams.get('date');
  const today = mskDate();
  const asOf = isValidDate(raw) && raw <= today ? raw : today;
  try {
    const people = await scopedPeople(session);
    const [feed, bot] = await Promise.all([
      buildSignalFeed(people, asOf),
      loadBotReaction({ allowIds: new Set(people.map(p => p.id)), names: new Map(people.map(p => [p.id, p.name])) }).catch(e => {
        console.warn('[big-brother signals] реакция на бота:', e instanceof Error ? e.message : e);
        return { since: null, available: false, total: 0, opened: 0, acted: 0, silent: 0, medianOpenMin: null, medianActMin: null, byChannel: [], recent: [] };
      }),
    ]);
    const body: SignalsResponse = { asOf, monoSince: feed.monoSince, signals: feed.signals, bot };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother signals]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
