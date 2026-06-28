import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const res = await db.query<{
    manager_login: string;
    month: string;
    plan_shipments: string;
    plan_n: string;
  }>('SELECT manager_login, to_char(month, \'YYYY-MM\') as month, plan_shipments, plan_n FROM manager_plans ORDER BY month, manager_login');

  return NextResponse.json(
    res.rows.map(r => ({
      manager_login: r.manager_login,
      month: r.month,
      plan_shipments: parseFloat(r.plan_shipments),
      plan_n: parseFloat(r.plan_n),
    })),
  );
}
