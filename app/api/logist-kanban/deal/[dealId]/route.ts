import { NextRequest, NextResponse } from 'next/server';
import type { DealRequestsResponse } from '@/features/logist-kanban/engine/requests/contract';
import { NO_STORE, parseId, withActor } from '@/features/logist-kanban/engine/requests/http';
import { loadDealRequests } from '@/features/logist-kanban/engine/requests/repo';

// GET /api/logist-kanban/deal/:dealId → DealRequestsResponse: запросы по сделке (видимые пользователю).
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await ctx.params;
  return withActor('deal', async a => {
    const id = parseId(dealId, 'id сделки');
    const r = await loadDealRequests(a, id);
    return NextResponse.json({ dealId: id, ...r } satisfies DealRequestsResponse, { headers: NO_STORE });
  });
}
