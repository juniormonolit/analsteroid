// Задачник: справочники формы собрания — отделы продаж и люди в зоне текущего пользователя.
import { NextResponse } from 'next/server';
import { canSeeDept, canSeeManager } from '@/lib/org/sessionScope';
import { getSalesDepartmentOptions } from '@/lib/org/teamRoster';
import { getActiveEmployeeRoster } from '@/lib/org/employeeDirectory';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import { canPickOrganizer } from '@/features/tasker/meetings/engine/store';
import type { TaskerMeetingOptionsResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const [depts, roster] = await Promise.all([getSalesDepartmentOptions(), getActiveEmployeeRoster()]);
    const out: TaskerMeetingOptionsResponse = {
      departments: depts.filter(d => canSeeDept(auth.scope, d.id)).map(d => ({ id: d.id, name: d.name, path: d.path ?? null })),
      people: roster
        .filter(e => canSeeManager(auth.scope, String(e.bitrixId)) && !/^User \d+$/.test(e.name))
        .map(e => ({ id: e.bitrixId, name: e.name, deptName: e.departmentName }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      canPickOrganizer: canPickOrganizer(auth.session),
      selfBitrixId: auth.session.bitrixUserId ? Number(auth.session.bitrixUserId) : null,
    };
    return NextResponse.json(out);
  } catch (e) { return errorResponse(e); }
}
