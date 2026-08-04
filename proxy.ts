import { NextRequest, NextResponse } from 'next/server';

// '/bx' — страницы, встроенные в Битрикс: редирект на /login внутри iframe портала
// показал бы форму входа вместо кабинета, поэтому гейт пропускает их, а сессию
// проверяет сама страница и объясняет причину человеку (app/(embed)/bx/manager).
//
// PWA-ассеты (задача 2764, найдено при добавлении манифеста): без этого
// /manifest.webmanifest и все иконки 307-редиректились на /login для
// неавторизованных — браузер не идёт по редиректу, когда проверяет манифест
// для установки, то есть приложение НИКОГДА не предложило бы «на домашний
// экран», а до логина в лучшем случае даже вкладка была бы без иконки.
//
// /sw.js и /offline.html (задача 2947, тот же класс бага, найденный живьём
// на dev-стенде при проверке этой задачи): service worker регистрируется и
// фетчит офлайн-заглушку ДО какого-либо логина (на /login тоже должен
// работать офлайн-режим) — без паблик-доступа оба 307-редиректились бы на
// /login, ломая ровно ту фичу, ради которой их добавили.
const PUBLIC = [
  '/login', '/api/auth/login', '/invite', '/bot-avatar.png', '/bx',
  '/manifest.webmanifest', '/icon.svg', '/apple-icon.png', '/icons',
  '/sw.js', '/offline.html',
];

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
