// Хранилище запросов логистам (system DB): доска, карточка, черновик, действия, чат.
// Каждое действие — одна транзакция с SELECT … FOR UPDATE: статус + журнал + version меняются атомарно.
// Хуки S4/S5 (hooks.ts) — после коммита. Битрикс отсюда только ЧИТАЕТСЯ (dealSource.ts).
import type { PoolClient } from 'pg';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import {
  BOARD_COLUMNS, LOGIST_TURN,
  type ActionBody, type BoardResponse, type BoardView, type CreateDraftBody, type DraftHeaderInput, type EventKind,
  type ItemInput, type LogistFilters, type LogistQueue, type LogistSettings, type MessagesResponse, type OfferInput,
  type PersonRef, type QueueRef, type RequestCard, type RequestDetails, type RequestStatus, type RequestType,
} from './contract';
import type { LogistActor } from './actor';
import { buildCycles } from './cycles';
import { columnOf, matchFilters, sortComparator } from './filters';
import { afterLogistChange, writeDealRowsForAcceptedOffer, type LogistHookCtx } from './hooks';
import {
  peopleOf, toCard, toEvent, toFile, toItem, toMessage, toNum, toOffer, toOfferLine, dealRowsOf,
  type CardCtx, type EventRow, type FileRow, type ItemRow, type MessageRow, type OfferLineRow, type OfferRow, type RequestRow,
} from './mapper';
import { mergeSettings } from './priority';
import { loadQueues } from './queues';
import { pickDefaultQueue } from './routing';
import { allowedActions, canDo, canSee, NEXT_STATUS, rolesOf } from './status';
import { computeTiles, defaultPeriod } from './tiles';
import { InputError, offerTotals, sendProblems } from './validate';

/** Ошибка с HTTP-статусом и машинным кодом — API превращает её в ApiError. */
export class LogistError extends Error {
  status: number;
  code: 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'transition';
  constructor(message: string, status: number, code: LogistError['code']) { super(message); this.status = status; this.code = code; }
}

type Q = Pick<PoolClient, 'query'>;
const db = (): Q => systemDb();

// ── справочники ─────────────────────────────────────────────────────────────────────────

export async function loadSettings(q: Q = db()): Promise<LogistSettings> {
  const r = await q.query<{ value: unknown }>(`SELECT value FROM logist_request_settings WHERE key = 'main'`);
  return mergeSettings(r.rows[0]?.value);
}

