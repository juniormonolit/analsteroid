import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const body = await req.json();

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (typeof body.is_active === 'boolean') {
    fields.push(`is_active = $${i++}`);
    values.push(body.is_active);
  }
  if (typeof body.is_admin === 'boolean') {
    fields.push(`is_admin = $${i++}`);
    values.push(body.is_admin);
  }

  if (!fields.length) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 });
  }

  values.push(id);
  const db = systemDb();
  const res = await db.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING id`,
    values
  );

  if (!res.rows.length) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
