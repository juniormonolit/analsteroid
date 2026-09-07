import { NextResponse } from 'next/server';
import { renderTvPage } from '@/features/tv/engine/page';

// Публичная страница телевизора (без сессии, см. proxy.ts PUBLIC). Телевизор
// открывает ровно этот адрес: получает токен устройства, показывает код привязки,
// после привязки в админке — дашборд своего экрана. Готовый HTML без React:
// причины — в шапке features/tv/engine/page.ts (движки ТВ-браузеров 2016–2019).
export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(renderTvPage({ mode: 'device' }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}
