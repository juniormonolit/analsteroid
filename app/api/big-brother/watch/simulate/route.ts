import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { simulateIdleWatchDay } from '@/lib/bots/idleWatch';
import { canManageIdleWatch } from '@/features/big-brother/ui/watch/access';

// Прогон «что было бы» по дню: текущие правила и окно на исторических сигналах, без записи и отправки.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!canManageIdleWatch(session)) return NextResponse.json({ error: 'нет доступа' }, { status: 403 });
  const date = req.nextUrl.searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'date=YYYY-MM-DD' }, { status: 400 });
  try {
    return NextResponse.json(await simulateIdleWatchDay(date));
  } catch (e) {
    if ((e as { code?: string })?.code === '42P01') {
      return NextResponse.json({ error: 'Миграция 295 (idle_watch_*) ещё не накачена' }, { status: 503 });
    }
    throw e;
  }
}