export async function saveSettings(patch: unknown, by: string): Promise<LogistSettings> {
  const cur = await loadSettings();
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const merged = mergeSettings({ ...cur, ...p, weights: { ...cur.weights, ...((p.weights && typeof p.weights === 'object') ? p.weights as object : {}) } });
  await db().query(
    `INSERT INTO logist_request_settings (key, value, updated_at, updated_by) VALUES ('main', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(merged), by]);
  return merged;
}

function queueMap(queues: LogistQueue[]): CardCtx['queues'] {
  return new Map(queues.map(q => [q.id, { id: q.id, groupId: q.groupId, name: q.name, region: q.region, dept: q.dept, slaHours: q.slaHours }]));
}

// ── выборка ─────────────────────────────────────────────────────────────────────────────

/** SELECT карточки: r.* + краткие позиции, число вариантов, непрочитанные. $1 — bitrix id текущего (или ''). */
const CARD_SELECT = `
  SELECT r.*,
    (SELECT jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity, 'measure', i.measure, 'our_price', i.our_price,
                                         'product_group', i.product_group, 'competitor_price', i.competitor_price) ORDER BY i.pos, i.id)
       FROM logist_request_items i WHERE i.request_id = r.id AND NOT i.removed) AS items_brief,
    (SELECT count(*) FROM logist_request_offers o WHERE o.request_id = r.id AND o.status <> 'withdrawn') AS offers_count,
    CASE WHEN $1 = '' THEN 0 ELSE (
      SELECT count(*) FROM logist_request_messages m
       WHERE m.request_id = r.id AND m.deleted_at IS NULL AND m.author_bitrix_id IS DISTINCT FROM $1
         AND m.id > coalesce((SELECT rd.last_message_id FROM logist_request_reads rd WHERE rd.request_id = r.id AND rd.user_bitrix_id = $1), 0)
    ) END AS unread
  FROM logist_requests r`;

/** Видимость в SQL — та же логика, что canSee() (status.ts). Параметры дописываются в p. */
function visibilitySql(a: LogistActor, p: unknown[]): string {
  if (a.canManage) return 'TRUE';
  p.push(a.login);
  const login = `$${p.length}`;
  const own = [`r.manager_bitrix_id = $1`, `r.created_by_login = ${login}`];
  const other = [`r.logist_bitrix_id = $1`];
  if (a.queueIds.size) { p.push([...a.queueIds]); other.push(`r.queue_id = ANY($${p.length}::int[])`); }
  if (a.zone === 'all') other.push('TRUE');
  else if (a.zone.size) { p.push([...a.zone]); other.push(`r.manager_bitrix_id = ANY($${p.length}::text[])`); }
  return `(${own.join(' OR ')} OR (r.status <> 'draft' AND (${other.join(' OR ')})))`;
}

/** Окно закрытых запросов на доске, если период не задан. */
const CLOSED_WINDOW_DAYS = 45;
const COLUMN_LIMIT_MAX = 500;

export interface BoardOpts { view: BoardView; filters: LogistFilters; limit?: number; now?: Date }

export async function loadBoard(a: LogistActor, o: BoardOpts): Promise<BoardResponse> {
  const now = o.now ?? new Date();
  const f = o.filters;
  const [settings, queues] = await Promise.all([loadSettings(), loadQueues()]);
  const ctx: CardCtx = { queues: queueMap(queues), settings, now };
  const p: unknown[] = [a.bitrixId ?? ''];
  const where = [visibilitySql(a, p)];
  if (o.view === 'deals') where.push(`r.deal_outcome IS NOT NULL`);
  else {
    p.push(f.createdFrom ?? null);
    where.push(`(r.status IN ('draft','new','in_work','answered') OR r.last_event_at > now() - interval '${CLOSED_WINDOW_DAYS} days'
                 OR ($${p.length}::date IS NOT NULL AND r.created_at >= $${p.length}::date - interval '1 day'))`);
  }
  if (f.createdFrom) { p.push(f.createdFrom); where.push(`r.created_at >= $${p.length}::date - interval '1 day'`); }
  if (f.createdTo) { p.push(f.createdTo); where.push(`r.created_at < $${p.length}::date + interval '2 days'`); }
  const r = await db().query<RequestRow>(`${CARD_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 20000`, p);
  const all = r.rows.map(row => toCard(row, ctx));
  const me = a.bitrixId;
  // черновики — только свои (админ видит чужие черновики в карточке, но не на доске)
  const creator = new Map(r.rows.map(x => [Number(x.id), x.created_by_login]));
  const drafts = all.filter(c => c.status === 'draft' && ((!!me && c.manager.bitrixId === me) || creator.get(c.id) === a.login));
  const matched = all.filter(c => c.status !== 'draft' && matchFilters(c, f, me));
  const limit = Math.min(Math.max(o.limit ?? 100, 1), COLUMN_LIMIT_MAX);
  const cmp = sortComparator(f.sort);
  const columns = BOARD_COLUMNS[o.view].map(col => {
    const cards = matched.filter(c => columnOf(c, o.view) === col.key).sort(cmp);
    return { key: col.key, title: col.title, total: cards.length, cards: cards.slice(0, limit).map(c => (o.view === 'deals' ? { ...c, column: col.key } : c)) };
  });
  // плитки: события запросов, прошедших фильтры (без учёта статуса — плитки про поток)
  const period = f.createdFrom || f.createdTo ? { from: f.createdFrom ?? '2000-01-01', to: f.createdTo ?? defaultPeriod(now).to } : defaultPeriod(now);
  const tileCards = all.filter(c => c.status !== 'draft' && matchFilters(c, { ...f, statuses: undefined, createdFrom: undefined, createdTo: undefined }, me));
  const evs = tileCards.length ? await db().query<{ request_id: string; at: Date; kind: string; actor_bitrix_id: string | null; actor_name: string | null }>(
    `SELECT request_id, at, kind, actor_bitrix_id, actor_name FROM logist_request_events
      WHERE request_id = ANY($1::bigint[]) AND kind IN ('sent','taken','reassigned','answered','returned','accepted') ORDER BY id`,
    [tileCards.map(c => c.id)]) : { rows: [] };
  const byReq = new Map<number, { at: string; kind: string; actor: PersonRef | null }[]>();
  for (const e of evs.rows) {
    const k = Number(e.request_id);
    let list = byReq.get(k);
    if (!list) byReq.set(k, list = []);
    list.push({ at: new Date(e.at).toISOString(), kind: e.kind, actor: e.actor_bitrix_id ? { bitrixId: e.actor_bitrix_id, name: e.actor_name } : null });
  }
  const tiles = computeTiles(tileCards.map(card => ({ card, events: byReq.get(card.id) ?? [] })), period.from, period.to);
  // варианты фильтров
  const people = (pick: (c: RequestCard) => PersonRef | null) => {
    const m = new Map<string, PersonRef>();
    for (const c of all) { const x = pick(c); if (x) m.set(x.bitrixId, x); }
    return [...m.values()].sort((x, y) => (x.name ?? '').localeCompare(y.name ?? '', 'ru'));
  };
  const strs = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((x, y) => x.localeCompare(y, 'ru'));
  const qRefs: QueueRef[] = queues.filter(q => q.active).map(q => ({ id: q.id, groupId: q.groupId, name: q.name, region: q.region, dept: q.dept }));
  return {
    view: o.view, columns, drafts: drafts.sort((x, y) => y.id - x.id), tiles,
    options: {
      queues: qRefs,
      regions: strs([...queues.map(q => q.region), ...all.map(c => c.region)]),
      depts: strs([...queues.map(q => q.dept), ...all.map(c => c.dept)]),
      productGroups: strs([...queues.flatMap(q => q.productGroups), ...all.flatMap(c => c.productGroups)]),
      managers: people(c => c.manager), logists: people(c => c.logist),
    },
    me: a.info, filters: f,
    ...(columns.some(c => c.total > limit) ? { notice: `В колонках показано до ${limit} карточек — уточните фильтры` } : {}),
  };
}

async function loadRow(q: Q, id: number, me: string | null, lock = false): Promise<RequestRow | null> {
  const r = lock
    ? await q.query<RequestRow>(`SELECT r.* FROM logist_requests r WHERE r.id = $1 FOR UPDATE`, [id])
    : await q.query<RequestRow>(`${CARD_SELECT} WHERE r.id = $2`, [me ?? '', id]);
  return r.rows[0] ?? null;
}

/** Полная карточка. markRead — отметить чат прочитанным текущим пользователем. */
/** afterAction — карточка сразу после действия, которое actor уже имел право сделать: после «передать в другую
 *  очередь» логист перестаёт видеть запрос, но ответ на своё действие получить должен. */
export async function loadDetails(a: LogistActor, id: number, opts: { markRead?: boolean; now?: Date; q?: Q; afterAction?: boolean } = {}): Promise<RequestDetails> {
  const q = opts.q ?? db();
  const now = opts.now ?? new Date();
  const row = await loadRow(q, id, a.bitrixId);
  if (!row) throw new LogistError('Запрос не найден', 404, 'not_found');
  const people = peopleOf(row);
  if (!opts.afterAction && !canSee(a, people)) throw new LogistError('Нет доступа к этому запросу', 403, 'forbidden');
  const [settings, queues, items, offers, lines, messages, events, files, watchers] = await Promise.all([
    loadSettings(q), loadQueues(),
    q.query<ItemRow>(`SELECT * FROM logist_request_items WHERE request_id = $1 AND NOT removed ORDER BY pos, id`, [id]),
    q.query<OfferRow>(`SELECT * FROM logist_request_offers WHERE request_id = $1 ORDER BY n`, [id]),
    q.query<OfferLineRow>(`SELECT l.* FROM logist_request_offer_lines l JOIN logist_request_offers o ON o.id = l.offer_id WHERE o.request_id = $1 ORDER BY l.offer_id, l.pos, l.id`, [id]),
    q.query<MessageRow>(`SELECT * FROM logist_request_messages WHERE request_id = $1 ORDER BY id`, [id]),
    q.query<EventRow>(`SELECT * FROM logist_request_events WHERE request_id = $1 ORDER BY id`, [id]),
    q.query<FileRow>(`SELECT * FROM logist_request_files WHERE request_id = $1 ORDER BY id`, [id]),
    q.query<{ user_bitrix_id: string; user_name: string | null }>(`SELECT user_bitrix_id, user_name FROM logist_request_watchers WHERE request_id = $1 ORDER BY added_at`, [id]),
  ]);
  const card = toCard(row, { queues: queueMap(queues), settings, now });
  const filesOf = (kind: string, ownerId: unknown) => files.rows.filter(f => f.owner_kind === kind && String(f.owner_id) === String(ownerId)).map(toFile);
  const evs = events.rows.map(toEvent);
  const detail: RequestDetails = {
    ...card,
    purpose: row.purpose, paymentForm: row.payment_form, comment: row.comment, competitorName: row.competitor_name,
    acceptedOfferId: toNum(row.accepted_offer_id), cancelReason: row.cancel_reason,
    items: items.rows.map(i => toItem(i, filesOf('item', i.id))),
    offers: offers.rows.map(o => toOffer(o, lines.rows.filter(l => String(l.offer_id) === String(o.id)).map(toOfferLine), filesOf('offer', o.id))),
    messages: messages.rows.map(m => toMessage(m, filesOf('message', m.id))),
    events: evs,
    watchers: watchers.rows.map(w => ({ bitrixId: w.user_bitrix_id, name: w.user_name })),
    files: filesOf('request', id),
    cycles: buildCycles(evs.map(e => ({ at: e.at, kind: e.kind, actor: e.actor }))),
    dealRowsStatus: dealRowsOf(row.deal_rows_status), dealRowsError: row.deal_rows_error,
    bxSyncError: row.bx_sync_error,
    can: allowedActions(a, people),
    roles: rolesOf(a, people),
  };
  if (opts.markRead && a.bitrixId) {
    const lastMsg = messages.rows.length ? Number(messages.rows[messages.rows.length - 1]!.id) : 0;
    const lastEv = events.rows.length ? Number(events.rows[events.rows.length - 1]!.id) : 0;
    await q.query(
      `INSERT INTO logist_request_reads (request_id, user_bitrix_id, last_message_id, last_event_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (request_id, user_bitrix_id) DO UPDATE SET last_message_id = GREATEST(logist_request_reads.last_message_id, EXCLUDED.last_message_id),
         last_event_id = GREATEST(logist_request_reads.last_event_id, EXCLUDED.last_event_id), read_at = now()`,
      [id, a.bitrixId, lastMsg, lastEv]).catch(e => console.warn('[logist-requests] reads', e instanceof Error ? e.message : e));
    detail.unread = 0;
  }
  return detail;
}

/** Запросы по сделке (для кнопки «Запрос логисту» / формы). */
export async function loadDealRequests(a: LogistActor, dealId: number): Promise<{ requests: RequestCard[]; openByType: Partial<Record<RequestType, number>> }> {
  const [settings, queues] = await Promise.all([loadSettings(), loadQueues()]);
  const p: unknown[] = [a.bitrixId ?? '', dealId];
  const r = await db().query<RequestRow>(`${CARD_SELECT} WHERE r.deal_id = $2 AND ${visibilitySql(a, p)} ORDER BY r.id DESC`, p);
  const cards = r.rows.map(x => toCard(x, { queues: queueMap(queues), settings, now: new Date() }));
  const openByType: Partial<Record<RequestType, number>> = {};
  for (const c of cards) if (['draft', 'new', 'in_work', 'answered'].includes(c.status) && !openByType[c.type]) openByType[c.type] = c.id;
  return { requests: cards, openByType };
}

// ── запись ──────────────────────────────────────────────────────────────────────────────

interface Ev { kind: EventKind; from?: RequestStatus | null; to?: RequestStatus | null; data?: Record<string, unknown> }

async function addEvents(q: Q, row: { id: number; cycle: number; queueId: number | null }, a: LogistActor, evs: Ev[]): Promise<number[]> {
  const ids: number[] = [];
  for (const e of evs) {
    const r = await q.query<{ id: string }>(
      `INSERT INTO logist_request_events (request_id, kind, cycle, from_status, to_status, queue_id, actor_bitrix_id, actor_login, actor_name, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [row.id, e.kind, row.cycle, e.from ?? null, e.to ?? null, row.queueId, a.bitrixId, a.login, a.name, JSON.stringify(e.data ?? {})]);
    ids.push(Number(r.rows[0]!.id));
  }
  return ids;
}

