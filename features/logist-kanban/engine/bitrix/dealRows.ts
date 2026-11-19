// S4 — «Принять вариант» → товары сделки (crm.deal.productrows.set). ПЕРВЫЙ вызов этого метода в проекте:
// проверять только на тестовой сделке (LOGIST_BX_ONLY_DEALS), первый боевой — с согласия владельца.
//
// Порядок: UI зовёт предпросмотр (GET /request/:id/deal-rows?offerId=) → показывает «было/станет» → «Принять»
// с { dealRows: { confirm: true, hash } }. Перед записью строки сделки перечитываются: отпечаток не совпал (сделку
// успели поменять) — не пишем, статус error «нужен новый предпросмотр». Без подтверждения — 'skipped'.
// productrows.set заменяет ВСЕ строки сделки — поэтому нетронутые строки передаём обратно как были (planDealRows).
// От имени нажавшего (callAsUser), нет токена/прав — CRM-вебхук (BITRIX_WEBHOOK_URL_2, scope crm на запись).
// Метод идемпотентен (полная замена), поэтому сетевой сбой можно повторять — POST /request/:id/deal-rows.
import { callAsUser } from '@/lib/bitrix/userTokens';
import { read, writeOnce } from '@/features/repeat-kanban/engine/createDeal';
import type { DealRowsStatus, Offer, RequestDetails } from '../requests/contract';
import { bxFlags, dealRowsBlockedReason } from './config';
import { planDealRows, rowsHash, rowsTotal, viewOfBx, type BxProductRow } from './format';
import type { DealRowsConfirm, DealRowsPreview } from './types';

function crmWriteWebhook(): string {
  const w = process.env.BITRIX_WEBHOOK_URL_2 || process.env.BITRIX_WEBHOOK_URL || '';
  if (!w) throw new Error('Не задан вебхук Битрикса');
  return w.replace(/\/+$/, '');
}

async function readRows(dealId: number): Promise<BxProductRow[]> {
  return (await read<BxProductRow[]>('crm.deal.productrows.get', { id: dealId })) ?? [];
}

export function buildPreview(r: RequestDetails, offer: Offer, before: BxProductRow[]): DealRowsPreview & { rows: ReturnType<typeof planDealRows>['rows'] } {
  const plan = planDealRows(before, r.items, offer);
  const bv = before.map(viewOfBx);
  const blocked = dealRowsBlockedReason(bxFlags(), r.deal?.id);
  return {
    dealId: r.deal!.id, offerId: offer.id, offerN: offer.n,
    before: bv, after: plan.after, changes: plan.changes,
    beforeTotal: rowsTotal(bv), afterTotal: rowsTotal(plan.after),
    warnings: plan.warnings, hash: rowsHash(before),
    writeEnabled: !blocked, blockedReason: blocked, rows: plan.rows,
  };
}

/** Предпросмотр: читает строки сделки, ничего не пишет. */
export async function previewDealRows(r: RequestDetails, offer: Offer): Promise<DealRowsPreview> {
  if (!r.deal) throw new Error('У запроса нет сделки');
  const { rows: _rows, ...p } = buildPreview(r, offer, await readRows(r.deal.id));
  void _rows;
  return p;
}

/** Запись строк принятого варианта. Никогда не бросает — статус и текст ошибки для deal_rows_*. */
export async function writeDealRows(input: {
  request: RequestDetails; offer: Offer; actor: { bitrixId: string | null }; confirm: DealRowsConfirm | null | undefined;
}): Promise<{ status: DealRowsStatus; error: string | null; preview?: DealRowsPreview }> {
  const { request: r, offer } = input;
  const blocked = dealRowsBlockedReason(bxFlags(), r.deal?.id);
  if (blocked) return { status: 'skipped', error: blocked };
  if (!input.confirm?.confirm) return { status: 'skipped', error: 'Товары сделки не переписаны: менеджер не подтвердил предпросмотр' };
  try {
    const before = await readRows(r.deal!.id);
    const full = buildPreview(r, offer, before);
    const { rows, ...preview } = full;
    if (input.confirm.hash !== preview.hash) {
      return { status: 'error', error: 'Товары сделки изменились после предпросмотра — откройте предпросмотр заново и подтвердите', preview };
    }
    if (!offer.lines.some(l => l.availability !== 'none')) return { status: 'skipped', error: 'В варианте нет позиций в наличии — сделка не изменена', preview };
    const params = { id: r.deal!.id, rows };
    const who = input.actor.bitrixId ?? r.manager.bitrixId;
    const mine = await callAsUser<boolean>(who, 'crm.deal.productrows.set', params).catch(e => {
      // сетевой сбой: метод идемпотентен — честно сообщаем, повтор безопасен
      throw new Error(`${e instanceof Error ? e.message : e}. Повтор безопасен (строки сделки заменяются целиком)`);
    });
    if (mine === undefined) await writeOnce<boolean>(crmWriteWebhook(), 'crm.deal.productrows.set', params);
    // сверка: строк столько, сколько отправили
    const after = await readRows(r.deal!.id).catch(() => null);
    if (after && after.length !== rows.length) {
      return { status: 'error', error: `Битрикс принял запись, но в сделке ${after.length} строк вместо ${rows.length} — проверьте сделку`, preview };
    }
    return { status: 'ok', error: null, preview };
  } catch (e) {
    return { status: 'error', error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) };
  }
}

/** Итог записи → logist_requests.deal_rows_* + событие журнала deal_rows (как в applyAction). */
export async function saveDealRowsResult(
  requestId: number, actor: { bitrixId: string | null; login: string; name: string }, res: { status: DealRowsStatus; error: string | null },
): Promise<void> {
  const { systemDb } = await import('@/lib/db/clients');
  const db = systemDb();
  await db.query(`UPDATE logist_requests SET deal_rows_status = $2, deal_rows_error = $3,
                         deal_rows_written_at = CASE WHEN $2 = 'ok' THEN now() ELSE deal_rows_written_at END WHERE id = $1`,
    [requestId, res.status, res.error]);
  await db.query(
    `INSERT INTO logist_request_events (request_id, kind, cycle, queue_id, actor_bitrix_id, actor_login, actor_name, data)
     SELECT id, 'deal_rows', cycle, queue_id, $2, $3, $4, $5 FROM logist_requests WHERE id = $1`,
    [requestId, actor.bitrixId, actor.login, actor.name, JSON.stringify({ status: res.status, error: res.error, retry: true })]);
}
