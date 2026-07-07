import { NextRequest, NextResponse } from 'next/server';
import { systemDb } from '@/lib/db/clients';
import { createSession, setSessionCookie } from '@/lib/auth/session';
import { checkLoginRateLimit, recordLoginFailure, recordLoginSuccess } from '@/lib/auth/rateLimit';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  const { login, password } = await req.json();
  if (!login || !password) {
    return NextResponse.json({ error: 'Введите логин и пароль' }, { status: 400 });
  }

  const loginStr = String(login).toLowerCase().trim();

  const limit = checkLoginRateLimit(req, loginStr);
  if (limit.blocked) {
    return NextResponse.json(
      { error: 'Слишком много попыток входа. Попробуйте позже.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const db = systemDb();
  const res = await db.query<{ id: string; password_hash: string; is_active: boolean }>(
    `SELECT id, password_hash, is_active FROM users WHERE login = $1`,
    [loginStr]
  );

  const user = res.rows[0];
  if (!user || !user.is_active) {
    recordLoginFailure(req, loginStr);
    return NextResponse.json({ error: 'Неверный логин или пароль' }, { status: 401 });
  }

  const valid = await bcrypt.compare(String(password), user.password_hash);
  if (!valid) {
    recordLoginFailure(req, loginStr);
    return NextResponse.json({ error: 'Неверный логин или пароль' }, { status: 401 });
  }

  recordLoginSuccess(req, loginStr);
  const token = await createSession(user.id);

  const response = NextResponse.json({ ok: true });
  setSessionCookie(response, token);
  return response;
}