async function insertItems(q: Q, requestId: number, items: ItemInput[], cycle: number, startPos: number): Promise<number[]> {
  const ids: number[] = [];
  let pos = startPos;
  for (const it of items) {
    const r = await q.query<{ id: string }>(
      `INSERT INTO logist_request_items (request_id, pos, kind, bx_row_id, bx_product_id, name, quantity, measure, our_price, product_group,
                                         competitor_price, comment, added_in_cycle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [requestId, pos++, it.kind ?? 'free', it.bxRowId ?? null, it.bxProductId ?? null, it.name, it.quantity ?? null, it.measure ?? null,
        it.ourPrice ?? null, it.productGroup ?? null, it.competitorPrice ?? null, it.comment ?? null, cycle]);
    const id = Number(r.rows[0]!.id);
    ids.push(id);
    if (it.fileIds?.length) await attachFiles(q, requestId, 'item', id, it.fileIds);
  }
  return ids;
}

/** Привязать ранее загруженные файлы (request_id IS NULL или этот же запрос) к владельцу. */
async function attachFiles(q: Q, requestId: number, kind: 'request' | 'item' | 'offer' | 'message', ownerId: number, fileIds: number[]): Promise<void> {
  if (!fileIds.length) return;
  await q.query(
    `UPDATE logist_request_files SET request_id = $1, owner_kind = $2, owner_id = $3
      WHERE id = ANY($4::bigint[]) AND (request_id IS NULL OR request_id = $1)`, [requestId, kind, ownerId, fileIds]);
}

/** Полная замена позиций черновика: id — правка, без id — новая, отсутствующие — удаляются. */
async function replaceDraftItems(q: Q, requestId: number, items: ItemInput[]): Promise<void> {
  const keep = items.filter(i => i.id).map(i => i.id!);
  await q.query(`DELETE FROM logist_request_items WHERE request_id = $1 AND NOT (id = ANY($2::bigint[]))`, [requestId, keep]);
  let pos = 0;
  for (const it of items) {
    if (it.id) {
      const r = await q.query(
        `UPDATE logist_request_items SET pos=$3, kind=$4, bx_row_id=$5, bx_product_id=$6, name=$7, quantity=$8, measure=$9, our_price=$10,
                product_group=$11, competitor_price=$12, comment=$13 WHERE id=$2 AND request_id=$1`,
        [requestId, it.id, pos++, it.kind ?? 'free', it.bxRowId ?? null, it.bxProductId ?? null, it.name, it.quantity ?? null, it.measure ?? null,
          it.ourPrice ?? null, it.productGroup ?? null, it.competitorPrice ?? null, it.comment ?? null]);
      if (!r.rowCount) throw new LogistError(`Позиция ${it.id} не принадлежит запросу`, 400, 'invalid');
      if (it.fileIds?.length) await attachFiles(q, requestId, 'item', it.id, it.fileIds);
    } else {
      await insertItems(q, requestId, [it], 0, pos++);
    }
  }
}

const HEADER_COLS: Record<keyof DraftHeaderInput, string> = {
  type: 'type', queueId: 'queue_id', address: 'address', purpose: 'purpose', paymentForm: 'payment_form',
  deliveryDate: 'delivery_date', comment: 'comment', competitorName: 'competitor_name', competitorTotal: 'competitor_total',
};
async function updateHeader(q: Q, id: number, h: DraftHeaderInput): Promise<void> {
  const sets: string[] = [], p: unknown[] = [id];
  for (const k of Object.keys(h) as (keyof DraftHeaderInput)[]) {
    if (h[k] === undefined) continue;
    p.push(h[k]);
    sets.push(`${HEADER_COLS[k]} = $${p.length}`);
  }
  if (sets.length) await q.query(`UPDATE logist_requests SET ${sets.join(', ')} WHERE id = $1`, p);
}

async function checkQueue(q: Q, queueId: number): Promise<void> {
  const r = await q.query(`SELECT 1 FROM logist_queues WHERE id = $1 AND active`, [queueId]);
  if (!r.rowCount) throw new LogistError('Очередь не найдена или выключена', 400, 'invalid');
}

async function tx<T>(fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function runHook(ctx: LogistHookCtx): Promise<void> {
  try { await afterLogistChange(ctx); } catch (e) { console.error('[logist-requests] hook', ctx.action, e instanceof Error ? e.message : e); }
}

export interface DraftSeed {
  type: RequestType; source: 'robot' | 'button';
  manager: PersonRef; managerRegion: string | null; createdByLogin: string | null;
  deal: { id: number; title: string | null; amount: number | null; categoryId: number | null; stageId: string | null; clientRef: string | null; clientName: string | null; address: string | null } | null;
  header: DraftHeaderInput; items: ItemInput[]; productGroups: string[];
  /** сразу отправить, без черновика (проверки как у send; не прошли — ничего не создаётся) */
  sendNow?: boolean;
}

/** Создать черновик (или сразу отправленный запрос, sendNow). source='robot' — при открытом запросе того же типа
 *  по сделке возвращает его (created=false). */
export async function createDraft(a: LogistActor, s: DraftSeed): Promise<{ request: RequestDetails; created: boolean }> {
  const queues = await loadQueues({ activeOnly: true });
  const auto = s.header.queueId === undefined ? pickDefaultQueue(queues, s.managerRegion, s.productGroups) : null;
  const res = await tx(async q => {
    if (s.deal) {
      // один черновик на (сделка, тип) от робота — защита от двойного срабатывания
      await q.query(`SELECT pg_advisory_xact_lock(hashtext('logist_request_deal'), $1::int)`, [s.deal.id % 2_000_000_000]);
      if (s.source === 'robot') {
        const open = await q.query<{ id: string }>(
          `SELECT id FROM logist_requests WHERE deal_id = $1 AND type = $2 AND status IN ('draft','new','in_work','answered') ORDER BY id DESC LIMIT 1`,
          [s.deal.id, s.type]);
        if (open.rows[0]) return { id: Number(open.rows[0].id), created: false, eventIds: [] as number[] };
      }
    }
    const queueId = s.header.queueId ?? auto?.id ?? null;
    if (queueId) await checkQueue(q, queueId);
    if (s.sendNow) {
      const problems = sendProblems({ type: s.header.type ?? s.type, queueId, competitorTotal: s.header.competitorTotal ?? null,
        items: s.items.map(i => ({ name: i.name, competitorPrice: i.competitorPrice ?? null })) });
      if (problems.length) throw new LogistError(problems.join('; '), 400, 'invalid');
    }
    const r = await q.query<{ id: string }>(
      `INSERT INTO logist_requests (type, status, source, deal_id, deal_title, deal_category_id, deal_stage_id, deal_amount, client_ref, client_name,
                                    manager_bitrix_id, manager_name, manager_region, created_by_login, queue_id, address)
       VALUES ($1,'draft',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [s.type, s.source, s.deal?.id ?? null, s.deal?.title ?? null, s.deal?.categoryId ?? null, s.deal?.stageId ?? null, s.deal?.amount ?? null,
        s.deal?.clientRef ?? null, s.deal?.clientName ?? null, s.manager.bitrixId, s.manager.name, s.managerRegion, s.createdByLogin, queueId,
        s.deal?.address ?? null]);
    const id = Number(r.rows[0]!.id);
    const { queueId: _q, ...rest } = s.header;
    void _q;
    await updateHeader(q, id, rest);
    await insertItems(q, id, s.items, 0, 0);
    const eventIds = await addEvents(q, { id, cycle: 0, queueId }, a, [{ kind: 'created', to: 'draft', data: { source: s.source, dealId: s.deal?.id ?? null, autoQueue: auto?.id ?? null } }]);
    if (s.sendNow) {
      await q.query(`UPDATE logist_requests SET status = 'new', cycle = 1, sent_at = now(), cycle_started_at = now(), last_event_at = now(),
                            version = version + 1 WHERE id = $1`, [id]);
      eventIds.push(...await addEvents(q, { id, cycle: 1, queueId }, a, [{ kind: 'sent', from: 'draft', to: 'new', data: { direct: true } }]));
    }
    return { id, created: true, eventIds };
  });
  const request = await loadDetails(a, res.id, { afterAction: true });
  // сразу отправленный — хук как у send (S4 создаёт дубль-задачу по send)
  if (res.created) await runHook({ action: s.sendNow ? 'send' : 'create', request, actor: a, eventIds: res.eventIds });
  return { request, created: res.created };
}

