// План/факт-полоса ЛК (Сегодня · Неделя · Месяц) — POST { managerId } либо
// { departmentId, mode: 'department' } (uuid отдела или 'all' — все назначенные
// отделы пользователя, как в department-card).

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildPlanFact } from '@/features/manager-card/engine/planFact';
import { resolveManagersForDepartments, getUserDepartmentOptions } from '@/lib/org/teamRoster';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { managerAccessError, hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const mode = body.mode === 'department' ? 'department' : 'manager';

  try {
    let managerIds: string[];
    if (mode === 'manager') {
      const managerId = String(body.managerId ?? '');
      if (!/^\d+$/.test(managerId)) return NextResponse.json({ error: 'managerId (число) обязателен' }, { status: 400 });
      const accessErr = await managerAccessError(session, managerId);
      if (accessErr) return accessErr;
      managerIds = [managerId];
    } else {
      const departmentId = String(body.departmentId ?? '');
      if (!departmentId) return NextResponse.json({ error: 'departmentId обязателен' }, { status: 400 });
      // Явный uuid отдела: сверяем с подконтрольными — иначе любой мог бы прочитать
      // план/факт чужого отдела, подставив его uuid ('my'/'all' и так считаются
      // от самого пользователя).
      if (departmentId !== 'my' && departmentId !== 'all' && !hasFullManagerAccess(session)) {
        const allowed = await managedDepartmentIds(session);
        if (!allowed.includes(departmentId)) {
          return NextResponse.json({ error: 'Отдел недоступен' }, { status: 403 });
        }
      }
      // 'my' — отделы по оргструктуре «Контроля звонков» (ЛК РОПа/директора)
      const deptIds = departmentId === 'my'
        ? (session.bitrixUserId ? (await getCallControlManagedDepts(session.bitrixUserId)).map(m => m.deptId) : [])
        : departmentId === 'all'
          ? (await getUserDepartmentOptions(session.id)).map(o => o.id)
          : [departmentId];
      if (deptIds.length === 0) return NextResponse.json({ error: 'Отделы не назначены' }, { status: 403 });
      const roster = await resolveManagersForDepartments(deptIds);
      managerIds = roster.map(m => m.managerId);
      if (managerIds.length === 0) return NextResponse.json({ error: 'В отделе нет активных менеджеров' }, { status: 404 });
    }

    const result = await buildPlanFact(managerIds);
    return NextResponse.json(result);
  } catch (e) {
    console.error('[plan-fact] failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта план/факта' }, { status: 500 });
  }
}
