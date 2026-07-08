import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { getSession, SESSION_COOKIE } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Смена собственного пароля из ЛК.
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const oldPassword = String(body.oldPassword ?? '');
  const newPassword = String(body.newPassword ?? '');

  if (newPassword.length < 8) {
    return NextResponse.json({ error: 'Новый пароль должен быть не короче 8 символов' }, { status: 400 });
  }

  const db = systemDb();
  const res = await db.query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [session.id]
  );
  if (!res.rows.length) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });

  const ok = await bcrypt.compare(oldPassword, res.rows[0].password_hash);
  if (!ok) return NextResponse.json({ error: 'Неверный текущий пароль' }, { status: 403 });

  const hash = await bcrypt.hash(newPassword, 10);
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, session.id]);

  // Разлогинить остальные устройства, текущую сессию оставить
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    await db.query(`DELETE FROM user_sessions WHERE user_id = $1 AND token <> $2`, [session.id, token]);
  }

  return NextResponse.json({ ok: true });
}
