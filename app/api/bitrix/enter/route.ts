import { NextRequest, NextResponse } from 'next/server';
import { createSession, SESSION_COOKIE, SESSION_TTL_DAYS } from '@/lib/auth/session';
import { consumeHandoff } from '@/lib/bitrix/handoff';
import { getPublicOrigin } from '@/lib/http/publicOrigin';

// Вход по одноразовому ключу из приложения Битрикса (инцидент 21.09).
// Открывается В ОБЫЧНОЙ ВКЛАДКЕ, то есть в первостороннем контексте: здесь
// cookie ставится как при обычном входе (Lax) и работает в любом браузере,
// включая те, что режут третьесторонние cookie внутри iframe портала.
//
// Ключ одноразовый и живёт 10 минут (lib/bitrix/handoff.ts). Личность берётся
// ТОЛЬКО из него — никаких id из URL.

export async function GET(req: NextRequest) {
  // За Caddy req.nextUrl.origin — это bind-адрес процесса (https://0.0.0.0:8100),
  // и редирект уводил бы браузер в никуда. Реальный домен — из X-Forwarded-*.
  const origin = getPublicOrigin(req);
  const token = req.nextUrl.searchParams.get('t') ?? '';
  const userId = await consumeHandoff(token);
  if (!userId) {
    // Ключ просрочен или уже использован — отправляем человека на обычный вход,
    // а не показываем тупик. Из Битрикса он всегда может открыть приложение заново.
    return NextResponse.redirect(new URL('/login?from=bitrix', origin));
  }

  const session = await createSession(userId);
  const res = NextResponse.redirect(new URL('/profile', origin));
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',                       // первосторонний контекст — как обычный /login
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    path: '/',
  });
  return res;
}
