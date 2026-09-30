import { NextRequest, NextResponse } from 'next/server';
import { systemDb } from '@/lib/db/clients';
import { createSession, SESSION_COOKIE, SESSION_TTL_DAYS } from '@/lib/auth/session';
import { authLimiter, tooManyAttempts } from '@/lib/auth/loginRateLimit';
import { clientIpFromHeaders } from '@/lib/http/clientIp';
import bcrypt from 'bcryptjs';

// Хеш случайной строки (cost 10, как у паролей): сверка с ним при несуществующем
// или отключённом логине выравнивает время ответа — по нему нельзя перебирать
// существующие логины (аудит 29.09, #8256, A2).
const DUMMY_PASSWORD_HASH = '$2b$10$SHxJUB/lPylgLQeNa7HRNOPwPLdSspaYmEmV1WAesLAzKK46h.6kG';

export async function POST(req: NextRequest) {
  const { login, password } = await req.json().catch(() => ({}));
  if (!login || !password) {
    return NextResponse.json({ error: 'Введите логин и пароль' }, { status: 400 });
  }
  const normLogin = String(login).toLowerCase().trim();

  // Лимит неудачных попыток — по логину и по IP (аудит 29.09, #8256, A2).
  const ip = clientIpFromHeaders(req.headers);
  const limiter = authLimiter();
  const blocked = await limiter.blocked(ip, normLogin);
  if (blocked) return tooManyAttempts(blocked.retryAfterSec);

  const db = systemDb();
  const res = await db.query<{ id: string; password_hash: string; is_active: boolean }>(
    `SELECT id, password_hash, is_active FROM users WHERE login = $1`,
    [normLogin]
  );

  const user = res.rows[0];
  const usable = !!user && user.is_active;
  const valid = await bcrypt.compare(String(password), usable ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!usable || !valid) {
    await limiter.recordFailure(ip, normLogin);
    return NextResponse.json({ error: 'Неверный логин или пароль' }, { status: 401 });
  }
  await limiter.recordSuccess(ip, normLogin);

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
