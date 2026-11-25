import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewPeople, scopedPeople } from '@/features/big-brother/engine/daily/access';
import { buildDigestText, digestWeek, sendDigestToMe } from '@/lib/jobs/bigBrotherDigest';

// Дайджест «Большого брата»: POST { action: 'preview' } — текст за прошлую неделю по срезу нажавшего (ничего не шлёт);
// { action: 'send_me' } — тот же текст ботом «Аналитик» самому нажавшему.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewPeople(session)) return NextResponse.json({ error: 'Нет доступа' }, { status: 403 });
  const { action } = await req.json().catch(() => ({ action: 'preview' }));
  try {
    if (action === 'send_me') {
      const r = await sendDigestToMe(session);
      return NextResponse.json({ ...r, week: digestWeek() });
    }
    return NextResponse.json({ sent: false, text: await buildDigestText(await scopedPeople(session)), week: digestWeek() });
  } catch (e) {
    console.error('[big-brother digest]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка' }, { status: 500 });
  }
}
