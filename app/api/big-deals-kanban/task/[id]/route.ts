import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { bigActor } from '@/features/big-deals-kanban/engine/actor';
import { BigActionError, fetchBigTask, taskVisible } from '@/features/big-deals-kanban/engine/actions';
import { fetchTaskDetails, type BxTaskFull } from '@/features/big-deals-kanban/engine/taskDetails';
import { BIG_DEALS_GROUP_IDS } from '@/features/big-deals-kanban/engine/config';

// Открытая карточка задачи канбана больших чеков: описание, товары сделки, чат задачи (taskDetails.ts).
// Только задачи проектов больших сделок и только в зоне смотрящего — чужие задачи по id отсюда не прочитать.
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const taskId = Number((await ctx.params).id);
  if (!Number.isInteger(taskId) || taskId <= 0) return NextResponse.json({ error: 'Некорректная задача' }, { status: 400 });
  try {
    const t = await fetchBigTask<BxTaskFull>(taskId, ['DESCRIPTION', 'CHAT_ID']);
    if (!t) return NextResponse.json({ error: 'Задача не найдена в Битриксе' }, { status: 404 });
    if (!BIG_DEALS_GROUP_IDS.includes(Number(t.groupId))) return NextResponse.json({ error: 'Задача не из проектов больших сделок' }, { status: 403 });
    if (!taskVisible(t, await bigActor(session))) return NextResponse.json({ error: 'Задача не в вашей зоне' }, { status: 403 });
    const deal = (t.ufCrmTask ?? []).map(x => /^D_(\d+)$/.exec(String(x))?.[1]).find(Boolean);
    const details = await fetchTaskDetails(t, deal ? Number(deal) : null);
    return NextResponse.json(details, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof BigActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[big-deals task]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Битрикс не отдал задачу' }, { status: 502 });
  }
}
