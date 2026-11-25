import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { BigActionError } from '@/features/big-deals-kanban/engine/actions';
import { bigActor } from '@/features/big-deals-kanban/engine/actor';
import { visibleTaskDealId } from '@/features/big-deals-kanban/engine/taskClient';
import { NOTE_MAX, saveNote } from '@/features/big-deals-kanban/engine/taskNotes';

// Комментарий к карточке задачи (Осипов 25.11). PUT { text } — сохранить, пустой текст — удалить.
// Писать может РОП (canManage), задача должна быть в его зоне (visibleTaskDealId — те же проверки, что у звонков).
// Читается вместе с доской (engine/taskNotes.ts → withNotes), отдельного GET нет.
export const dynamic = 'force-dynamic';

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null) as { text?: unknown } | null;
  if (!body || typeof body.text !== 'string') return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  if (body.text.length > NOTE_MAX) return NextResponse.json({ error: `Комментарий длиннее ${NOTE_MAX} символов` }, { status: 400 });
  try {
    const taskId = Number((await ctx.params).id);
    await visibleTaskDealId(session, taskId);
    const actor = await bigActor(session);
    if (!actor.canManage) return NextResponse.json({ error: 'Комментарий к карточке пишет РОП' }, { status: 403 });
    const note = await saveNote(taskId, body.text, { id: actor.userId, name: actor.name ?? session.login });
    console.info(`[big-deals note] ${session.login} task=${taskId} ${note ? `${note.text.length} симв.` : 'удалён'}`);
    return NextResponse.json({ note });
  } catch (e) {
    if (e instanceof BigActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[big-deals note]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось сохранить комментарий — повторите' }, { status: 500 });
  }
}
