import { NextRequest, NextResponse } from 'next/server';
import type { DealRequestsResponse } from '@/features/logist-kanban/engine/requests/contract';
import { NO_STORE, parseId, withActor } from '@/features/logist-kanban/engine/requests/http';
import { loadDealRequests } from '@/features/logist-kanban/engine/requests/repo';
import { loadQueues } from '@/features/logist-kanban/engine/requests/queues';

// GET /api/logist-kanban/deal/:dealId → DealRequestsResponse: запросы по сделке (видимые пользователю), me и очереди —
// для карточки запроса на вкладке сделки в Битриксе (/bx/deal-requests).
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await ctx.params;
  return withActor('deal', async a => {
    const id = parseId(dealId, 'id сделки');
    const [r, queues] = await Promise.all([loadDealRequests(a, id), loadQueues({ activeOnly: true })]);
    const qRefs = queues.map(q => ({ id: q.id, groupId: q.groupId, name: q.name, region: q.region, dept: q.dept }));
    return NextResponse.json({ dealId: id, ...r, me: a.info, queues: qRefs } satisfies DealRequestsResponse, { headers: NO_STORE });
  });
}
