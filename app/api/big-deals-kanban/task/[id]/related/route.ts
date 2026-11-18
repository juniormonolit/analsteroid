import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { bigActor } from '@/features/big-deals-kanban/engine/actor';
import { BigActionError, fetchBigTask, taskPeople } from '@/features/big-deals-kanban/engine/actions';
import { canSeeTask } from '@/features/big-deals-kanban/engine/visibility';
import { fetchChat, type BxTaskFull } from '@/features/big-deals-kanban/engine/taskDetails';
import { BIG_DEALS_GROUP_IDS } from '@/features/big-deals-kanban/engine/config';

// Чат связанной задачи (логист, снабжение) по сделке задачи больших чеков — вкладка «Задачи по сделке»
// (собрание РОПов 18.11: «задачи списком, кликабельные, и раскрывался чатик из них»). Только чтение.
// Доступ: большая задача видна смотрящему (как карточка) И связанная задача привязана к той же сделке —
// произвольную задачу по id отсюда не прочитать.
export const dynamic = 'force-dynamic';

const dealsOf = (t: BxTaskFull) => new Set((t.ufCrmTask ?? []).map(x => /^D_(\d+)$/.exec(String(x))?.[1]).filter(Boolean) as string[]);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const taskId = Number((await ctx.params).id);
  const relId = Number(req.nextUrl.searchParams.get('rel'));
  if (!Number.isInteger(taskId) || taskId <= 0 || !Number.isInteger(relId) || relId <= 0) return NextResponse.json({ error: 'Некорректная задача' }, { status: 400 });
  try {
    const [t, rel] = await Promise.all([fetchBigTask<BxTaskFull>(taskId), fetchBigTask<BxTaskFull>(relId, ['DESCRIPTION', 'CHAT_ID'])]);
    if (!t || !rel) return NextResponse.json({ error: 'Задача не найдена в Битриксе' }, { status: 404 });
    if (!BIG_DEALS_GROUP_IDS.includes(Number(t.groupId))) return NextResponse.json({ error: 'Задача не из проектов больших сделок' }, { status: 403 });
    const actor = await bigActor(session);
    if (!canSeeTask(await taskPeople(t), actor)) return NextResponse.json({ error: 'Задача не в вашей зоне' }, { status: 403 });
    const mine = dealsOf(t);
    if (![...dealsOf(rel)].some(d => mine.has(d))) return NextResponse.json({ error: 'Задача не по этой сделке' }, { status: 403 });
    const chat = rel.chatId ? await fetchChat(Number(rel.chatId)).catch(() => null) : null;
    const description = String(rel.description ?? '').replace(/\[[^\]]+\]/g, '').trim().slice(0, 3000);
    return NextResponse.json({ id: relId, chat, description }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof BigActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[big-deals related]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Битрикс не отдал задачу' }, { status: 502 });
  }
}
