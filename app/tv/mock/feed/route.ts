import { NextRequest, NextResponse } from 'next/server';
import { buildMockFeed, isTvMock } from '@/features/tv/mock';

// Фид телевизора в мок-режиме (TV_MOCK=1 и не production — см. features/tv/mock.ts).
// Вне мок-режима адреса не существует: 404. Настоящий фид — app/api/tv/feed, он не менялся.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isTvMock()) return new NextResponse(null, { status: 404 });
  const q = req.nextUrl.searchParams;
  return NextResponse.json(buildMockFeed(q.get('s'), q.get('node')), { headers: { 'Cache-Control': 'no-store' } });
}
