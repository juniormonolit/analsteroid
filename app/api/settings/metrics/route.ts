import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ycAnalyticsDb } from '@/lib/db/clients';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const db = ycAnalyticsDb();
  const res = await db.query(`
    SELECT id, name_ru, name_short_ru, description, calc_ok, fill_ok,
           metric_type, data_type, formula, sort_order, is_core, is_hidden_in_ui, is_active
    FROM metrics
    ORDER BY sort_order, name_ru
  `);

  return NextResponse.json(res.rows);
}
