// Строки БД → DTO контракта. Чистые функции (pg отдаёт numeric/bigint строками — приводим здесь).
import type {
  ChatMessage, DealRef, FileRef, LogistSettings, Offer, OfferLine, PersonRef, QueueRef, RequestCard, RequestEvent, RequestItem,
  RequestStatus, RequestType, RequestSource, DealOutcome, SyncStatus, DealRowsStatus, EventKind, Availability, OfferStatus, ItemKind,
} from './contract';
import { columnOf } from './filters';
import { computePriority, computeSla } from './priority';
import type { RequestPeople } from './status';
import { workHoursBetween } from './worktime';

export const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;

type N = string | number | null;
export const toNum = (v: N | undefined): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const dateOnly = (v: Date | string | null | undefined): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  // pg date → Date в локальной зоне процесса; берём календарные поля, а не UTC
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
};
const person = (id: string | null | undefined, name: string | null | undefined): PersonRef | null =>
  id ? { bitrixId: String(id), name: name ?? null } : null;

/** logist_requests.* + агрегаты из repo.ts (CARD_SELECT). */
export interface RequestRow {
  id: N; type: string; status: string; source: string;
  deal_id: N; deal_title: string | null; deal_category_id: N; deal_stage_id: string | null; deal_amount: N;
  client_ref: string | null; client_name: string | null;
  manager_bitrix_id: string; manager_name: string | null; manager_region: string | null; created_by_login: string | null;
  queue_id: N; logist_bitrix_id: string | null; logist_name: string | null;
  address: string | null; purpose: string | null; payment_form: string | null; delivery_date: Date | string | null; comment: string | null;
  competitor_name: string | null; competitor_total: N;
  cycle: N; returns_count: N; cycle_started_at: Date | string | null;
  sent_at: Date | string | null; taken_at: Date | string | null; answered_at: Date | string | null;
  accepted_at: Date | string | null; accepted_offer_id: N; cancelled_at: Date | string | null; cancel_reason: string | null;
  last_event_at: Date | string; deal_outcome: string | null; deal_outcome_at: Date | string | null;
  bx_task_id: N; bx_sync_status: string; bx_sync_error: string | null;
  deal_rows_status: string; deal_rows_error: string | null;
  version: N; created_at: Date | string; updated_at: Date | string;
  // агрегаты
  items_brief?: { name: string; quantity: N; measure: string | null; our_price: N; product_group: string | null; competitor_price: N }[] | null;
  offers_count?: N; unread?: N;
}

export function peopleOf(r: RequestRow): RequestPeople {
  return {
    status: r.status as RequestStatus, managerBitrixId: r.manager_bitrix_id, createdByLogin: r.created_by_login,
    logistBitrixId: r.logist_bitrix_id, queueId: toNum(r.queue_id),
  };
}

const qty = (q: number | null, m: string | null) => (q === null ? '' : ` ${q.toLocaleString('ru-RU')}${m ? ` ${m}` : ''}`);

export interface CardCtx { queues: Map<number, QueueRef & { slaHours: number | null }>; settings: LogistSettings; now: Date }

export function toCard(r: RequestRow, ctx: CardCtx): RequestCard {
  const status = r.status as RequestStatus;
  const queueId = toNum(r.queue_id);
  const q = queueId !== null ? ctx.queues.get(queueId) ?? null : null;
  const items = r.items_brief ?? [];
  const ourTotal = Math.round(items.reduce((a, i) => a + (toNum(i.quantity) ?? 0) * (toNum(i.our_price) ?? 0), 0) * 100) / 100;
  const compByItems = items.some(i => i.competitor_price !== null)
    ? items.reduce((a, i) => a + (toNum(i.quantity) ?? 1) * (toNum(i.competitor_price) ?? 0), 0) : null;
  const dealAmount = toNum(r.deal_amount);
  const amount = dealAmount ?? ourTotal;
  const dealId = toNum(r.deal_id);
  const deal: DealRef | null = dealId ? {
    id: dealId, title: r.deal_title, amount: dealAmount, categoryId: toNum(r.deal_category_id), stageId: r.deal_stage_id, url: dealUrl(dealId),
  } : null;
  const lastEventAt = iso(r.last_event_at)!;
  const sla = computeSla({ status, cycleStartedAt: iso(r.cycle_started_at), queueSlaHours: q?.slaHours ?? null }, ctx.settings, ctx.now);
  const returnsCount = toNum(r.returns_count) ?? 0;
  const deliveryDate = dateOnly(r.delivery_date);
  const priority = computePriority({ type: r.type as RequestType, status, amount, deliveryDate, returnsCount, lastEventAt, sla }, ctx.settings, ctx.now);
  const groups = [...new Set(items.map(i => i.product_group).filter((g): g is string => !!g))];
  const dealOutcome = (r.deal_outcome as DealOutcome | null) ?? null;
  return {
    id: Number(r.id), type: r.type as RequestType, status, source: r.source as RequestSource,
    column: columnOf({ status, dealOutcome }, 'board')!,
    deal, client: { ref: r.client_ref, name: r.client_name },
    manager: { bitrixId: r.manager_bitrix_id, name: r.manager_name },
    logist: person(r.logist_bitrix_id, r.logist_name),
    queue: q ? { id: q.id, groupId: q.groupId, name: q.name, region: q.region, dept: q.dept } : null,
    region: q?.region ?? r.manager_region ?? null, dept: q?.dept ?? null,
    productGroups: groups,
    itemsPreview: items.slice(0, 3).map(i => `${i.name}${qty(toNum(i.quantity), i.measure)}`).join('; ') + (items.length > 3 ? ` и ещё ${items.length - 3}` : ''),
    itemsCount: items.length,
    ourTotal,
    competitorTotal: toNum(r.competitor_total) ?? (compByItems !== null ? Math.round(compByItems * 100) / 100 : null),
    amount,
    deliveryDate, address: r.address,
    cycle: toNum(r.cycle) ?? 0, returnsCount, offersCount: toNum(r.offers_count ?? null) ?? 0,
    createdAt: iso(r.created_at)!, sentAt: iso(r.sent_at), takenAt: iso(r.taken_at), answeredAt: iso(r.answered_at),
    acceptedAt: iso(r.accepted_at), cancelledAt: iso(r.cancelled_at), lastEventAt,
    waitingHours: Math.round(workHoursBetween(lastEventAt, ctx.now) * 10) / 10,
    sla, priority, dealOutcome,
    bxTaskId: toNum(r.bx_task_id), bxSyncStatus: r.bx_sync_status as SyncStatus,
    unread: toNum(r.unread ?? null) ?? 0,
    version: toNum(r.version) ?? 0,
  };
}

