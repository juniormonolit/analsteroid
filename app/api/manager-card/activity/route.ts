import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildManagerActivity } from '@/features/manager-card/engine/activityCalendar';

// «График работы» менеджера (таб карточки, задача Иосифа 16.07): окна как у
// Claude-статистики — всё (26 недель) / 30д / 7д. Гейт — сессия (как /api/manager-card).

const WINDOWS: Record<string, number> = { all: 182, '30d': 30, '7d': 7 };

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { managerId, window = 'all' } = body as { managerId?: string; window?: string };
  if (!managerId || !/^\d+$/.test(String(managerId))) {
    return NextResponse.json({ error: 'managerId обязателен' }, { status: 400 });
  }
  const windowDays = WINDOWS[window] ?? WINDOWS.all;

  try {
    const result = await buildManagerActivity(String(managerId), windowDays);
    return NextResponse.json(result);
  } catch (e) {
    console.error('[manager-card/activity]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось посчитать график работы' }, { status: 502 });
  }
}
