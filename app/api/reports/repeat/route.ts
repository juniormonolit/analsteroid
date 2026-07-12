import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { fetchRepeatReport } from '@/features/reports/engine/repeat';

// Раздел «Повторные» (#1725). Доступ — как у всего раздела «Продажи» (section.sales).
// Данные — по всей истории клиентов (без периода), см. features/reports/engine/repeat.ts.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.sales')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const report = await fetchRepeatReport();
    return NextResponse.json(report);
  } catch (e) {
    console.error('[api/reports/repeat] failed:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
