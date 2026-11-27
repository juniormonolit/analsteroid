// Задачник: лента занятости для формы «Практики» (собрание 26.11, ТЗ tz/2026-11-26_tasker.md п.3) — все интервалы
// занятости исполнителя и менеджеров на выбранный день и несколько рабочих дней вперёд. Свободные окна считает форма.
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canSeeManager, getSessionScope } from '@/lib/org/sessionScope';
import { busyIntervals } from '@/features/tasker/engine/availability';
import { errorResponse, isYmd, TaskerError } from '@/features/tasker/engine/config';
import type { TaskerBusyDaysRequest, TaskerBusyDaysResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.tasker') || !(hasPerm(session, 'action.tasker.assign') || hasPerm(session, 'action.tasker.trainings.manage'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const b = (await req.json().catch(() => null) ?? {}) as Partial<TaskerBusyDaysRequest>;
    if (!isYmd(b.from)) throw new TaskerError('Некорректный день');
    const days = Math.min(10, Math.max(1, Math.round(Number(b.days) || 1)));
    const ids = [...new Set((Array.isArray(b.bitrixIds) ? b.bitrixIds : []).map(String).filter(x => /^\d+$/.test(x)))].slice(0, 40);
    if (!ids.length) throw new TaskerError('Не выбраны люди');
    const from = Date.parse(`${b.from}T00:00:00+03:00`);
    const to = from + days * 86_400_000;
    const scope = await getSessionScope(session);
    const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
    const res = await busyIntervals(ids, from, to, id => id === me || canSeeManager(scope, id));
    const out: TaskerBusyDaysResponse = { ...res, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
