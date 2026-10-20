// Канбан повторных продаж — сборка доски (спецификация: ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md).
//
// Карточка = заказчик. База — пер-менеджерские списки «Моих заказчиков»
// (fetchManagerCustomers, Redis 10 мин): покупки, шанс на повтор, звонки после
// отгрузки. Поверх — свежим запросом то, что должно двигаться сразу:
//   * последняя ПОВТОРНАЯ сделка заказчика (воронки 2/3) со стадией — решает колонку;
//   * звонки по ней (успешные/недозвоны) после начала окна;
//   * ручные контакты, задачи, решения по отказам, отметки «брак» (системная БД);
//   * тип клиента: карточка клиента, иначе поле Битрикса (clientTypes.ts).
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import { fetchManagerCustomers, fetchCustomerMarks, type CustomerRow } from '@/features/customers/engine/customers';
import { getCachedClientNames, resolveClientNames } from '@/lib/bitrix/clientNames';
import {
  COLUMNS, CLIENT_TYPE_NONE_RANK, CLIENT_TYPE_ORDER, LOST_STAGES, NEW_STAGES, REPEAT_FUNNEL_IDS, REVIEW_SINCE,
  STAGE_TO_COLUMN, TOUCHES, WEEK_DAYS, WINDOW_DAYS, WON_STAGES, type ColumnKey,
} from './config';
import { fetchTasksForDeals, type RepeatTask } from './tasks';
import { fetchClientTypes } from './clientTypes';

const DAY_MS = 86_400_000;
/** Карточек в колонке за один ответ (остальные — счётчиком и «показать ещё»). */
export const COLUMN_PAGE = 40;
/** Больше стольких менеджеров разом не грузим: первый прогрев ~1 с на менеджера. */
export const MAX_MANAGERS_AT_ONCE = 80;
const GOOD_CALL_SEC = 20;

export interface RepeatDealInfo {
  dealId: number;
  funnelId: number;
  stageId: string;
  stageName: string | null;
  amount: number | null;
  createdAt: string;
  lostAt: string | null;
  soldAt: string | null;
  deliveredAt: string | null;
  managerId: string | null;
}

export interface CallInfo { at: string; sec: number; missed: boolean }

export interface ReviewInfo {
  decision: 'brak' | 'no_answer' | 'return';
  reason: string | null;
  comment: string | null;
  decidedBy: string;
  decidedAt: string;
}

export interface KanbanCard {
  clientKey: string;
  clientType: 'contact' | 'company';
  clientId: number;
  name: string | null;
  managerId: string;
  managerName: string;
  purchases: number;
  sumDelivered: number;
  lastDeliveredAt: string | null;
  lastDeliveredGroup: string | null;
  repeatChance: number | null;
  expectedValue: number | null;
  /** Тип из карточки клиента (foreman/construction_org/...), null — не заполнен. */
  profileType: string | null;
  /** Текущая повторная сделка (в работе или на разборе). В пуле и браке — null. */
  deal: RepeatDealInfo | null;
  /** Пул/брак: последняя повторная сделка закрыта в отказ — справочно («последний отказ»). */
  lastLost: RepeatDealInfo | null;
  /** Окно 22 дня: начало, касания по неделям, закрыто ли уже. */
  window: { startAt: string; weeks: boolean[]; done: number; weekNo: number | null; closed: boolean } | null;
  /** Звонки по текущей повторной сделке после начала окна (свежие сверху, до 10). */
  calls: CallInfo[];
  missedCalls: number;
  task: RepeatTask | null;
  review: ReviewInfo | null;
  /** Брак: отметка no_call (причина/комментарий/кто). */
  brak: { reason: string | null; comment: string | null; by: string; at: string } | null;
  /** Отказ до трёх недель контакта — красная плашка на разборе. */
  lostEarly: boolean;
  sleeping: boolean;
  atRisk: boolean;
}

export interface KanbanColumn { key: ColumnKey; total: number; sum: number; cards: KanbanCard[] }

