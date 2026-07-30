import { NextRequest, NextResponse } from 'next/server';

// '/bx' — страницы, встроенные в Битрикс: редирект на /login внутри iframe портала
// показал бы форму входа вместо кабинета, поэтому гейт пропускает их, а сессию
// проверяет сама страница и объясняет причину человеку (app/(embed)/bx/manager).
const PUBLIC = ['/login', '/api/auth/login', '/invite', '/bot-avatar.png', '/bx'];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some(p => pathname.startsWith(p))) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.next(); // API handles auth itself

  const session = req.cookies.get('as_session');
  if (!session?.value) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
