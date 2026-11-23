// Задачник: регулярные собрания — список серий (+ вхождения в окне from–to) и создание серии.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth, intParam, ymdParam } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import { createMeeting, getMeeting, listMeetings } from '@/features/tasker/meetings/engine/store';
import { syncMeetingCalendar } from '@/features/tasker/meetings/engine/calendar';
import type { TaskerMeetingResponse, TaskerMeetingsResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const sp = req.nextUrl.searchParams;
  try {
    const out: TaskerMeetingsResponse = await listMeetings(auth.session, auth.scope, {
      from: ymdParam(sp.get('from')), to: ymdParam(sp.get('to')),
      includeCancelled: sp.get('cancelled') === '1', managerId: intParam(sp.get('managerId')),
    });
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const id = await createMeeting(auth.session, auth.scope, await req.json().catch(() => null));
    await syncMeetingCalendar(id); // не бросает: сбой календаря — состояние «не синхронизировано», повтор фоном
    const out: TaskerMeetingResponse = { meeting: await getMeeting(auth.session, auth.scope, id) };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
