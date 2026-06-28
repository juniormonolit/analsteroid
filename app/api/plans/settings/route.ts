import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = systemDb();
  const res = await db.query<{ plan_n: string }>('SELECT plan_n FROM plan_settings WHERE id = 1');
  const plan_n = res.rows[0] ? parseFloat(res.rows[0].plan_n) : 0.8;
  return NextResponse.json({ plan_n });
}

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json() as { plan_n: number };
  const db = systemDb();
  await db.query(
    'UPDATE plan_settings SET plan_n = $1, updated_at = NOW() WHERE id = 1',
    [body.plan_n],
  );
  return NextResponse.json({ ok: true });
}
