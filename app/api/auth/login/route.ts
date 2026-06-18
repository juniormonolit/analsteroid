import { NextRequest, NextResponse } from 'next/server';
import { systemDb } from '@/lib/db/clients';
import { createSession, SESSION_COOKIE, SESSION_TTL_DAYS } from '@/lib/auth/session';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  const { login, password } = await req.json();
  if (!login || !password) {
    return NextResponse.json({ error: 'Введите логин и пароль' }, { status: 400 });
  }

  const db = systemDb();
  const res = await db.query<{ id: string; password_hash: string; is_active: boolean }>(
    `SELECT id, password_hash, is_active FROM users WHERE login = $1`,
    [String(login).toLowerCase().trim()]
  );

  const user = res.rows[0];
  if (!user || !user.is_active) {
    return NextResponse.json({ error: 'Неверный логин или пароль' }, { status: 401 });
  }

  const valid = await bcrypt.compare(String(password), user.password_hash);
  if (!valid) {
    return NextResponse.json({ error: 'Неверный логин или пароль' }, { status: 401 });
  }

  const token = await createSession(user.id);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    path: '/',
  });
  return response;
}
