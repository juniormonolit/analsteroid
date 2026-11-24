import { NextResponse } from 'next/server';
import { dismissalFail, dismissalGuard } from '@/features/dismissal/engine/http';
import { listDismissalDepartments } from '@/features/dismissal/engine/users';

export const dynamic = 'force-dynamic';

// Отделы для «раскидать по отделу»: только активные сотрудники (тот же снимок user.get, что и /users).
export async function GET() {
  const g = await dismissalGuard();
  if (g.error) return g.error;
  try {
    return NextResponse.json({ departments: await listDismissalDepartments() });
  } catch (e) {
    return dismissalFail(e, 'departments');
  }
}
