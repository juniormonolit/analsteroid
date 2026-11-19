import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE, jsonBody, parseId, withActor } from '@/features/logist-kanban/engine/requests/http';
import { LogistError, loadDetails } from '@/features/logist-kanban/engine/requests/repo';
import { InputError } from '@/features/logist-kanban/engine/requests/validate';
import { previewDealRows, saveDealRowsResult, writeDealRows } from '@/features/logist-kanban/engine/bitrix/dealRows';
import type { DealRowsWriteResponse } from '@/features/logist-kanban/engine/bitrix/types';
import type { RequestDetails } from '@/features/logist-kanban/engine/requests/contract';

// S4 — «Принять вариант» → товары сделки.
// GET  /api/logist-kanban/request/:id/deal-rows?offerId=  → DealRowsPreview («было/станет», ничего не пишет).
//      Без offerId — принятый вариант. Для подтверждения перед action accept { dealRows: { confirm: true, hash } }.
// POST /api/logist-kanban/request/:id/deal-rows  { confirm: true, hash } → DealRowsWriteResponse — записать строки
//      уже принятого варианта (повтор после ошибки / если при «Принять» не подтверждали).
// Кто: менеджер запроса или руководитель (canManage) — те же, кто может «Принять».
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

function pickOffer(d: RequestDetails, offerId: number | null) {
  if (!(d.roles.manager || d.roles.admin)) throw new LogistError('Товары сделки меняет менеджер запроса', 403, 'forbidden');
  if (!d.deal) throw new LogistError('Запрос без сделки — переписывать нечего', 400, 'invalid');
  const id = offerId ?? d.acceptedOfferId;
  const offer = d.offers.find(o => o.id === id);
  if (!offer || offer.status === 'withdrawn') throw new LogistError('Вариант не найден или отозван', 400, 'invalid');
  return offer;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor('deal-rows:preview', async a => {
    const raw = req.nextUrl.searchParams.get('offerId');
    const d = await loadDetails(a, parseId(id), { markRead: false });
    const offer = pickOffer(d, raw ? parseId(raw, 'id варианта') : null);
    try {
      return NextResponse.json(await previewDealRows(d, offer), { headers: NO_STORE });
    } catch (e) {
      throw new LogistError(`Не удалось прочитать товары сделки из Битрикса: ${e instanceof Error ? e.message : e}`, 502, 'invalid');
    }
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withActor('deal-rows:write', async a => {
    const b = (await jsonBody(req)) as Record<string, unknown>;
    if (b.confirm !== true || typeof b.hash !== 'string') throw new InputError('Нужно подтверждение предпросмотра: { confirm: true, hash }');
    const requestId = parseId(id);
    const d = await loadDetails(a, requestId, { markRead: false });
    if (d.status !== 'accepted' || !d.acceptedOfferId) throw new LogistError('Записать товары можно только по принятому варианту', 409, 'transition');
    const offer = pickOffer(d, d.acceptedOfferId);
    const res = await writeDealRows({ request: d, offer, actor: a, confirm: { confirm: true, hash: b.hash } });
    await saveDealRowsResult(requestId, a, { status: res.status, error: res.error });
    const preview = res.preview ?? await previewDealRows(d, offer).catch(() => null);
    return NextResponse.json({ status: res.status === 'ok' ? 'ok' : res.status === 'skipped' ? 'skipped' : 'error', error: res.error, preview } as DealRowsWriteResponse,
      { headers: NO_STORE });
  });
}
