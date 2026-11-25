import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { bigActor } from '@/features/big-deals-kanban/engine/actor';
import { MassCloseError, getMassCloseJob, planMassClose, startMassClose, type MassCloseInput } from '@/features/big-deals-kanban/engine/massClose';
import { normalizeFilters } from '@/features/big-deals-kanban/engine/filters';
import { logBigOther } from '@/lib/activity/services';

// Массовое закрытие задач канбана больших чеков (engine/massClose.ts, контракт BigMassCloseJob в types.ts).
// POST { taskIds } | { filters } + { dryRun?, comment?, expectedCount? }:
//   dryRun → { count, matched, limited, skipped, sample }; иначе → { jobId, total } (expectedCount — число из предпросмотра,
//   которое пользователь подтвердил; закрыть больше нельзя).
// GET ?job=<id> → BigMassCloseJob (только своя job; полной зоне — любая).
// Только canManage, только задачи, которые пользователь видит и может двигать.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => null) as { taskIds?: unknown; filters?: unknown; dryRun?: unknown; comment?: unknown; expectedCount?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  let input: MassCloseInput;
  if (Array.isArray(body.taskIds)) input = { taskIds: body.taskIds.map(Number) };
  else if (body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters)) input = { filters: normalizeFilters(body.filters) }; // мусор из тела отбрасывается
  else return NextResponse.json({ error: 'Нужен список задач или правило отбора' }, { status: 400 });
  if (typeof body.comment === 'string') input.comment = body.comment;
  try {
    const actor = { ...(await bigActor(session)), login: session.login };
    if (body.dryRun) {
      const p = await planMassClose(input, actor);
      return NextResponse.json({ count: p.count, matched: p.matched, limited: p.limited, skipped: p.skipped, sample: p.sample }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const r = await startMassClose(input, actor, session.login, Number(body.expectedCount));
    void logBigOther(session, 'mass_close', { count: r.total });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof MassCloseError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[big-deals mass-close]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось подготовить массовое закрытие' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const id = req.nextUrl.searchParams.get('job') ?? '';
  const actor = await bigActor(session);
  const job = getMassCloseJob(id, session.login, actor.zone === 'all');
  if (!job) return NextResponse.json({ error: 'Задание не найдено (сервер перезапускался?)' }, { status: 404 });
  return NextResponse.json(job, { headers: { 'Cache-Control': 'no-store' } });
}