/** Одно действие над запросом. */
export async function applyAction(a: LogistActor, id: number, body: ActionBody): Promise<RequestDetails & { dealRows?: { status: string; error?: string | null } }> {
  let acceptedOfferId: number | null = null;
  const res = await tx(async q => {
    const row = await loadRow(q, id, a.bitrixId, true);
    if (!row) throw new LogistError('Запрос не найден', 404, 'not_found');
    if (body.version !== undefined && body.version !== Number(row.version)) {
      throw new LogistError('Запрос уже изменили — обновите карточку', 409, 'conflict');
    }
    const people = peopleOf(row);
    if (!canSee(a, people)) throw new LogistError('Нет доступа к этому запросу', 403, 'forbidden');
    const d = canDo(a, people, body.action);
    if (!d.ok) throw new LogistError(d.reason ?? 'Нельзя', d.code === 'transition' ? 409 : 403, d.code ?? 'forbidden');
    const from = row.status as RequestStatus;
    const next = NEXT_STATUS[body.action](from);
    let cycle = Number(row.cycle);
    let queueId = toNum(row.queue_id);
    const sets: string[] = [];
    const p: unknown[] = [id];
    const set = (col: string, v: unknown) => { p.push(v); sets.push(`${col} = $${p.length}`); };
    const evs: Ev[] = [];
    const tr = (kind: EventKind, data: Record<string, unknown> = {}) => evs.push({ kind, from, to: next ?? from, data });

    switch (body.action) {
      case 'update_draft': {
        if (body.header?.queueId) await checkQueue(q, body.header.queueId);
        if (body.header) await updateHeader(q, id, body.header);
        if (body.items) await replaceDraftItems(q, id, body.items);
        tr('draft_updated');
        break;
      }
      case 'send': {
        const items = await q.query<{ name: string; competitor_price: string | null }>(
          `SELECT name, competitor_price FROM logist_request_items WHERE request_id = $1 AND NOT removed`, [id]);
        const problems = sendProblems({
          type: row.type as RequestType, queueId, competitorTotal: toNum(row.competitor_total),
          items: items.rows.map(i => ({ name: i.name, competitorPrice: toNum(i.competitor_price) })),
        });
        if (problems.length) throw new LogistError(problems.join('; '), 400, 'invalid');
        cycle = 1;
        set('cycle', 1); set('sent_at', new Date()); set('cycle_started_at', new Date());
        tr('sent');
        break;
      }
      case 'take':
        set('logist_bitrix_id', a.bitrixId); set('logist_name', a.name); set('taken_at', new Date());
        tr('taken');
        break;
      case 'release':
        set('logist_bitrix_id', null); set('logist_name', null); set('taken_at', null);
        tr('released', { comment: body.comment ?? null });
        break;
      case 'transfer': {
        if (body.queueId === queueId) throw new LogistError('Запрос уже в этой очереди', 400, 'invalid');
        await checkQueue(q, body.queueId);
        const fromQueue = queueId;
        queueId = body.queueId;
        set('queue_id', queueId); set('logist_bitrix_id', null); set('logist_name', null); set('taken_at', null);
        tr('transferred', { fromQueueId: fromQueue, toQueueId: queueId, comment: body.comment ?? null });
        break;
      }
      case 'reassign': {
        const prev = row.logist_bitrix_id ? { bitrixId: row.logist_bitrix_id, name: row.logist_name } : null;
        set('logist_bitrix_id', body.logistBitrixId); set('logist_name', body.logistName ?? null);
        if (from === 'new') set('taken_at', new Date());
        tr('reassigned', { from: prev, to: { bitrixId: body.logistBitrixId, name: body.logistName ?? null }, comment: body.comment ?? null });
        break;
      }
      case 'answer': {
        const offerId = await insertOffer(q, id, cycle, a, body.offer);
        if (!row.logist_bitrix_id) {
          // ответ сразу из «Новых»: отвечающий становится держателем (взятие = ответ, как skip_take у задач)
          set('logist_bitrix_id', a.bitrixId); set('logist_name', a.name);
        }
        set('answered_at', new Date());
        const n = await q.query<{ n: number }>(`SELECT n FROM logist_request_offers WHERE id = $1`, [offerId]);
        tr('answered', { offerId, n: n.rows[0]?.n ?? null, firstInCycle: from !== 'answered' });
        break;
      }
      case 'withdraw_offer': {
        const r = await q.query(`UPDATE logist_request_offers SET status = 'withdrawn' WHERE id = $1 AND request_id = $2 AND status = 'active'`, [body.offerId, id]);
        if (!r.rowCount) throw new LogistError('Вариант не найден или уже отозван', 400, 'invalid');
        tr('offer_withdrawn', { offerId: body.offerId });
        break;
      }
      case 'return':
        cycle += 1;
        set('cycle', cycle); set('returns_count', Number(row.returns_count) + 1); set('cycle_started_at', new Date());
        if (!row.logist_bitrix_id) { set('taken_at', null); }
        // нет держателя (например, отпустили до ответа) — возврат в «Новые», иначе — к тому же логисту
        evs.push({ kind: 'returned', from, to: row.logist_bitrix_id ? 'in_work' : 'new', data: { comment: body.comment } });
        break;
      case 'accept': {
        const r = await q.query(`UPDATE logist_request_offers SET status = 'accepted' WHERE id = $1 AND request_id = $2 AND status = 'active'`, [body.offerId, id]);
        if (!r.rowCount) throw new LogistError('Вариант не найден или отозван', 400, 'invalid');
        acceptedOfferId = body.offerId;
        set('accepted_at', new Date()); set('accepted_offer_id', body.offerId); set('deal_rows_status', 'pending');
        tr('accepted', { offerId: body.offerId });
        break;
      }
      case 'cancel':
        set('cancelled_at', new Date()); set('cancel_reason', body.reason ?? null);
        tr('cancelled', { reason: body.reason ?? null });
        break;
      case 'add_items': {
        const max = await q.query<{ m: number | null }>(`SELECT max(pos) AS m FROM logist_request_items WHERE request_id = $1`, [id]);
        const itemIds = await insertItems(q, id, body.items, cycle, (max.rows[0]?.m ?? -1) + 1);
        tr('items_added', { itemIds });
        break;
      }
    }
    // статус: у возврата без держателя — «Новые»
    const to = body.action === 'return' && !row.logist_bitrix_id ? 'new' : next;
    if (to && to !== from) set('status', to);
    set('last_event_at', new Date());
    sets.push('version = version + 1', 'updated_at = now()');
    await q.query(`UPDATE logist_requests SET ${sets.join(', ')} WHERE id = $1`, p);
    const eventIds = await addEvents(q, { id, cycle, queueId }, a, evs);
    return { eventIds };
  });

  let details = await loadDetails(a, id, { afterAction: true });
  let dealRows: { status: string; error?: string | null } | undefined;
  if (acceptedOfferId !== null) {
    const offer = details.offers.find(o => o.id === acceptedOfferId)!;
    try {
      const w = await writeDealRowsForAcceptedOffer({ request: details, offer, actor: a });
      dealRows = w;
      await db().query(`UPDATE logist_requests SET deal_rows_status = $2, deal_rows_error = $3, deal_rows_written_at = CASE WHEN $2 = 'ok' THEN now() END WHERE id = $1`,
        [id, w.status, w.error ?? null]);
    } catch (e) {
      dealRows = { status: 'error', error: e instanceof Error ? e.message : String(e) };
      await db().query(`UPDATE logist_requests SET deal_rows_status = 'error', deal_rows_error = $2 WHERE id = $1`, [id, dealRows.error]);
    }
    await addEvents(db(), { id, cycle: details.cycle, queueId: details.queue?.id ?? null }, a, [{ kind: 'deal_rows', data: dealRows }]);
    details = await loadDetails(a, id, { afterAction: true });
  }
  await runHook({ action: body.action, request: details, actor: a, eventIds: res.eventIds });
  return dealRows ? { ...details, dealRows } : details;
}

