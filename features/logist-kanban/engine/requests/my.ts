// S5: «Мои запросы» менеджера в ЛК и аналитика руководителей (LOGIST_REQUESTS_SPEC.md, «Плитки и аналитика»).
// Только чтение system DB; карточки — тем же toCard, что доска (SLA/огонёк/непрочитанное одинаковые).
import { systemDb } from '@/lib/db/clients';
import type {
  AnalyticsLevel, AnalyticsResponse, AnalyticsRow, LogistFilters, MyAttention, MyRequestsResponse, PersonRef, QueueRef, RequestCard, Tiles,
} from './contract';
import type { LogistActor } from './actor';
import { matchFilters } from './filters';
import type { RequestRow } from './mapper';
import { toCard } from './mapper';
import { loadQueues } from './queues';
import { CARD_SELECT, LogistError, loadSettings, queueMap } from './repo';
import { computeTiles, defaultPeriod, type TileRow } from './tiles';
import type { CycleEvent } from './cycles';

// ── «Мои запросы» ─────────────────────────────────────────────────────────────────────

export function attentionOf(c: Pick<RequestCard, 'status' | 'unread'>): MyAttention {
  if (c.status === 'draft') return 'draft';
  if (c.status === 'answered') return 'answered';
  if (c.unread > 0 && c.status !== 'cancelled') return 'chat';
  return null;
}

/** Порядок «Ждут меня»: ответ пришёл → вопрос в чате → черновик; внутри — свежие сверху. */
const ATTN_RANK: Record<NonNullable<MyAttention>, number> = { answered: 0, chat: 1, draft: 2 };

export async function loadMyRequests(a: LogistActor, opts: { days?: number; now?: Date } = {}): Promise<MyRequestsResponse> {
  const now = opts.now ?? new Date();
  const days = Math.min(Math.max(Math.round(opts.days ?? 90), 1), 730);
  const [settings, queues] = await Promise.all([loadSettings(), loadQueues()]);
  const r = await systemDb().query<RequestRow>(
    `${CARD_SELECT}
      WHERE (r.manager_bitrix_id = $1 OR r.created_by_login = $2)
        AND (r.status IN ('draft','new','in_work','answered') OR r.last_event_at > now() - make_interval(days => $3))
      ORDER BY r.id DESC LIMIT 1000`,
    [a.bitrixId ?? '', a.login, days]);
  const ctx = { queues: queueMap(queues), settings, now };
  const cards = r.rows.map(row => { const c = toCard(row, ctx); return { ...c, attention: attentionOf(c) }; });
  cards.sort((x, y) => {
    const ax = x.attention ? ATTN_RANK[x.attention] : 9, ay = y.attention ? ATTN_RANK[y.attention] : 9;
    return ax - ay || y.lastEventAt.localeCompare(x.lastEventAt);
  });
  const counts = { attention: 0, waiting: 0, draft: 0, closed: 0 };
  for (const c of cards) {
    if (c.attention === 'draft') counts.draft++;
    if (c.attention === 'answered' || c.attention === 'chat') counts.attention++;
    else if (c.status === 'new' || c.status === 'in_work') counts.waiting++;
    if (c.status === 'accepted' || c.status === 'cancelled') counts.closed++;
  }
  const qRefs: QueueRef[] = queues.filter(q => q.active).map(q => ({ id: q.id, groupId: q.groupId, name: q.name, region: q.region, dept: q.dept }));
  return { me: a.info, cards, counts, queues: qRefs, canAnalytics: canSeeAnalytics(a) };
}

