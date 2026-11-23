// Задачник: кто занят в планируемые слоты (календарь Битрикса + события Монолитики). Предупреждение, не запрет.
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canSeeDept, canSeeManager, getSessionScope } from '@/lib/org/sessionScope';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { checkAvailability, type Slot } from '@/features/tasker/engine/availability';
import { errorResponse, TaskerError } from '@/features/tasker/engine/config';
import type { TaskerAvailabilityRequest } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Планируют РОП/директор/админ (ставят задачи и собрания) и тренер (обучения).
  if (!hasPerm(session, 'section.tasker') || !(hasPerm(session, 'action.tasker.assign') || hasPerm(session, 'action.tasker.trainings.manage'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const b = (await req.json().catch(() => null) ?? {}) as Partial<TaskerAvailabilityRequest>;
    const slots: Slot[] = (Array.isArray(b.slots) ? b.slots : []).slice(0, 12).map(s => ({ start: Date.parse(s?.start ?? ''), end: Date.parse(s?.end ?? '') }))
      .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.end - s.start <= 24 * 3600_000);
    if (!slots.length) throw new TaskerError('Нет корректных слотов времени');
    const scope = await getSessionScope(session);
    const ids = new Set((Array.isArray(b.bitrixIds) ? b.bitrixIds : []).map(String).filter(x => /^\d+$/.test(x)));
    if (b.includeSelf && session.bitrixUserId) ids.add(String(session.bitrixUserId));
    const depts = (Array.isArray(b.departmentIds) ? b.departmentIds : []).map(String).filter(d => canSeeDept(scope, d)).slice(0, 50);
    if (depts.length) for (const m of await resolveManagersForDepartments(depts)) ids.add(String(m.managerId));
    if (ids.size > 400) throw new TaskerError('Слишком много людей для проверки (больше 400)');
    const me = session.bitrixUserId ? String(session.bitrixUserId) : null;
    const ex = b.exclude ?? {};
    return NextResponse.json(await checkAvailability([...ids], slots, {
      meetingId: Number(ex.meetingId) || null, trainingEventId: Number(ex.trainingEventId) || null,
      sessionId: Number(ex.sessionId) || null, taskId: Number(ex.taskId) || null,
    }, id => id === me || canSeeManager(scope, id)));
  } catch (e) {
    return errorResponse(e);
  }
}
