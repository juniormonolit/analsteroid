import { NextRequest, NextResponse } from 'next/server';
import { renderTvPage } from '@/features/tv/engine/page';

// Экран по публичному токену: прямая ссылка с телевизора без привязки и превью
// в админке (?preview=1 — без звука событий). Существование токена проверяет
// фид: несуществующий → телевизор покажет «Экран удалён».
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preview = req.nextUrl.searchParams.get('preview') === '1';
  return new NextResponse(renderTvPage({ mode: 'screen', token, preview }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}
