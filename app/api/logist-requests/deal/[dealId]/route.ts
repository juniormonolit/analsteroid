import { NextResponse } from 'next/server';
import { loadNames, personOf } from '@/features/big-deals-kanban/engine/enrich';
import type { DealSnapshotResponse } from '@/features/logist-kanban/engine/requests/contract';
import { managerRegion, readDeal } from '@/features/logist-kanban/engine/requests/dealSource';
import { NO_STORE, parseId, withActor } from '@/features/logist-kanban/engine/requests/http';
import { LogistError, loadDealRequests } from '@/features/logist-kanban/engine/requests/repo';
import { dealUrl } from '@/features/logist-kanban/engine/requests/mapper';
import { loadQueues } from '@/features/logist-kanban/engine/requests/queues';
import { pickDefaultQueue } from '@/features/logist-kanban/engine/requests/routing';
import { typeByStage } from '@/features/logist-kanban/engine/requests/trigger';

// GET /api/logist-requests/deal/:dealId → DealSnapshotResponse — шапка и товары сделки для формы «Запрос логисту»
// (S2). Битрикс только ЧИТАЕТСЯ; ничего не создаёт — запрос создаётся по «Отправить» (POST /api/logist-kanban/drafts).
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_req: Request, ctx: { params: Promise<{ dealId: string }> }) {
  return withActor('deal-snapshot', async a => {
    const dealId = parseId((await ctx.params).dealId, 'id сделки');
    const deal = await readDeal(dealId).catch(e => { throw new LogistError(`Не удалось прочитать сделку ${dealId} из Битрикса: ${e instanceof Error ? e.message : e}`, 502, 'invalid'); });
    const managerId = deal.assignedBitrixId && deal.assignedBitrixId !== '0' ? String(deal.assignedBitrixId) : null;
    // очередь — по региону того, кто будет менеджером запроса (сам нажавший), как в POST /drafts
    const regionOf = a.bitrixId ?? managerId;
    const [region, queues, open] = await Promise.all([
      regionOf ? managerRegion(regionOf) : Promise.resolve(null),
      loadQueues({ activeOnly: true }),
      loadDealRequests(a, dealId),
      managerId ? loadNames([managerId]).catch(() => undefined) : Promise.resolve(),
    ]);
    const q = pickDefaultQueue(queues, region, deal.productGroups);
    const res: DealSnapshotResponse = {
      deal: { id: deal.dealId, title: deal.title, amount: deal.amount, categoryId: deal.categoryId, stageId: deal.stageId, url: dealUrl(deal.dealId) },
      client: { ref: deal.clientRef, name: deal.clientName },
      manager: managerId ? { bitrixId: managerId, name: personOf(managerId)?.name ?? null } : null,
      address: deal.address, items: deal.items, productGroups: deal.productGroups,
      stageType: typeByStage(deal.stageId), defaultQueueId: q?.id ?? null, openByType: open.openByType,
    };
    return NextResponse.json(res, { headers: NO_STORE });
  }, { zone: false });
}
