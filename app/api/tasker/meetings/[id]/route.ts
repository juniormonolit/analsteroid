// Задачник: одно регулярное собрание — чтение, правка серии (календарь = update), отмена серии (календарь = delete).
// POST — повторить синк календаря вручную.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth, intParam } from '@/features/tasker/engine/http';
import { errorResponse, TaskerError } from '@/features/tasker/engine/config';
import { cancelMeeting, canEditMeeting, getMeeting, getMeetingRow, updateMeeting } from '@/features/tasker/meetings/engine/store';
import { syncMeetingCalendar } from '@/features/tasker/meetings/engine/calendar';
import type { TaskerMeetingResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<number> {
  const id = intParam((await ctx.params).id);
  if (!id) throw new TaskerError('Некорректный id');
  return id;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const out: TaskerMeetingResponse = { meeting: await getMeeting(auth.session, auth.scope, await idOf(ctx)) };
    return NextResponse.json(out);
  } catch (e) { return errorResponse(e); }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const id = await idOf(ctx);
    await updateMeeting(auth.session, auth.scope, id, await req.json().catch(() => null));
    await syncMeetingCalendar(id);
    const out: TaskerMeetingResponse = { meeting: await getMeeting(auth.session, auth.scope, id) };
    return NextResponse.json(out);
  } catch (e) { return errorResponse(e); }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const id = await idOf(ctx);
    await cancelMeeting(auth.session, auth.scope, id);
    await syncMeetingCalendar(id);
    const out: TaskerMeetingResponse = { meeting: await getMeeting(auth.session, auth.scope, id) };
    return NextResponse.json(out);
  } catch (e) { return errorResponse(e); }
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const id = await idOf(ctx);
    const row = await getMeetingRow(id);
    if (!row || !canEditMeeting(auth.session, auth.scope, row)) throw new TaskerError('Собрание не найдено', 'forbidden', 404);
    await syncMeetingCalendar(id);
    const out: TaskerMeetingResponse = { meeting: await getMeeting(auth.session, auth.scope, id) };
    return NextResponse.json(out);
  } catch (e) { return errorResponse(e); }
}
