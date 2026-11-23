// Задачник: кому текущий пользователь может ставить задачи (срез canSeeManager) — для поля «Менеджеры».
import { NextResponse } from 'next/server';
import { canSeeManager } from '@/lib/org/sessionScope';
import { getActiveEmployeeRoster } from '@/lib/org/employeeDirectory';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse } from '@/features/tasker/engine/config';
import type { TaskerManagersResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const roster = await getActiveEmployeeRoster();
    const managers = roster
      .filter(e => canSeeManager(auth.scope, String(e.bitrixId)) && !/^User \d+$/.test(e.name))
      .map(e => ({ id: e.bitrixId, name: e.name, deptName: e.departmentName }))
      .sort((a, b) => (a.deptName ?? '').localeCompare(b.deptName ?? '', 'ru') || a.name.localeCompare(b.name, 'ru'));
    const out: TaskerManagersResponse = { managers };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