async function insertOffer(q: Q, requestId: number, cycle: number, a: LogistActor, o: OfferInput): Promise<number> {
  if (o.lines.some(l => l.itemId)) {
    const ids = o.lines.map(l => l.itemId).filter((x): x is number => !!x);
    const r = await q.query(`SELECT count(*)::int AS c FROM logist_request_items WHERE request_id = $1 AND id = ANY($2::bigint[])`, [requestId, ids]);
    if ((r.rows[0] as { c: number }).c !== new Set(ids).size) throw new LogistError('Строка варианта ссылается на чужую позицию', 400, 'invalid');
  }
  const t = offerTotals(o);
  const n = await q.query<{ n: number }>(`SELECT coalesce(max(n), 0) + 1 AS n FROM logist_request_offers WHERE request_id = $1`, [requestId]);
  const r = await q.query<{ id: string }>(
    `INSERT INTO logist_request_offers (request_id, n, cycle, author_bitrix_id, author_name, supplier, payment_form, lead_time, ready_date,
                                        delivery_trucks, delivery_price, goods_total, delivery_total, total, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [requestId, n.rows[0]!.n, cycle, a.bitrixId, a.name, o.supplier ?? null, o.paymentForm ?? null, o.leadTime ?? null, o.readyDate ?? null,
      o.deliveryTrucks ?? null, o.deliveryPrice ?? null, t.goodsTotal, t.deliveryTotal, t.total, o.comment ?? null]);
  const offerId = Number(r.rows[0]!.id);
  let pos = 0;
  for (const [i, l] of o.lines.entries()) {
    await q.query(
      `INSERT INTO logist_request_offer_lines (offer_id, item_id, pos, availability, name, bx_product_id, quantity, measure, price, line_sum, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [offerId, l.itemId ?? null, pos++, l.availability ?? 'ok', l.name, l.bxProductId ?? null, l.quantity ?? null, l.measure ?? null, l.price ?? null, t.lineSums[i], l.comment ?? null]);
  }
  if (o.fileIds?.length) await attachFiles(q, requestId, 'offer', offerId, o.fileIds);
  return offerId;
}

