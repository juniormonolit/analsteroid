import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { buildDashboardTest } from '@/features/dashboard-test/engine/build';

// Данные раздела «Дашборд тест». Картина по всей компании, поэтому гейт тот же, что у
// страницы: администратор ИЛИ явное право роли section.dashboard_test.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.dashboard_test')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    return NextResponse.json(await buildDashboardTest(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[dashboard-test]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать дашборд' }, { status: 500 });
  }
}
