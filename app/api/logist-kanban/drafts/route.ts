import { NextRequest, NextResponse } from 'next/server';
import { loadNames, personOf } from '@/features/big-deals-kanban/engine/enrich';
import type { CreateDraftResponse, ItemInput } from '@/features/logist-kanban/engine/requests/contract';
import { managerRegion, readDeal } from '@/features/logist-kanban/engine/requests/dealSource';
import { NO_STORE, jsonBody, withActor } from '@/features/logist-kanban/engine/requests/http';
import { LogistError, createDraft } from '@/features/logist-kanban/engine/requests/repo';
import { InputError, id, parseHeader, parseItems, parseType } from '@/features/logist-kanban/engine/requests/validate';

// POST /api/logist-kanban/drafts — создать черновик (CreateDraftBody → CreateDraftResponse); send: true — сразу в «Новые».
// С dealId — шапка и товары из Битрикса (только чтение). От чужого имени (managerBitrixId) — только руководитель
// логистики/админ (триггер S2 зовёт движок напрямую, а не этот роут).
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return withActor('drafts', async a => {
    const b = (await jsonBody(req)) as Record<string, unknown>;
    const type = parseType(b.type);
    const dealId = b.dealId == null ? null : id(b.dealId, 'id сделки');
    const header = b.header === undefined ? {} : parseHeader(b.header);
    const items: ItemInput[] | null = b.items === undefined ? null : parseItems(b.items);
    let managerId = a.bitrixId;
    if (b.managerBitrixId != null && String(b.managerBitrixId) !== a.bitrixId) {
      if (!a.canManage) throw new LogistError('Создавать запрос от имени другого менеджера может только руководитель логистики', 403, 'forbidden');
      if (!/^\d{1,10}$/.test(String(b.managerBitrixId))) throw new InputError('Некорректный managerBitrixId');
      managerId = String(b.managerBitrixId);
    }
    if (!managerId) throw new LogistError('Аккаунт не привязан к сотруднику Битрикса — запрос создать нельзя', 400, 'invalid');
    const deal = dealId ? await readDeal(dealId).catch(e => { throw new LogistError(`Не удалось прочитать сделку ${dealId} из Битрикса: ${e instanceof Error ? e.message : e}`, 502, 'invalid'); }) : null;
    let managerName: string | null = managerId === a.bitrixId ? a.name : null;
    if (!managerName) { await loadNames([managerId]); managerName = personOf(managerId)?.name ?? null; }
    const region = await managerRegion(managerId);
    const finalItems = items ?? deal?.items ?? [];
    const res: CreateDraftResponse = await createDraft(a, {
      type, source: 'button',
      manager: { bitrixId: managerId, name: managerName }, managerRegion: region, createdByLogin: a.login,
      deal: deal ? { id: deal.dealId, title: deal.title, amount: deal.amount, categoryId: deal.categoryId, stageId: deal.stageId, clientRef: deal.clientRef, clientName: deal.clientName, address: deal.address } : null,
      header, items: finalItems, sendNow: b.send === true,
      productGroups: [...new Set([...finalItems.map(i => i.productGroup).filter((g): g is string => !!g), ...(deal?.productGroups ?? [])])],
    });
    return NextResponse.json(res, { status: res.created ? 201 : 200, headers: NO_STORE });
  });
}
