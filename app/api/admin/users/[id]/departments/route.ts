import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Подконтрольные отделы пользователя (для сводки в его ЛК).
// Храним только явно отмеченные узлы — дочерние включаются по дереву в коде.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  const { id } = await params;
  const res = await systemDb().query<{ department_id: string }>(
    `SELECT department_id::text AS department_id FROM user_departments WHERE user_id = $1`,
    [id]
  );
  return NextResponse.json({ departmentIds: res.rows.map((r) => r.department_id) });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = permError(session, 'action.users.manage');
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const rawIds: unknown[] = Array.isArray(body.departmentIds) ? body.departmentIds : [];
  const departmentIds = [...new Set(rawIds.filter((d): d is string => typeof d === 'string'))];

  const db = systemDb();
  const user = await db.query(`SELECT id FROM users WHERE id = $1`, [id]);
  if (!user.rows.length) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });

  // Полная замена набора в одной транзакции
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_departments WHERE user_id = $1`, [id]);
    if (departmentIds.length) {
      await client.query(
        `INSERT INTO user_departments (user_id, department_id)
         SELECT $1, d.id FROM departments d WHERE d.id = ANY($2::uuid[])`,
        [id, departmentIds]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return NextResponse.json({ ok: true });
}
