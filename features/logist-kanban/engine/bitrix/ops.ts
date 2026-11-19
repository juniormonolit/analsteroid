// S4 — действие над запросом → шаги записи в дубль-задачу Битрикса (чистая функция, без сети и БД;
// проверяется scripts/assert-logist-bx.ts). Выполняет шаги sync.ts.
import type { RequestDetails } from '../requests/contract';
import type { LogistHookCtx } from '../requests/hooks';
import { itemsAddedComment, messageComment, money, offerComment, requestMarker, taskDescription, taskTitle } from './format';

// ── операции ───────────────────────────────────────────────────────────────────────────

/** Операция очереди — один атомарный шаг (повтор после сбоя не задваивает уже сделанное до него).
 *  as — от чьего имени (bitrix id), asName — подпись, если id нет. */
export type BxOp =
  | { op: 'create_task'; title: string; description: string; groupId: number; managerId: string; dealId: number | null; deadline: string | null; marker: string }
  | { op: 'comment'; as: string | null; asName: string; comment: string; messageId?: number }
  /** исполнитель (и проект); pause — «Выполняется» → «Ждёт выполнения»; start — от исполнителя → «Выполняется» */
  | { op: 'assign'; responsibleId: string; groupId?: number; pause?: boolean; start?: boolean }
  | { op: 'complete'; as: string }
  | { op: 'reopen'; as: string | null }
  | { op: 'close'; as: string | null };

const actorName = (ctx: LogistHookCtx) => ctx.actor.name || ctx.actor.login || 'пользователь Монолитики';
const lastEvent = (r: RequestDetails, kind: string) => [...r.events].reverse().find(e => e.kind === kind) ?? null;
const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Действие → шаги (с готовыми текстами: синк не перечитывает запрос). Пустой массив — писать нечего. */
export function opsForChange(ctx: LogistHookCtx, app: string, portal: string): BxOp[] {
  const r = ctx.request;
  const as = ctx.actor.bitrixId, asName = actorName(ctx);
  const who = (verb: string) => `[B]${asName}[/B] ${verb}`;
  const say = (comment: string): BxOp => ({ op: 'comment', as, asName, comment });
  const mgr = r.manager.bitrixId;
  switch (ctx.action) {
    case 'send':
      if (!r.queue || !mgr) return [];
      return [{
        op: 'create_task', title: taskTitle(r), description: taskDescription(r, { app, portal }), groupId: r.queue.groupId,
        managerId: mgr, dealId: r.deal?.id ?? null, deadline: r.sla.deadline, marker: requestMarker(app, r.id),
      }];
    case 'take':
      return r.logist ? [{ op: 'assign', responsibleId: r.logist.bitrixId, start: true }] : [];
    case 'release': {
      const c = txt(lastEvent(r, 'released')?.data.comment);
      return mgr ? [say(`${who('вернул(а) запрос в очередь')}${c ? `: ${c}` : ''}`), { op: 'assign', responsibleId: mgr, pause: true }] : [];
    }
    case 'transfer': {
      const c = txt(lastEvent(r, 'transferred')?.data.comment);
      if (!r.queue || !mgr) return [];
      return [say(`${who(`передал(а) запрос в очередь «${r.queue.name}»`)}${c ? `: ${c}` : ''}`),
        { op: 'assign', responsibleId: mgr, groupId: r.queue.groupId, pause: true }];
    }
    case 'reassign': {
      const e = lastEvent(r, 'reassigned');
      const c = txt(e?.data.comment);
      if (!r.logist) return [];
      return [{ op: 'assign', responsibleId: r.logist.bitrixId, start: e?.fromStatus === 'new' },
        say(`${who(`назначил(а) логиста: ${r.logist.name ?? r.logist.bitrixId}`)}${c ? `: ${c}` : ''}`)];
    }
    case 'answer': {
      const e = lastEvent(r, 'answered');
      const offer = r.offers.find(o => o.id === Number(e?.data.offerId)) ?? r.offers[r.offers.length - 1];
      if (!offer || !r.logist) return [];
      const lg = r.logist.bitrixId;
      const ops: BxOp[] = [];
      if (e?.fromStatus === 'new') ops.push({ op: 'assign', responsibleId: lg });
      ops.push({ op: 'comment', as: lg, asName: r.logist.name ?? asName, comment: offerComment(offer) });
      if (e?.fromStatus !== 'answered') ops.push({ op: 'complete', as: lg });
      return ops;
    }
    case 'withdraw_offer': {
      const n = r.offers.find(o => o.id === Number(lastEvent(r, 'offer_withdrawn')?.data.offerId))?.n;
      return [say(who(`отозвал(а) вариант${n ? ` №${n}` : ''}`))];
    }
    case 'return': {
      const c = txt(lastEvent(r, 'returned')?.data.comment);
      return [say(`${who('вернул(а) на доработку')}${c ? `:\n${c}` : ''}`), { op: 'reopen', as }];
    }
    case 'accept': {
      const o = r.offers.find(x => x.id === r.acceptedOfferId);
      return [say(who(`принял(а) вариант${o ? ` №${o.n} на ${money(o.total)} руб` : ''}`)), { op: 'close', as }];
    }
    case 'cancel':
      return [say(`${who('отменил(а) запрос')}${r.cancelReason ? `: ${r.cancelReason}` : ''}`), { op: 'close', as }];
    case 'add_items': {
      const ids = (lastEvent(r, 'items_added')?.data.itemIds as number[] | undefined) ?? [];
      const items = r.items.filter(i => ids.includes(i.id));
      return items.length ? [say(itemsAddedComment(items))] : [];
    }
    case 'message': {
      const m = r.messages.find(x => x.id === ctx.messageId);
      if (!m || m.deleted) return [];
      return [{ op: 'comment', as: m.author?.bitrixId ?? null, asName: m.author?.name ?? m.authorLogin ?? asName,
        comment: messageComment(m.body, m.files.length, null), messageId: m.id }];
    }
    default:
      return []; // create (черновик), update_draft — в Битриксе ничего
  }
}

