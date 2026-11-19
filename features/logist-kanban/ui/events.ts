// Подписи событий журнала запроса (лента чата и вкладка «История»).
import type { RequestEvent } from '../engine/requests/contract';

const who = (e: RequestEvent) => e.actor?.name ?? 'Система';
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function eventText(e: RequestEvent, queueName: (id: number) => string | null = () => null, offerN: (id: number) => number | null = () => null): string {
  const d = e.data ?? {};
  const nOf = () => (typeof d.n === 'number' ? d.n : typeof d.offerId === 'number' ? offerN(d.offerId) : null);
  switch (e.kind) {
    case 'created': return `${who(e)} создал${d.source === 'robot' ? ' (по стадии сделки)' : ''} запрос`;
    case 'draft_updated': return `${who(e)} поправил черновик`;
    case 'sent': return `${who(e)} отправил запрос логисту`;
    case 'taken': return `${who(e)} взял в работу`;
    case 'released': return `${who(e)} отпустил запрос обратно в очередь${s(d.comment) ? `: «${s(d.comment)}»` : ''}`;
    case 'transferred': return `${who(e)} передал в другую очередь${typeof d.toQueueId === 'number' && queueName(d.toQueueId) ? ` — «${queueName(d.toQueueId)}»` : ''}${s(d.comment) ? `: «${s(d.comment)}»` : ''}`;
    case 'reassigned': {
      const to = d.to && typeof d.to === 'object' ? s((d.to as { name?: unknown }).name) : null;
      return `${who(e)} переназначил${to ? ` на ${to}` : ''}${s(d.comment) ? `: «${s(d.comment)}»` : ''}`;
    }
    case 'answered': return `${who(e)} ответил вариантом${typeof d.n === 'number' ? ` № ${d.n}` : ''}`;
    case 'offer_withdrawn': return `${who(e)} отозвал вариант${nOf() ? ` № ${nOf()}` : ''}`;
    case 'returned': return `${who(e)} вернул на доработку${s(d.comment) ? `: «${s(d.comment)}»` : ''}`;
    case 'accepted': return `${who(e)} принял вариант${nOf() ? ` № ${nOf()}` : ''}`;
    case 'cancelled': return `${who(e)} отменил запрос${s(d.reason) ? `: «${s(d.reason)}»` : ''}`;
    case 'items_added': return `${who(e)} добавил позиции${Array.isArray(d.itemIds) ? ` (${d.itemIds.length})` : ''}`;
    case 'message': return `${who(e)}: сообщение`;
    case 'outcome': return d.outcome === 'sold' ? 'Сделка продана' : d.outcome === 'lost' ? 'Сделка забракована' : 'Исход сделки изменился';
    case 'bx_sync': return 'Синхронизация с задачей Битрикса';
    case 'deal_rows': return `Товары сделки: ${s(d.status) ?? 'обновлены'}`;
    default: return e.kind;
  }
}

/** События, которые показываем в ленте чата (служебные «bx_sync»/«message» — нет). */
export const CHAT_EVENT_KINDS = new Set<RequestEvent['kind']>([
  'sent', 'taken', 'released', 'transferred', 'reassigned', 'answered', 'offer_withdrawn', 'returned', 'accepted', 'cancelled', 'items_added', 'outcome',
]);
