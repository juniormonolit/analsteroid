import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { rerollQuest, buyExtraQuest } from '@/features/quests/engine/quests';

// Реролл квеста / докуп доп. дневного (миграция 125). ТОЛЬКО свои квесты и
// свой кошелёк: списание идёт с кошелька сессии, чужие квесты не рероллятся
// (РОПу «пересоздать без списания» — этап после запуска, решение при внедрении).
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 400 });

  let body: { action?: string; questId?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 }); }

  const mgr = Number(session.bitrixUserId);
  const db = systemDb();
  if (body.action === 'extra') {
    const res = await buyExtraQuest(db, mgr, session.login);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ ok: true, quest: res.quest });
  }
  const questId = Number(body.questId);
  if (!Number.isInteger(questId) || questId <= 0) {
    return NextResponse.json({ error: 'questId обязателен' }, { status: 400 });
  }
  const res = await rerollQuest(db, mgr, questId, session.login);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, quest: res.quest });
}
