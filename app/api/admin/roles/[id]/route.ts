import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { sanitizePermissions, superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json();
  const db = systemDb();

  const existing = await db.query<{ is_system: boolean }>(`SELECT is_system FROM roles WHERE id = $1`, [id]);
  if (!existing.rows.length) return NextResponse.json({ error: 'Роль не найдена' }, { status: 404 });

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  // У сидовых ролей имя фиксировано (на него завязан backfill/дефолты), права менять можно.
  if (typeof body.name === 'string' && body.name.trim()) {
    if (existing.rows[0].is_system) {
      return NextResponse.json({ error: 'Системную роль нельзя переименовать' }, { status: 400 });
    }
    fields.push(`name = $${i++}`);
    values.push(body.name.trim());
  }
  if (typeof body.description === 'string') {
    fields.push(`description = $${i++}`);
    values.push(body.description.trim() || null);
  }
  if (Array.isArray(body.permissions)) {
    fields.push(`permissions = $${i++}`);
    values.push(sanitizePermissions(body.permissions));
  }

  if (!fields.length) return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 });

  fields.push(`updated_at = now()`);
  values.push(id);
  try {
    await db.query(`UPDATE roles SET ${fields.join(', ')} WHERE id = $${i}`, values);
  } catch (e) {
    if (e instanceof Error && e.message.includes('duplicate key')) {
      return NextResponse.json({ error: 'Роль с таким названием уже существует' }, { status: 409 });
    }
    throw e;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const { id } = await params;
  const db = systemDb();

  const existing = await db.query<{ is_system: boolean; user_count: string }>(
    `SELECT is_system, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
     FROM roles r WHERE id = $1`,
    [id]
  );
  if (!existing.rows.length) return NextResponse.json({ error: 'Роль не найдена' }, { status: 404 });
  if (existing.rows[0].is_system) {
    return NextResponse.json({ error: 'Системную роль нельзя удалить' }, { status: 400 });
  }
  if (parseInt(existing.rows[0].user_count, 10) > 0) {
    return NextResponse.json({ error: 'Роль назначена пользователям — сначала переназначьте их' }, { status: 409 });
  }

  await db.query(`DELETE FROM roles WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
