// Задачник: за сколько напоминать менеджеру о работе с ним (собрание 26.11, ТЗ tz/2026-11-26_tasker.md п.2).
// GET — всем с разделом; PUT — право «Задачник: шаблоны» (как конструктор тем), значения 15 / 30 / 60 / 1440 минут.
import { NextRequest, NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse, TaskerError } from '@/features/tasker/engine/config';
import { canManageTemplates } from '@/features/tasker/engine/templates';
import { loadRemindMinutes, REMIND_OPTIONS, saveRemindMinutes } from '@/features/tasker/engine/managerNotify';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    return NextResponse.json({ remindMinutes: await loadRemindMinutes(), options: REMIND_OPTIONS, canEdit: canManageTemplates(auth.session) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  if (!canManageTemplates(auth.session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const b = (await req.json().catch(() => null) ?? {}) as { remindMinutes?: unknown };
    const n = Number(b.remindMinutes);
    if (!(REMIND_OPTIONS as readonly number[]).includes(n)) throw new TaskerError('Напоминание — за 15 минут, 30 минут, час или день');
    return NextResponse.json({ remindMinutes: await saveRemindMinutes(n), options: REMIND_OPTIONS, canEdit: true });
  } catch (e) {
    return errorResponse(e);
  }
}
