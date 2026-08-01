import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { systemDb } from '@/lib/db/clients';
import { refreshQuests, loadQuestSettings, mskToday, isWorkDay } from '@/features/quests/engine/quests';

// Квесты ЛК (миграция 125): текущие слоты + история 8 недель. Генерация
// ленивая (недостающие слоты создаются при обращении), прогресс и автозачёт
// пересчитываются здесь же (плюс ночной тик). Доступ — canViewManager.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const requested = req.nextUrl.searchParams.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!bitrixId) return NextResponse.json({ current: [], history: [], settings: null });
  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const db = systemDb();
  const [data, settings] = await Promise.all([
    refreshQuests(db, Number(bitrixId)),
    loadQuestSettings(db),
  ]);
  // Цена следующего доп. квеста (растёт ×2 за каждый купленный на неделе).
  const week = await db.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM quests WHERE bitrix_id=$1 AND slot='extra'
      AND period_start >= date_trunc('week', $2::date)::date`,
    [Number(bitrixId), mskToday()],
  );
  const extraPrice = settings.extraDay * Math.pow(2, Number(week.rows[0]?.c ?? 0));
  return NextResponse.json({
    ...data,
    isSelf: bitrixId === session.bitrixUserId,
    workday: isWorkDay(mskToday()),
    prices: {
      rerollDay: settings.rerollDay, rerollWeek: settings.rerollWeek,
      rerollMonth: settings.rerollMonth, extra: extraPrice,
    },
    xpMult: settings.xpMult,
  });
}
