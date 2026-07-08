import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { computeUserDeptSummary } from '@/lib/profile/deptSummary';

// План/факт текущего месяца по подконтрольным отделам пользователя (для ЛК).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const summary = await computeUserDeptSummary(session.id);
    return NextResponse.json(summary);
  } catch (e) {
    console.error('[me/dept-summary] failed:', e);
    return NextResponse.json({ error: 'Не удалось собрать сводку' }, { status: 500 });
  }
}
