import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { markSeen } from '@/features/big-deals-kanban/engine/fresh';

// Карточка открыта — отметить просмотренной (индикатор «новое», engine/fresh.ts). Ответ — прошлая отметка (prev):
// по ней лента рисует разделитель «— новое с прошлого раза —». Пишет только отметку ТЕКУЩЕГО пользователя, данных
// задачи не отдаёт — поэтому без проверки зоны (лишний поход в Битрикс на каждое открытие).
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const taskId = Number((await ctx.params).id);
  if (!Number.isInteger(taskId) || taskId <= 0) return NextResponse.json({ error: 'Некорректная задача' }, { status: 400 });
  try {
    return NextResponse.json({ prev: await markSeen(String(session.id), taskId) });
  } catch (e) {
    console.warn('[big-deals seen]', e instanceof Error ? e.message : e);
    return NextResponse.json({ prev: null });
  }
}
