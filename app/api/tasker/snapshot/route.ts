// Задачник: снимок цифр менеджеров для формы (значение · среднее отдела · своё среднее за 6 мес.).
import { NextRequest, NextResponse } from 'next/server';
import { canSeeManager } from '@/lib/org/sessionScope';
import { taskerAuth } from '@/features/tasker/engine/http';
import { computeSnapshots, snapshotCacheScope, stripMeta } from '@/features/tasker/engine/snapshot';
import { inRequestRunner } from '@/features/tasker/engine/reportRunner';
import { errorResponse, isYmd, metricDef, TaskerError } from '@/features/tasker/engine/config';
import type { TaskerSnapshotRequest, TaskerSnapshotResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const b = (await req.json().catch(() => null) ?? {}) as Partial<TaskerSnapshotRequest>;
    const ids = Array.isArray(b.managerIds) ? [...new Set(b.managerIds.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (!ids.length) throw new TaskerError('Не выбраны менеджеры');
    if (ids.length > 50) throw new TaskerError('Не больше 50 менеджеров за раз');
    if (!b.metricId) throw new TaskerError('Не выбран показатель');
    if (!b.period || !isYmd(b.period.from) || !isYmd(b.period.to) || b.period.from > b.period.to) throw new TaskerError('Некорректный период');
    const visible = ids.filter(id => canSeeManager(auth.scope, String(id)));
    if (!visible.length) return NextResponse.json({ error: 'Эти менеджеры вам недоступны', code: 'forbidden' }, { status: 403 });
    const metric = await metricDef(b.metricId);
    const snaps = await computeSnapshots(inRequestRunner, visible.map(String), metric, { from: b.period.from, to: b.period.to },
      { cacheScope: snapshotCacheScope(auth.scope.kind, auth.session.id) });
    const out: TaskerSnapshotResponse = {};
    for (const id of visible) out[String(id)] = stripMeta(snaps[String(id)]);
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
