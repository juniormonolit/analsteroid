import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { systemDb } from '@/lib/db/clients';
import { createSession, setSessionCookie } from '@/lib/auth/session';

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { password } = await req.json();

  if (!password || String(password).length < 8) {
    return NextResponse.json({ error: 'Пароль должен быть не короче 8 символов' }, { status: 400 });
  }

  const db = systemDb();
  const res = await db.query<{ user_id: string; expires_at: string; used_at: string | null }>(
    `SELECT user_id, expires_at, used_at FROM invite_tokens WHERE token = $1`,
    [token]
  );
  const invite = res.rows[0];
  if (!invite) return NextResponse.json({ error: 'Приглашение не найдено' }, { status: 404 });
  if (invite.used_at) return NextResponse.json({ error: 'Приглашение уже использовано' }, { status: 410 });
  if (new Date(invite.expires_at) < new Date()) {
    return NextResponse.json({ error: 'Срок действия приглашения истёк' }, { status: 410 });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  await db.query(`UPDATE users SET password_hash = $1, is_active = true WHERE id = $2`, [
    passwordHash,
    invite.user_id,
  ]);
  await db.query(`UPDATE invite_tokens SET used_at = now() WHERE token = $1`, [token]);

  const sessionToken = await createSession(invite.user_id);
  const response = NextResponse.json({ ok: true });
  setSessionCookie(response, sessionToken);
  return response;
}