// ── чат ─────────────────────────────────────────────────────────────────────────────────

export async function listMessages(a: LogistActor, id: number, after: number): Promise<MessagesResponse> {
  const row = await loadRow(db(), id, a.bitrixId);
  if (!row) throw new LogistError('Запрос не найден', 404, 'not_found');
  if (!canSee(a, peopleOf(row))) throw new LogistError('Нет доступа к этому запросу', 403, 'forbidden');
  const [m, e, f] = await Promise.all([
    db().query<MessageRow>(`SELECT * FROM logist_request_messages WHERE request_id = $1 AND id > $2 ORDER BY id LIMIT 500`, [id, after]),
    db().query<EventRow>(`SELECT * FROM logist_request_events WHERE request_id = $1 ORDER BY id`, [id]),
    db().query<FileRow>(`SELECT * FROM logist_request_files WHERE request_id = $1 AND owner_kind = 'message'`, [id]),
  ]);
  return {
    messages: m.rows.map(x => toMessage(x, f.rows.filter(ff => String(ff.owner_id) === String(x.id)).map(toFile))),
    events: e.rows.map(toEvent),
  };
}

export async function postMessage(a: LogistActor, id: number, body: string, fileIds: number[]): Promise<{ message: ReturnType<typeof toMessage> }> {
  const res = await tx(async q => {
    const row = await loadRow(q, id, a.bitrixId, true);
    if (!row) throw new LogistError('Запрос не найден', 404, 'not_found');
    if (!canSee(a, peopleOf(row))) throw new LogistError('Нет доступа к этому запросу', 403, 'forbidden');
    const r = await q.query<MessageRow>(
      `INSERT INTO logist_request_messages (request_id, author_bitrix_id, author_login, author_name, body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, a.bitrixId, a.login, a.name, body]);
    const msg = r.rows[0]!;
    await attachFiles(q, id, 'message', Number(msg.id), fileIds);
    await q.query(`UPDATE logist_requests SET updated_at = now() WHERE id = $1`, [id]);
    const eventIds = await addEvents(q, { id, cycle: Number(row.cycle), queueId: toNum(row.queue_id) }, a, [{ kind: 'message', data: { messageId: Number(msg.id) } }]);
    if (a.bitrixId) {
      await q.query(
        `INSERT INTO logist_request_reads (request_id, user_bitrix_id, last_message_id) VALUES ($1,$2,$3)
         ON CONFLICT (request_id, user_bitrix_id) DO UPDATE SET last_message_id = GREATEST(logist_request_reads.last_message_id, EXCLUDED.last_message_id), read_at = now()`,
        [id, a.bitrixId, Number(msg.id)]);
    }
    const files = await q.query<FileRow>(`SELECT * FROM logist_request_files WHERE request_id = $1 AND owner_kind = 'message' AND owner_id = $2`, [id, msg.id]);
    return { msg, files: files.rows.map(toFile), eventIds };
  });
  const message = toMessage(res.msg, res.files);
  // хук — с полной карточкой (S4: комментарий в задачу, S5: уведомление)
  const request = await loadDetails(a, id, { afterAction: true }).catch(() => null);
  if (request) await runHook({ action: 'message', request, actor: a, eventIds: res.eventIds, messageId: message.id });
  return { message };
}

// ── исход сделки (sa.deals → deal_outcome) ─────────────────────────────────────────────

/** Подтягивает исход сделки для запросов без исхода за последние days дней: sold_at → sold, lost_at без sold_at → lost.
 *  Пишет событие outcome (от системы). Вызов — фоновая задача (пока не подключена: открытый пункт S1 в спеке). */
export async function syncDealOutcomes(days = 120): Promise<{ checked: number; updated: number }> {
  const open = await db().query<{ id: string; deal_id: string; cycle: number; queue_id: number | null }>(
    `SELECT id, deal_id, cycle, queue_id FROM logist_requests
      WHERE deal_id IS NOT NULL AND deal_outcome IS NULL AND status <> 'draft' AND created_at > now() - make_interval(days => $1)`, [days]);
  if (!open.rows.length) return { checked: 0, updated: 0 };
  const dealIds = [...new Set(open.rows.map(r => Number(r.deal_id)))];
  const d = await analyticsDb().query<{ deal_id: string; sold_at: Date | null; lost_at: Date | null }>(
    `SELECT deal_id::text AS deal_id, sold_at, lost_at FROM sa.deals WHERE deal_id = ANY($1::bigint[]) AND (sold_at IS NOT NULL OR lost_at IS NOT NULL)`, [dealIds]);
  const byDeal = new Map(d.rows.map(r => [Number(r.deal_id), r]));
  const system = { bitrixId: null, login: 'system', name: 'Система' } as unknown as LogistActor;
  let updated = 0;
  for (const r of open.rows) {
    const x = byDeal.get(Number(r.deal_id));
    if (!x) continue;
    const outcome = x.sold_at ? 'sold' : 'lost';
    const at = x.sold_at ?? x.lost_at;
    const u = await db().query(`UPDATE logist_requests SET deal_outcome = $2, deal_outcome_at = $3 WHERE id = $1 AND deal_outcome IS NULL`, [r.id, outcome, at]);
    if (u.rowCount) {
      updated++;
      await addEvents(db(), { id: Number(r.id), cycle: r.cycle, queueId: r.queue_id }, system, [{ kind: 'outcome', data: { outcome, at } }]);
    }
  }
  return { checked: open.rows.length, updated };
}

/** Для статистики: запросы «на логисте» — то, где идёт SLA. */
export const isLogistTurn = (s: RequestStatus) => LOGIST_TURN.includes(s);

export { InputError };
