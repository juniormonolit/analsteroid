// Точки расширения для S4 (Битрикс) и S5 (уведомления). Движок вызывает их ПОСЛЕ коммита транзакции;
// ошибка хука не откатывает действие (пишется в лог / статус синка).
// S4: дубль-задача — engine/bitrix/sync.ts (очередь logist_bx_outbox, асинхронно), товары сделки — engine/bitrix/dealRows.ts.
// Вся запись в Битрикс за флагами engine/bitrix/config.ts (по умолчанию выключена).
import type { ActionKind, DealRowsStatus, Offer, RequestDetails } from './contract';
import type { DealRowsConfirm } from '../bitrix/types';

export interface LogistHookCtx {
  action: ActionKind | 'create' | 'message';
  request: RequestDetails;
  actor: { bitrixId: string | null; login: string; name: string };
  /** id событий журнала, добавленных этим действием */
  eventIds: number[];
  /** для action='message' */
  messageId?: number;
}

/** После любого изменения запроса. S4: дубль-задача Битрикса (создать при send, статусы, комментарии) — ставится
 *  в очередь и выполняется фоном, действие не ждёт Битрикс; S5: бот «Аналитик», канал logist_requests. */
export async function afterLogistChange(ctx: LogistHookCtx): Promise<void> {
  try {
    const { enqueueForChange } = await import('../bitrix/sync');
    await enqueueForChange(ctx);
  } catch (e) {
    console.error('[logist-bx] очередь', ctx.action, ctx.request.id, e instanceof Error ? e.message : e);
  }
}

/** «Принять вариант» → переписать товары сделки (crm.deal.productrows.set от имени менеджера). S4.
 *  Пишет только с подтверждением предпросмотра (confirm.hash) и при включённом LOGIST_BX_DEAL_ROWS,
 *  иначе 'skipped' с причиной. Ошибку не бросает. */
export async function writeDealRowsForAcceptedOffer(input: {
  request: RequestDetails; offer: Offer; actor: { bitrixId: string | null; login: string }; confirm?: DealRowsConfirm | null;
}): Promise<{ status: DealRowsStatus; error?: string | null }> {
  const { writeDealRows } = await import('../bitrix/dealRows');
  const r = await writeDealRows({ request: input.request, offer: input.offer, actor: input.actor, confirm: input.confirm });
  return { status: r.status, error: r.error };
}
