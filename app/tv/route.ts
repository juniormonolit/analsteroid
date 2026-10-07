import { NextRequest, NextResponse } from 'next/server';
import { isTvMock, mockToken } from '@/features/tv/mock';
import { DEFAULT_TV_SKIN, isTvSkinId, renderTvScreen } from '@/features/tv/ui/tvScreen';

// Публичная страница телевизора (без сессии, см. proxy.ts PUBLIC). Телевизор
// открывает ровно этот адрес: получает токен устройства, показывает код привязки,
// после привязки в админке — дашборд своего экрана. Готовый HTML без React:
// причины — в шапке features/tv/engine/page.ts (движки ТВ-браузеров 2016–2019).
//
// Страницу собирает движок, оформление поверх неё кладёт renderTvScreen
// (features/tv/ui/tvScreen.ts).
//
// Мок-режим (TV_MOCK=1 и не production, см. features/tv/mock.ts): устройству нечем
// зарегистрироваться без базы, поэтому экран рисуется сразу по «токену экрана», в
// котором зашиты тема и сцены из адреса (/tv?theme=light&scene=event). Там же — и
// только там — можно включить прежнее оформление для сравнения: /tv?skin=kulikov.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const skin = q.get('skin');
  const html = isTvMock()
    ? renderTvScreen({ mode: 'screen', token: mockToken(q) }, isTvSkinId(skin) ? skin : DEFAULT_TV_SKIN)
    : renderTvScreen({ mode: 'device' });
  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}
