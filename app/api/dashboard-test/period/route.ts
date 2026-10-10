import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { buildDashboardPeriod } from '@/features/dashboard-test/engine/period';
import { isDashPeriod } from '@/features/dashboard-test/shared';

// Вкладки «Неделя / Месяц / Год» раздела «Дашборд тест»: ?period=week|month|year&offset=N
// (0 — текущий период, 1 — предыдущий…). Гейт тот же, что у самого дашборда.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.dashboard_test')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { searchParams } = new URL(req.url);
  const period = searchParams.get('period');
  if (!isDashPeriod(period)) {
    return NextResponse.json({ error: 'period должен быть week, month или year' }, { status: 400 });
  }
  const offset = Number.parseInt(searchParams.get('offset') ?? '0', 10);
  try {
    return NextResponse.json(await buildDashboardPeriod(period, Number.isFinite(offset) ? offset : 0), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[dashboard-test/period]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать данные за период' }, { status: 500 });
  }
}