export interface RepeatBoard {
  generatedAt: string;
  managers: { id: string; name: string }[];
  selectedManager: string | null;
  columns: KanbanColumn[];
  typeCounts: Record<string, number>;
  notice: string | null;
  canManage: boolean;
}

interface RepeatDealRow {
  client_key: string; deal_id: number; funnel_id: number; stage_id: string; stage_name: string | null;
  amount: string | null; created_at: Date; lost_at: Date | null; sold_at: Date | null; delivered_at: Date | null;
  current_manager_id: number | null;
}

/** Последняя повторная сделка каждого заказчика (по created_at). Один проход по sa.deals,
 *  тот же порядок, что у атрибуции «Моих заказчиков». */
async function fetchLatestRepeatDeals(keys: string[]): Promise<Map<string, RepeatDealInfo>> {
  if (!keys.length) return new Map();
  const res = await analyticsDb().query<RepeatDealRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (client_key) * FROM (
         SELECT (${CLIENT_KEY_CASE_SQL}) AS client_key, d.deal_id, d.funnel_id, d.stage_id, s.name AS stage_name,
                d.amount, d.created_at, d.lost_at, d.sold_at, d.delivered_at, d.current_manager_id
           FROM sa.deals d LEFT JOIN sa.stages s ON s.id = d.stage_id
          WHERE d.funnel_id = ANY($2::int[])
       ) t WHERE client_key = ANY($1::text[])
       ORDER BY client_key, created_at DESC, deal_id DESC
     ) x`,
    [keys, [...REPEAT_FUNNEL_IDS]],
  );
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return new Map(res.rows.map(r => [r.client_key, {
    dealId: Number(r.deal_id), funnelId: Number(r.funnel_id), stageId: r.stage_id, stageName: r.stage_name,
    amount: r.amount !== null ? Math.round(Number(r.amount)) : null,
    createdAt: iso(r.created_at)!, lostAt: iso(r.lost_at), soldAt: iso(r.sold_at), deliveredAt: iso(r.delivered_at),
    managerId: r.current_manager_id !== null ? String(r.current_manager_id) : null,
  }]));
}

async function fetchDealCalls(dealIds: number[], sinceIso: string): Promise<Map<number, CallInfo[]>> {
  if (!dealIds.length) return new Map();
  const res = await analyticsDb().query<{ deal_id: number; called_at: Date; duration_seconds: number | null; result: string | null }>(
    `SELECT deal_id, called_at, duration_seconds, result FROM va.calls
      WHERE deal_id = ANY($1::bigint[]) AND called_at >= $2::timestamptz
      ORDER BY called_at DESC`,
    [dealIds, sinceIso],
  );
  const out = new Map<number, CallInfo[]>();
  for (const r of res.rows) {
    const sec = Number(r.duration_seconds ?? 0);
    const list = out.get(Number(r.deal_id)) ?? [];
    list.push({ at: new Date(r.called_at).toISOString(), sec, missed: r.result === 'missed' || sec === 0 });
    out.set(Number(r.deal_id), list);
  }
  return out;
}

/** Ручные контакты (customer_contacts) — все, не только последний: окно считает недели. */
async function fetchManualContacts(keys: string[], sinceIso: string): Promise<Map<string, string[]>> {
  if (!keys.length) return new Map();
  try {
    const r = await systemDb().query<{ client_key: string; contacted_at: Date }>(
      `SELECT client_key, contacted_at FROM customer_contacts WHERE client_key = ANY($1::text[]) AND contacted_at >= $2::timestamptz`,
      [keys, sinceIso],
    );
    const out = new Map<string, string[]>();
    for (const x of r.rows) {
      const l = out.get(x.client_key) ?? [];
      l.push(new Date(x.contacted_at).toISOString());
      out.set(x.client_key, l);
    }
    return out;
  } catch { return new Map(); }
}

async function fetchReviews(dealIds: number[]): Promise<Map<number, ReviewInfo>> {
  if (!dealIds.length) return new Map();
  try {
    const r = await systemDb().query(`SELECT * FROM repeat_kanban_reviews WHERE deal_id = ANY($1::bigint[])`, [dealIds]);
    return new Map(r.rows.map(x => [Number(x.deal_id), {
      decision: x.decision, reason: x.reason, comment: x.comment, decidedBy: x.decided_by,
      decidedAt: new Date(x.decided_at).toISOString(),
    }]));
  } catch { return new Map(); } // до миграции 230 — без решений
}

/** Недели окна, закрытые контактом: успешный звонок (> 20 с) или ручная отметка. */
function windowWeeks(startMs: number, contacts: number[], now: number) {
  const weeks = [false, false, false];
  for (const t of contacts) {
    const d = (t - startMs) / DAY_MS;
    if (d < 0 || d > WINDOW_DAYS) continue;
    weeks[Math.min(TOUCHES, Math.floor(d / WEEK_DAYS) + 1) - 1] = true;
  }
  const since = (now - startMs) / DAY_MS;
  const closed = since > WINDOW_DAYS;
  const weekNo = closed ? null : Math.min(TOUCHES, Math.floor(Math.max(0, since) / WEEK_DAYS) + 1);
  return { weeks, done: weeks.filter(Boolean).length, weekNo, closed };
}

type Row = CustomerRow & { managerId: string; managerName: string };

function poolColumn(purchases: number): ColumnKey {
  if (purchases >= 5) return 'pool_5';
  if (purchases >= 2) return 'pool_2_4';
  return 'pool_1';
}

export async function buildRepeatBoard(opts: {
  managers: { id: string; name: string }[];
  selectedManager: string | null;
  typeFilter: string | null;
  /** Сколько карточек отдать по каждой колонке (пагинация «показать ещё»). */
  limits?: Partial<Record<ColumnKey, number>>;
  canManage: boolean;
}): Promise<RepeatBoard> {
  const now = Date.now();
  const roster = opts.selectedManager ? opts.managers.filter(m => m.id === opts.selectedManager) : opts.managers;
  const base = {
    generatedAt: new Date(now).toISOString(), managers: opts.managers, selectedManager: opts.selectedManager,
    typeCounts: {}, canManage: opts.canManage,
  };
  const emptyCols = () => COLUMNS.map(c => ({ key: c.key, total: 0, sum: 0, cards: [] }));
  if (roster.length === 0) return { ...base, columns: emptyCols(), notice: 'В вашей зоне нет менеджеров.' };
  if (roster.length > MAX_MANAGERS_AT_ONCE) {
    return { ...base, columns: emptyCols(), notice: `В зоне ${roster.length} менеджеров — выберите менеджера, чтобы открыть доску.` };
  }

  // 1. Заказчики менеджеров (кэш движка «Моих заказчиков»).
  const rows: Row[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < roster.length; i += CONCURRENCY) {
    const chunk = roster.slice(i, i + CONCURRENCY);
    const lists = await Promise.all(chunk.map(m => fetchManagerCustomers(Number(m.id))
      .then(list => list.map(r => ({ ...r, managerId: m.id, managerName: m.name })))));
    for (const l of lists) rows.push(...l);
  }
  const keys = rows.map(r => r.clientKey);

  // 2. Свежие данные поверх кэша.
  const [deals, marks, profileTypes] = await Promise.all([
    fetchLatestRepeatDeals(keys),
    fetchCustomerMarks(keys),
    Promise.all(roster.map(m => fetchClientTypes(`mgr:${m.id}`, rows.filter(r => r.managerId === m.id).map(r => r.clientKey))))
      .then(maps => new Map(maps.flatMap(mp => [...mp]))),
  ]);
  const windowFloor = new Date(now - (WINDOW_DAYS + 120) * DAY_MS).toISOString();
  const activeDealIds = [...deals.values()].filter(d => !WON_STAGES.has(d.stageId)).map(d => d.dealId);
  const [calls, manual, reviews, tasks] = await Promise.all([
    fetchDealCalls(activeDealIds, windowFloor),
    fetchManualContacts(keys, windowFloor),
    fetchReviews([...deals.values()].filter(d => LOST_STAGES.has(d.stageId)).map(d => d.dealId)),
    // Задачи проекта «Повторные продажи» (Битрикс, гр. 118) — по последней повторной сделке.
    fetchTasksForDeals([...deals.values()].map(d => d.dealId)),
  ]);

  const typeCounts: Record<string, number> = {};
  const buckets = new Map<ColumnKey, KanbanCard[]>(COLUMNS.map(c => [c.key, []]));

  for (const r of rows) {
    const deal = deals.get(r.clientKey) ?? null;
    const mark = marks.get(r.clientKey);
    const task = deal ? tasks.get(deal.dealId) ?? null : null;
    const profileType = profileTypes.get(r.clientKey) ?? null;
    const review = deal ? reviews.get(deal.dealId) ?? null : null;

    // Сделка «текущая», только если она после последней отгрузки (иначе это давняя
    // история — заказчик снова в пуле). Отгруженная повторка тоже уже история.
    const lastDelMs = r.lastDeliveredAt ? new Date(r.lastDeliveredAt).getTime() : 0;
    // Открытая (не отказ) повторная сделка — текущая всегда: её могли откатить из отказа
    // кнопкой «Вернуть сделку» (правило владельца 20.10), и создана она тогда раньше отгрузки.
    const current = deal && !WON_STAGES.has(deal.stageId)
      && (!LOST_STAGES.has(deal.stageId) || new Date(deal.createdAt).getTime() >= lastDelMs - 60_000)
      ? deal : null;

    // Окно: от последней отгрузки или от создания сделки (что позже); задача РОПа по
    // этой сделке переносит старт на момент постановки (решение владельца 20.10).
    let windowStartMs: number | null = null;
    if (current) {
      windowStartMs = Math.max(lastDelMs, new Date(current.createdAt).getTime());
      if (task && task.dealId === current.dealId) {
        windowStartMs = Math.max(windowStartMs, new Date(task.createdAt).getTime());
      }
    } else if (r.lastDeliveredAt && (now - lastDelMs) / DAY_MS <= WINDOW_DAYS && r.purchasesDelivered === 1) {
      windowStartMs = lastDelMs; // свежая первая отгрузка без сделки — правило касаний действует
    }

    const dealCalls = current ? calls.get(current.dealId) ?? [] : [];
    let win: KanbanCard['window'] = null;
    let callsInWindow: CallInfo[] = [];
    if (windowStartMs !== null) {
      callsInWindow = dealCalls.filter(c => new Date(c.at).getTime() >= windowStartMs!);
      const contactMs = [
        ...r.goodCallsAfter.map(t => new Date(t).getTime()),
        ...callsInWindow.filter(c => c.sec > GOOD_CALL_SEC).map(c => new Date(c.at).getTime()),
        ...(manual.get(r.clientKey) ?? []).map(t => new Date(t).getTime()),
      ];
      win = { startAt: new Date(windowStartMs).toISOString(), ...windowWeeks(windowStartMs, contactMs, now) };
    }

    // Колонка.
    let col: ColumnKey;
    if (mark?.kind === 'no_call') col = 'brak';
    else if (current && LOST_STAGES.has(current.stageId)) {
      const lostMs = current.lostAt ? new Date(current.lostAt).getTime() : new Date(current.createdAt).getTime();
      const onReview = lostMs >= new Date(REVIEW_SINCE).getTime() || task !== null;
      if (onReview && (!review || review.decision === 'return')) col = 'review';
      else col = poolColumn(r.purchasesDelivered);
    } else if (current && NEW_STAGES.has(current.stageId)) {
      col = (`touch_${Math.min(win?.done ?? 0, TOUCHES)}`) as ColumnKey;
    } else if (current && STAGE_TO_COLUMN.has(current.stageId)) {
      col = STAGE_TO_COLUMN.get(current.stageId)!;
    } else if (r.hasOpenOrder) col = 'st_sold';
    else if (win && !current) col = (`touch_${win.done}`) as ColumnKey;
    else col = poolColumn(r.purchasesDelivered);

    const inPool = col.startsWith('pool') || col === 'brak';
    const typeKey = profileType ?? 'none';
    typeCounts[typeKey] = (typeCounts[typeKey] ?? 0) + 1;
    if (opts.typeFilter && opts.typeFilter !== typeKey) continue;

    buckets.get(col)!.push({
      clientKey: r.clientKey, clientType: r.clientType, clientId: r.clientId, name: null,
      managerId: r.managerId, managerName: r.managerName,
      purchases: r.purchasesDelivered, sumDelivered: r.sumDelivered,
      lastDeliveredAt: r.lastDeliveredAt, lastDeliveredGroup: r.lastDeliveredGroup,
      repeatChance: r.repeatChance, expectedValue: r.expectedValue,
      profileType,
      // В пуле и браке отказная сделка — история, не «текущая»: иначе кнопка предлагала бы
      // задачу к закрытой сделке вместо новой сделки, а окно контактов висело бы зря.
      deal: inPool ? null : current,
      lastLost: inPool && current && LOST_STAGES.has(current.stageId) ? current : null,
      window: inPool ? null : win,
      calls: inPool ? [] : callsInWindow.slice(0, 10), missedCalls: inPool ? 0 : callsInWindow.filter(c => c.missed).length,
      task, review,
      brak: mark?.kind === 'no_call' ? { reason: mark.reason, comment: mark.comment, by: mark.createdBy, at: mark.createdAt } : null,
      lostEarly: col === 'review' && (win?.done ?? 0) < TOUCHES,
      sleeping: r.sleeping, atRisk: r.atRisk,
    });
  }

  // Сортировка: тип клиента (прорабы сверху) → ожидаемые деньги. В колонках контактов
  // сначала то, где окно сгорает раньше; на разборе — свежие отказы сверху.
  const typeRank = (c: KanbanCard) => (c.profileType ? CLIENT_TYPE_ORDER[c.profileType] ?? CLIENT_TYPE_NONE_RANK : CLIENT_TYPE_NONE_RANK);
  const ev = (c: KanbanCard) => c.expectedValue ?? 0;
  const columns: KanbanColumn[] = [];
  for (const def of COLUMNS) {
    const list = buckets.get(def.key)!;
    if (def.group === 'touch') {
      const start = (c: KanbanCard) => (c.window ? new Date(c.window.startAt).getTime() : 0);
      list.sort((a, b) => start(a) - start(b) || typeRank(a) - typeRank(b) || ev(b) - ev(a));
    } else if (def.key === 'review' || def.key === 'brak') {
      const at = (c: KanbanCard) => c.brak?.at ?? c.deal?.lostAt ?? '';
      list.sort((a, b) => at(b).localeCompare(at(a)));
    } else {
      list.sort((a, b) => typeRank(a) - typeRank(b) || Number(a.sleeping) - Number(b.sleeping) || ev(b) - ev(a));
    }
    const limit = Math.max(1, Math.min(opts.limits?.[def.key] ?? COLUMN_PAGE, 2000));
    columns.push({
      key: def.key, total: list.length,
      sum: list.reduce((s, c) => s + (c.deal?.amount ?? 0), 0),
      cards: list.slice(0, limit),
    });
  }

  // Имена: кэш для всех видимых, ленивый добор из Битрикса — только для видимых.
  const visibleKeys = columns.flatMap(c => c.cards.map(x => x.clientKey));
  const names = await resolveClientNames(visibleKeys).catch(() => getCachedClientNames(visibleKeys));
  for (const c of columns) for (const card of c.cards) card.name = names.get(card.clientKey) ?? null;

  return { ...base, columns, typeCounts, notice: null };
}