/** Счётчик для пункта меню ЛК: сколько запросов ждут менеджера (ответ пришёл / вопрос в чате). Дёшево — без карточек. */
export async function countMyAttention(a: LogistActor): Promise<number> {
  if (!a.bitrixId && !a.login) return 0;
  const r = await systemDb().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM logist_requests r
      WHERE (r.manager_bitrix_id = $1 OR r.created_by_login = $2)
        AND (r.status = 'answered' OR (r.status IN ('new','in_work','accepted') AND EXISTS (
          SELECT 1 FROM logist_request_messages m
           WHERE m.request_id = r.id AND m.deleted_at IS NULL AND m.author_bitrix_id IS DISTINCT FROM $1
             AND m.id > coalesce((SELECT rd.last_message_id FROM logist_request_reads rd WHERE rd.request_id = r.id AND rd.user_bitrix_id = $1), 0))))`,
    [a.bitrixId ?? '', a.login]);
  return r.rows[0]?.n ?? 0;
}

// ── аналитика руководителей ───────────────────────────────────────────────────────────

/** РОП (есть зона) — свою зону; руководитель логистики / админ — всё. Логистам и менеджерам — нет. */
export const canSeeAnalytics = (a: LogistActor) => a.canManage || a.zone === 'all' || (a.zone instanceof Set && a.zone.size > 0);

const NO_REGION = 'Регион не указан', NO_DEPT = 'Департамент не указан', NO_QUEUE = 'Без очереди', NO_LOGIST = 'Не взят';

/** Разрез регион → департамент → очередь → логист. Чистая функция (тест — assert-logist-requests.ts).
 *  Узел = запросы, текущие поля которых совпадают с путём; логист — текущий держатель запроса. */
export function buildAnalytics(rows: readonly TileRow[], from: string, to: string): { total: AnalyticsRow; rows: AnalyticsRow[] } {
  const groups = new Map<string, { level: AnalyticsLevel; label: string; parentKey: string | null; rows: TileRow[] }>();
  const add = (key: string, level: AnalyticsLevel, label: string, parentKey: string | null, row: TileRow) => {
    let g = groups.get(key);
    if (!g) groups.set(key, g = { level, label, parentKey, rows: [] });
    g.rows.push(row);
  };
  for (const row of rows) {
    const c = row.card;
    const k1 = c.region ?? NO_REGION;
    const k2 = `${k1}|${c.dept ?? NO_DEPT}`;
    const k3 = `${k2}|${c.queue?.id ?? 0}`;
    const k4 = `${k3}|${c.logist?.bitrixId ?? 0}`;
    add(k1, 'region', k1, null, row);
    add(k2, 'dept', c.dept ?? NO_DEPT, k1, row);
    add(k3, 'queue', c.queue?.name ?? NO_QUEUE, k2, row);
    add(k4, 'logist', c.logist?.name ?? (c.logist ? `id ${c.logist.bitrixId}` : NO_LOGIST), k3, row);
  }
  const mk = (key: string, level: AnalyticsLevel, label: string, parentKey: string | null, rs: readonly TileRow[]): AnalyticsRow => ({
    key, level, label, parentKey, tiles: computeTiles(rs, from, to),
    openNow: rs.filter(x => x.card.status === 'new' || x.card.status === 'in_work').length,
    overdueNow: rs.filter(x => x.card.sla.state === 'overdue').length,
  });
  const out = [...groups.entries()].map(([key, g]) => mk(key, g.level, g.label, g.parentKey, g.rows));
  // по убыванию потока (новые + возвраты), внутри уровня; «не указан/не взят» — в конце
  const weight = (t: Tiles) => t.newCount + t.reopenedCount;
  const tail = (r: AnalyticsRow) => [NO_REGION, NO_DEPT, NO_QUEUE, NO_LOGIST].includes(r.label) ? 1 : 0;
  out.sort((x, y) => tail(x) - tail(y) || weight(y.tiles) - weight(x.tiles) || x.label.localeCompare(y.label, 'ru'));
  return { total: mk('', 'region', 'Все', null, rows), rows: out };
}

export async function loadAnalytics(a: LogistActor, f: LogistFilters, opts: { now?: Date } = {}): Promise<AnalyticsResponse> {
  if (!canSeeAnalytics(a)) throw new LogistError('Аналитика — РОПам и руководителю логистики', 403, 'forbidden');
  const now = opts.now ?? new Date();
  const period = f.createdFrom || f.createdTo
    ? { from: f.createdFrom ?? defaultPeriod(now).from, to: f.createdTo ?? defaultPeriod(now).to }
    : defaultPeriod(now);
  const all = a.canManage || a.zone === 'all';
  const [settings, queues] = await Promise.all([loadSettings(), loadQueues()]);
  // Запросы, у которых в периоде что-то было (события) или которые сейчас открыты (снимок «на логисте»).
  const p: unknown[] = ['', period.from, period.to];
  let zoneSql = '';
  if (!all) { p.push([...(a.zone as Set<string>)]); zoneSql = `AND r.manager_bitrix_id = ANY($${p.length}::text[])`; }
  const r = await systemDb().query<RequestRow>(
    `${CARD_SELECT}
      WHERE r.status <> 'draft' ${zoneSql}
        AND (r.status IN ('new','in_work','answered')
             OR EXISTS (SELECT 1 FROM logist_request_events e WHERE e.request_id = r.id
                          AND e.at >= $2::date - interval '1 day' AND e.at < $3::date + interval '2 days'))
      ORDER BY r.id DESC LIMIT 20000`, p);
  const ctx = { queues: queueMap(queues), settings, now };
  const cards = r.rows.map(x => toCard(x, ctx));
  const matched = cards.filter(c => matchFilters(c, { ...f, statuses: undefined, createdFrom: undefined, createdTo: undefined }, a.bitrixId));
  const evs = matched.length ? await systemDb().query<{ request_id: string; at: Date; kind: string; actor_bitrix_id: string | null; actor_name: string | null }>(
    `SELECT request_id, at, kind, actor_bitrix_id, actor_name FROM logist_request_events
      WHERE request_id = ANY($1::bigint[]) AND kind IN ('sent','taken','reassigned','answered','returned','accepted') ORDER BY id`,
    [matched.map(c => c.id)]) : { rows: [] };
  const byReq = new Map<number, CycleEvent[]>();
  for (const e of evs.rows) {
    const k = Number(e.request_id);
    let list = byReq.get(k);
    if (!list) byReq.set(k, list = []);
    list.push({ at: new Date(e.at).toISOString(), kind: e.kind, actor: e.actor_bitrix_id ? { bitrixId: e.actor_bitrix_id, name: e.actor_name } : null });
  }
  const { total, rows } = buildAnalytics(matched.map(card => ({ card, events: byReq.get(card.id) ?? [] })), period.from, period.to);
  const people = (pick: (c: RequestCard) => PersonRef | null) => {
    const m = new Map<string, PersonRef>();
    for (const c of cards) { const x = pick(c); if (x) m.set(x.bitrixId, x); }
    return [...m.values()].sort((x, y) => (x.name ?? '').localeCompare(y.name ?? '', 'ru'));
  };
  const strs = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort((x, y) => x.localeCompare(y, 'ru'));
  return {
    periodFrom: period.from, periodTo: period.to, total, rows, scope: all ? 'all' : 'zone',
    options: {
      queues: queues.filter(q => q.active).map(q => ({ id: q.id, groupId: q.groupId, name: q.name, region: q.region, dept: q.dept })),
      regions: strs([...queues.map(q => q.region), ...cards.map(c => c.region)]),
      depts: strs([...queues.map(q => q.dept), ...cards.map(c => c.dept)]),
      productGroups: strs([...queues.flatMap(q => q.productGroups), ...cards.flatMap(c => c.productGroups)]),
      managers: people(c => c.manager), logists: people(c => c.logist),
    },
    filters: f,
  };
}
