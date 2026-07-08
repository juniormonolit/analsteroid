import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json();

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (typeof body.is_active === 'boolean') {
    fields.push(`is_active = $${i++}`);
    values.push(body.is_active);
  }
  // Роль. is_superadmin через API не меняется никогда — только руками в БД.
  if (typeof body.role_id === 'string') {
    const db = systemDb();
    const role = await db.query(`SELECT id FROM roles WHERE id = $1`, [body.role_id]);
    if (!role.rows.length) return NextResponse.json({ error: 'Роль не найдена' }, { status: 400 });
    fields.push(`role_id = $${i++}`);
    values.push(body.role_id);
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