// ── детали ──────────────────────────────────────────────────────────────────────────────

export interface FileRow { id: N; owner_kind: string | null; owner_id: N; name: string; size: N; mime: string | null; url: string | null }
export const toFile = (f: FileRow): FileRef => ({ id: Number(f.id), name: f.name, size: toNum(f.size), mime: f.mime, url: f.url });

export interface ItemRow {
  id: N; pos: N; kind: string; bx_row_id: N; bx_product_id: N; name: string; quantity: N; measure: string | null; our_price: N;
  product_group: string | null; competitor_price: N; comment: string | null; added_in_cycle: N;
}
export function toItem(r: ItemRow, files: FileRef[]): RequestItem {
  const q = toNum(r.quantity), p = toNum(r.our_price);
  return {
    id: Number(r.id), pos: Number(r.pos), kind: r.kind as ItemKind, bxRowId: toNum(r.bx_row_id), bxProductId: toNum(r.bx_product_id),
    name: r.name, quantity: q, measure: r.measure, ourPrice: p, ourSum: q !== null && p !== null ? Math.round(q * p * 100) / 100 : null,
    productGroup: r.product_group, competitorPrice: toNum(r.competitor_price), comment: r.comment, addedInCycle: Number(r.added_in_cycle), files,
  };
}

export interface OfferRow {
  id: N; n: N; cycle: N; author_bitrix_id: string | null; author_name: string | null; supplier: string | null; payment_form: string | null;
  lead_time: string | null; ready_date: Date | string | null; delivery_trucks: N; delivery_price: N; goods_total: N; delivery_total: N; total: N;
  comment: string | null; status: string; created_at: Date | string;
}
export interface OfferLineRow {
  id: N; offer_id: N; item_id: N; pos: N; availability: string; name: string; bx_product_id: N; quantity: N; measure: string | null;
  price: N; line_sum: N; comment: string | null;
}
export const toOfferLine = (l: OfferLineRow): OfferLine => ({
  id: Number(l.id), itemId: toNum(l.item_id), pos: Number(l.pos), availability: l.availability as Availability, name: l.name,
  bxProductId: toNum(l.bx_product_id), quantity: toNum(l.quantity), measure: l.measure, price: toNum(l.price), sum: toNum(l.line_sum), comment: l.comment,
});
export function toOffer(o: OfferRow, lines: OfferLine[], files: FileRef[]): Offer {
  return {
    id: Number(o.id), n: Number(o.n), cycle: Number(o.cycle), author: person(o.author_bitrix_id, o.author_name),
    supplier: o.supplier, paymentForm: o.payment_form, leadTime: o.lead_time, readyDate: dateOnly(o.ready_date),
    deliveryTrucks: toNum(o.delivery_trucks), deliveryPrice: toNum(o.delivery_price),
    goodsTotal: toNum(o.goods_total) ?? 0, deliveryTotal: toNum(o.delivery_total) ?? 0, total: toNum(o.total) ?? 0,
    comment: o.comment, status: o.status as OfferStatus, createdAt: iso(o.created_at)!, lines, files,
  };
}

export interface MessageRow {
  id: N; author_bitrix_id: string | null; author_login: string | null; author_name: string | null; body: string;
  created_at: Date | string; edited_at: Date | string | null; deleted_at: Date | string | null;
}
export const toMessage = (m: MessageRow, files: FileRef[]): ChatMessage => ({
  id: Number(m.id), author: person(m.author_bitrix_id, m.author_name), authorLogin: m.author_login,
  body: m.deleted_at ? '' : m.body, createdAt: iso(m.created_at)!, editedAt: iso(m.edited_at), deleted: !!m.deleted_at,
  files: m.deleted_at ? [] : files,
});

export interface EventRow {
  id: N; at: Date | string; kind: string; cycle: N; from_status: string | null; to_status: string | null; queue_id: N;
  actor_bitrix_id: string | null; actor_name: string | null; data: Record<string, unknown> | null;
}
export const toEvent = (e: EventRow): RequestEvent => ({
  id: Number(e.id), at: iso(e.at)!, kind: e.kind as EventKind, cycle: Number(e.cycle),
  fromStatus: e.from_status as RequestStatus | null, toStatus: e.to_status as RequestStatus | null,
  queueId: toNum(e.queue_id), actor: person(e.actor_bitrix_id, e.actor_name), data: e.data ?? {},
});

export const syncOf = (s: string) => s as SyncStatus;
export const dealRowsOf = (s: string) => s as DealRowsStatus;
