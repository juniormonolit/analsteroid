// Задачник: правка / архив темы (конструктор, миграция 282). Удаления нет — архив. Право action.tasker.templates.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import { canManageTemplates } from '@/features/tasker/engine/templates';
import { updateTopic } from '@/features/tasker/engine/topics';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  if (!canManageTemplates(auth.session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const id = decodeURIComponent((await params).id).slice(0, 200);
  try {
    return NextResponse.json({ topic: await updateTopic(auth.session, id, (await req.json().catch(() => null)) ?? {}) });
  } catch (e) {
    return errorResponse(e);
  }
}
