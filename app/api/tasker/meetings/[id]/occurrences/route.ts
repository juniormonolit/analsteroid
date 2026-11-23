// Задачник: отменить / вернуть одну встречу серии { date, cancelled }. Только в Монолитике — Битрикс через REST
// EXDATE не принимает (проверено 23.11); у «скользящего» события календарь переедет на следующую встречу.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth, intParam } from '@/features/tasker/engine/http';
import { errorResponse, TaskerError } from '@/features/tasker/engine/config';
import { getMeeting, getMeetingRow, setOccurrence } from '@/features/tasker/meetings/engine/store';
import { syncMeetingCalendar } from '@/features/tasker/meetings/engine/calendar';
import type { TaskerMeetingResponse, TaskerOccurrenceRequest } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const id = intParam((await ctx.params).id);
    if (!id) throw new TaskerError('Некорректный id');
    const b = (await req.json().catch(() => null) ?? {}) as Partial<TaskerOccurrenceRequest>;
    await setOccurrence(auth.session, auth.scope, id, b.date, b.cancelled !== false);
    if ((await getMeetingRow(id))?.calendar_mode === 'rolling') await syncMeetingCalendar(id);
    const out: TaskerMeetingResponse = { meeting: await getMeeting(auth.session, auth.scope, id) };
    return NextResponse.json(out);
  } catch (e) { return errorResponse(e); }
}
