import { NextRequest, NextResponse } from 'next/server';
import type { MyRequestsResponse } from '@/features/logist-kanban/engine/requests/contract';
import { NO_STORE, withActor } from '@/features/logist-kanban/engine/requests/http';
import { countMyAttention, loadMyRequests } from '@/features/logist-kanban/engine/requests/my';

// «Мои запросы» менеджера в ЛК (S5). GET ?days=90 → MyRequestsResponse; GET ?count=1 → { attention } (счётчик меню ЛК).
// Видит любой вошедший — только свои запросы (менеджер запроса или автор).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get('count') === '1') {
    return withActor('my:count', async a => NextResponse.json({ attention: await countMyAttention(a) }, { headers: NO_STORE }), { zone: false });
  }
  return withActor('my', async a => {
    const days = Number(sp.get('days') ?? 90);
    const res: MyRequestsResponse = await loadMyRequests(a, { days: Number.isFinite(days) ? days : 90 });
    return NextResponse.json(res, { headers: NO_STORE });
  });
}
