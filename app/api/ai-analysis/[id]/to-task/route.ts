import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { getAnalysis } from '@/features/ai-analysis/engine/store';
import { markMemoInserted, memoAlreadyInTask, openRepeatTask } from '@/features/ai-analysis/engine/memoStore';
import { memoBbcode } from '@/features/ai-analysis/engine/memo';
import { postToTaskChat } from '@/features/repeat-kanban/engine/createDeal';
import type { ClientRef } from '@/features/client-module/engine/types';

// «В открытую задачу» (этап 1.5): памятка из отчёта — комментарием в чат открытой задачи заказчика
// от имени РОПа (тот же способ, что первый комментарий при постановке, createDeal.ts:postToTaskChat).
// Описание задачи не трогаем — комментарий не затирает то, что менеджер уже видел.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'action.ai_call_analysis')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!session.bitrixUserId) return NextResponse.json({ error: 'К вашей учётке не привязан пользователь Битрикса — комментарий не от кого отправить' }, { status: 400 });
  const id = Number((await ctx.params).id);
  const a = Number.isInteger(id) ? await getAnalysis(id) : null;
  if (!a || a.status !== 'done' || !a.reportMd) return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 });
  try {
    const task = await openRepeatTask(a.clientRef as ClientRef);
    if (!task) return NextResponse.json({ error: 'У заказчика нет открытой задачи в «Повторных продажах»' }, { status: 404 });
    // Та же памятка уже в задаче (в описании при постановке или комментарием) — второй раз не шлём:
    // в мобильном Битриксе чат под описанием, менеджер увидел бы её дважды (разбор Fable 23.10).
    const already = await memoAlreadyInTask(task.id);
    if (already.includes(a.id)) return NextResponse.json({ error: 'Эта памятка уже есть в задаче' }, { status: 409 });
    const ok = await postToTaskChat(task.id, session.bitrixUserId, memoBbcode(a.reportMd, a.createdAt, { updated: already.length > 0 }));
    if (!ok) return NextResponse.json({ error: 'Битрикс не принял комментарий' }, { status: 502 });
    await markMemoInserted(a.id, task.id);
    return NextResponse.json({ taskId: task.id, responsibleName: task.responsibleName });
  } catch (e) {
    console.error('[ai-analysis/to-task]', e);
    return NextResponse.json({ error: 'Не удалось отправить памятку в задачу' }, { status: 500 });
  }
}
