import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUnsellDeal, listManualFixes } from '@/lib/sales/unsellDeal';

// Журнал последних ручных правок (задача #6260). Тот же гейт, что у страницы —
// админ ИЛИ явное право action.deals.unsell (директор+, выдаётся в «Настройки →
// Матрица прав»). РОП без выдачи получает 403.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canUnsellDeal(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const rows = await listManualFixes(50);
  return NextResponse.json({ rows });
}
