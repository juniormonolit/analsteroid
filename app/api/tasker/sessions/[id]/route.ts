// Задачник: действия у сессии — «Провёл» (done/undone) и «Перенести» (reschedule), UX-аудит 23.11 п.39.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth, intParam } from '@/features/tasker/engine/http';
import { patchSession } from '@/features/tasker/engine/sessionActions';
import { errorResponse } from '@/features/tasker/engine/config';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const id = intParam((await params).id);
  if (!id) return NextResponse.json({ error: 'Некорректный id', code: 'bad_request' }, { status: 400 });
  try {
    const body = await req.json().catch(() => null);
    return NextResponse.json(await patchSession(auth.session, auth.scope, id, body));
  } catch (e) {
    return errorResponse(e);
  }
}
