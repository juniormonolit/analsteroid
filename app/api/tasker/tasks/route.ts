// Задачник: список задач (доска / неделя / сегодня) и создание задач (TASKER_SPEC.md, контракт API).
import { NextRequest, NextResponse } from 'next/server';
import { permError } from '@/lib/auth/perms';
import { taskerAuth, intParam, ymdParam } from '@/features/tasker/engine/http';
import { listSessions, listTasks } from '@/features/tasker/engine/repo';
import { createTasks } from '@/features/tasker/engine/create';
import { errorResponse } from '@/features/tasker/engine/config';
import { getTrainingActor, listEnrollments } from '@/features/tasker/trainings/engine';
import { listMeetings } from '@/features/tasker/meetings/engine/store';
import type { TaskerTasksQuery, TaskerTasksResponse, TaskerView } from '@/features/tasker/types';
import { logTaskerCreated } from '@/lib/activity/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const sp = req.nextUrl.searchParams;
  const view = (['board', 'week', 'today'] as const).includes(sp.get('view') as TaskerView) ? sp.get('view') as TaskerView : 'board';
  const mine = sp.get('mine');
  const q: TaskerTasksQuery = {
    view,
    from: ymdParam(sp.get('from')) ?? undefined,
    to: ymdParam(sp.get('to')) ?? undefined,
    managerId: intParam(sp.get('managerId')) ?? undefined,
    ropId: intParam(sp.get('ropId')) ?? undefined,
    metricId: sp.get('metricId') || undefined,
    mine: mine === 'created' || mine === 'watch' ? mine : undefined,
  };
  try {
    const tasks = await listTasks(auth.session, auth.scope, q);
    const sessions = await listSessions(auth.session, auth.scope, {
      ropId: q.ropId ?? null, metricId: q.metricId ?? null, from: q.from ?? null, to: q.to ?? null,
      // Доска без окна — сессии её задач; неделя/сегодня — сессии в окне.
      ...(q.from || q.to ? {} : { ids: [...new Set(tasks.map(t => t.sessionId).filter((x): x is number => x !== null))] }),
    });
    // Записи на обучения (сессия D, миграция 275) — для «Недели»/«Сегодня»; сбой обучений не ломает доску.
    const trainings = await getTrainingActor(auth.session)
      .then(actor => listEnrollments(actor, { managerIds: q.managerId ? [q.managerId] : [], from: q.from ?? null, to: q.to ?? null }))
      .catch(e => { console.warn('[tasker] обучения:', e instanceof Error ? e.message : e); return []; });
    // Вхождения регулярных собраний — только для «Недели»/«Сегодня» (окно задано); сбой не ломает виды.
    const meetings = q.from && q.to
      ? await listMeetings(auth.session, auth.scope, { from: q.from, to: q.to, managerId: q.managerId ?? null })
        .then(r => r.occurrences)
        .catch(e => { if ((e as { code?: string }).code !== '42P01') console.warn('[tasker] собрания:', e instanceof Error ? e.message : e); return []; })
      : [];
    const body: TaskerTasksResponse = { tasks, sessions, trainings, meetings };
    return NextResponse.json(body);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  const denied = permError(auth.session, 'action.tasker.assign');
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    const out = await createTasks(auth.session, auth.scope, body);
    void logTaskerCreated(auth.session, out.created, 'metric');
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
