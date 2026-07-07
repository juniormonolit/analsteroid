import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

interface ImportItem {
  login: string;
  amount: number;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json() as { month: string; items: ImportItem[]; plan_n: number };
  const { month, items, plan_n } = body;

  if (!month || !items?.length) {
    return NextResponse.json({ saved: 0 });
  }

  const monthDate = `${month}-01`;
  const db = systemDb();

  let saved = 0;
  for (const item of items) {
    await db.query(
      `INSERT INTO manager_plans (manager_login, month, plan_shipments, plan_n, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (manager_login, month)
       DO UPDATE SET plan_shipments = EXCLUDED.plan_shipments, plan_n = EXCLUDED.plan_n, updated_at = NOW()`,
      [item.login, monthDate, item.amount, plan_n],
    );
    saved++;
  }

  return NextResponse.json({ saved });
}
