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
import { fetchTailTable, tailPotential, type PotentialInfo } from './potential';

const DAY_MS = 86_400_000;
/** Карточек в колонке за один ответ (остальные — счётчиком и «показать ещё»). */
export const COLUMN_PAGE = 40;
/** Больше стольких менеджеров разом не грузим: первый прогрев ~1 с на менеджера. */
export const MAX_MANAGERS_AT_ONCE = 150;
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

export interface CallInfo { at: string; sec: number; missed: boolean; inbound: boolean }

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
  /** Сделка последней отгрузки — дата на карточке кликабельна. */
  lastDeliveredDealId: number | null;
  repeatChance: number | null;
  expectedValue: number | null;
  /** Потенциал на 12 мес. — средний «хвост» таких же заказчиков (engine/potential.ts). */
  potential: number | null;
  /** Из чего сложился потенциал — для подсказки на карточке. */
  potentialInfo: PotentialInfo | null;
  /** Тип из карточки клиента (foreman/construction_org/...), null — не заполнен. */
  profileType: string | null;
  /** Текущая повторная сделка (в работе или на разборе). В пуле и браке — null. */
  deal: RepeatDealInfo | null;
  /** Пул/брак: последняя повторная сделка закрыта в отказ — справочно («последний отказ»). */
  lastLost: RepeatDealInfo | null;
  /** Окно 22 дня: начало, касания по неделям, закрыто ли уже. */
  /** Попытки связаться (правка владельца 20.10): попытка = ДЕНЬ, в который был исходящий
   *  звонок (в т.ч. недозвон), отвеченный входящий или ручная отметка контакта; считаются
   *  по порядку от взятия в работу, без недельной сетки. reached — дозвонились (звонок > 20 с
   *  или ручной контакт): дальше менеджер переводит сделку в стадию или закрывает в отказ. */
  attempts: { startAt: string; days: string[]; count: number; reached: boolean; daysSinceStart: number } | null;
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
  /** Пул: окно открыто — последняя отгрузка ≤ 22 дн. назад, сделки нет (колонка «Срочно»). */
  freshDays: number | null;
}

export interface KanbanColumn {
  key: ColumnKey; total: number;
  /** Сумма открытых сделок колонки. */
  sum: number;
  /** Сумма потенциала (12 мес.) заказчиков колонки. */
  potential: number;
  /** Итого под колонкой: средний «возраст» карточки, дн. (пул — с последней отгрузки, попытки —
   *  со взятия в работу, воронка — с создания сделки), без задачи / просрочено / спит. */
  avgAgeDays: number | null;
  noTask: number;
  overdue: number;
  sleeping: number;
  cards: KanbanCard[];
}

/** Показатели канбана для РОПа (снимок текущей доски). */
export interface BoardKpi {
  pool: number; poolPotential: number;
  inWork: number; inWorkPotential: number;
  reached: number;
  funnel: number; funnelSum: number;
  tasksOverdue: number; tasksControl: number; noTaskInWork: number;
  review: number; reviewEarly: number;
  brak: number;
}

export interface RepeatBoard {
  generatedAt: string;
  managers: { id: string; name: string }[];
  /** Отмеченные галочками менеджеры (пусто — все менеджеры зоны/отделов). */
  selectedManagers: string[];
  columns: KanbanColumn[];
  typeCounts: Record<string, number>;
  /** Пул: товарная группа ПОСЛЕДНЕЙ отгрузки («по наибольшему», head_group_name) → заказчиков. */
  poolGroupCounts: Record<string, number>;
  kpi: BoardKpi | null;
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
/** Сделка последней отгрузки каждого заказчика (любая воронка 0–3) — для ссылки с даты. */
async function fetchLastDeliveredDeals(keys: string[]): Promise<Map<string, number>> {
  if (!keys.length) return new Map();
  const res = await analyticsDb().query<{ client_key: string; deal_id: number }>(
    `SELECT DISTINCT ON (client_key) client_key, deal_id FROM (
       SELECT (${CLIENT_KEY_CASE_SQL}) AS client_key, d.deal_id, d.delivered_at
         FROM sa.deals d WHERE d.funnel_id IN (0,1,2,3) AND d.delivered_at IS NOT NULL
     ) t WHERE client_key = ANY($1::text[])
     ORDER BY client_key, delivered_at DESC, deal_id DESC`,
    [keys],
  );
  return new Map(res.rows.map(r => [r.client_key, Number(r.deal_id)]));
}

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
  const res = await analyticsDb().query<{ deal_id: number; called_at: Date; duration_seconds: number | null; result: string | null; direction: string | null }>(
    `SELECT deal_id, called_at, duration_seconds, result, direction FROM va.calls
      WHERE deal_id = ANY($1::bigint[]) AND called_at >= $2::timestamptz
      ORDER BY called_at DESC`,
    [dealIds, sinceIso],
  );
  const out = new Map<number, CallInfo[]>();
  for (const r of res.rows) {
    const sec = Number(r.duration_seconds ?? 0);
    const list = out.get(Number(r.deal_id)) ?? [];
    list.push({ at: new Date(r.called_at).toISOString(), sec, missed: r.result === 'missed' || sec === 0, inbound: r.direction === 'inbound' });
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

/** День по Москве (YYYY-MM-DD) — единица «попытки». */
const mskDay = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);

/** Попытки по порядку: разные дни с событием контакта начиная со старта. */
function countAttempts(startMs: number, events: { ms: number; reached: boolean }[], now: number) {
  const days = new Set<string>();
  let reached = false;
  for (const e of events.filter(x => x.ms >= startMs).sort((x, y) => x.ms - y.ms)) {
    days.add(mskDay(e.ms));
    if (e.reached) reached = true;
  }
  const list = [...days].sort();
  return { days: list.slice(0, TOUCHES), count: list.length, reached, daysSinceStart: Math.max(0, Math.floor((now - startMs) / DAY_MS)) };
}

type Row = CustomerRow & { managerId: string; managerName: string };

function poolColumn(purchases: number, freshDays: number | null = null): ColumnKey {
  // Окно повторной продажи открыто (≤ 22 дн. с последней отгрузки) — отдельная колонка
  // «Срочно» (владелец 20.10), при любом числе покупок: окно открывается после каждой отгрузки.
  if (freshDays !== null) return 'pool_hot';
  if (purchases >= 5) return 'pool_5';
  if (purchases >= 2) return 'pool_2_4';
  return 'pool_1';
}

export async function buildRepeatBoard(opts: {
  managers: { id: string; name: string }[];
  selectedManagers: string[];
  typeFilter: string | null;
  /** Фильтр пула (владелец 20.10): только заказчики, чья ПОСЛЕДНЯЯ отгрузка — в этих группах
   *  («отгружали газобетон, а после ничего»). Колонки окна/воронки/разбора не трогает. */
  poolGroups?: string[];
  /** Сколько карточек отдать по каждой колонке (пагинация «показать ещё»). */
  limits?: Partial<Record<ColumnKey, number>>;
  canManage: boolean;
}): Promise<RepeatBoard> {
  const now = Date.now();
  const pick = new Set(opts.selectedManagers);
  const roster = pick.size ? opts.managers.filter(m => pick.has(m.id)) : opts.managers;
  const base = {
    generatedAt: new Date(now).toISOString(), managers: opts.managers, selectedManagers: opts.selectedManagers,
    typeCounts: {}, poolGroupCounts: {}, kpi: null, canManage: opts.canManage,
  };
  const emptyCols = (): KanbanColumn[] => COLUMNS.map(c => ({ key: c.key, total: 0, sum: 0, potential: 0, avgAgeDays: null, noTask: 0, overdue: 0, sleeping: 0, cards: [] }));
  if (roster.length === 0) return { ...base, columns: emptyCols(), notice: 'В вашей зоне нет менеджеров.' };
  if (roster.length > MAX_MANAGERS_AT_ONCE) {
    return { ...base, columns: emptyCols(), notice: `В зоне ${roster.length} менеджеров — отметьте менеджеров или сузьте отделы.` };
  }

  // 1. Заказчики менеджеров (кэш движка «Моих заказчиков»).
  const rows: Row[] = [];
  // 4 параллельно: пул SA — 8 соединений (SA_PG_POOL_MAX), 8 разом забирали его целиком и
  // соседние запросы падали по таймауту (20.10). Прогрев ~1 с на менеджера, дальше — Redis.
  const CONCURRENCY = 4;
  for (let i = 0; i < roster.length; i += CONCURRENCY) {
    const chunk = roster.slice(i, i + CONCURRENCY);
    const lists = await Promise.all(chunk.map(m => fetchManagerCustomers(Number(m.id))
      .then(list => list.map(r => ({ ...r, managerId: m.id, managerName: m.name })))));
    for (const l of lists) rows.push(...l);
  }
  const keys = rows.map(r => r.clientKey);

  // 2. Свежие данные поверх кэша.
  const [deals, marks, profileTypes, tailTable, lastDelivered] = await Promise.all([
    fetchLatestRepeatDeals(keys),
    fetchCustomerMarks(keys),
    Promise.all(roster.map(m => fetchClientTypes(`mgr:${m.id}`, rows.filter(r => r.managerId === m.id).map(r => r.clientKey))))
      .then(maps => new Map(maps.flatMap(mp => [...mp]))),
    fetchTailTable().catch(() => ({ seg: {} })),
    fetchLastDeliveredDeals(keys).catch(() => new Map<string, number>()),
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
  const poolGroupCounts: Record<string, number> = {};
  const poolGroups = new Set(opts.poolGroups ?? []);
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
    }
    // Без открытой повторной сделки заказчик — в ПУЛЕ всегда (владелец 20.10: «как это взят
    // в работу без сделки?»). «Взят в работу» = сделка создана/возвращена и задача поставлена.
    // Свежая первая отгрузка без сделки — в пуле с пометкой «пора брать» (freshDays).

    const dealCalls = current ? calls.get(current.dealId) ?? [] : [];
    let win: KanbanCard['attempts'] = null;
    let callsInWindow: CallInfo[] = [];
    if (windowStartMs !== null) {
      callsInWindow = dealCalls.filter(c => new Date(c.at).getTime() >= windowStartMs!);
      const events = [
        // Исходящий — попытка всегда (и недозвон); входящий — только отвеченный.
        ...callsInWindow.filter(c => !c.inbound || !c.missed)
          .map(c => ({ ms: new Date(c.at).getTime(), reached: !c.missed && c.sec > GOOD_CALL_SEC })),
        ...(manual.get(r.clientKey) ?? []).map(t => ({ ms: new Date(t).getTime(), reached: true })),
        // Без сделки (свежая первая отгрузка) звонков по сделке нет — берём успешные по клиенту.
        ...(current ? [] : r.goodCallsAfter.map(t => ({ ms: new Date(t).getTime(), reached: true }))),
      ];
      win = { startAt: new Date(windowStartMs).toISOString(), ...countAttempts(windowStartMs, events, now) };
    }

    const hasOpenDeal = !!current && !LOST_STAGES.has(current.stageId);
    const freshDays = !hasOpenDeal && r.lastDeliveredAt && !r.hasOpenOrder && (now - lastDelMs) / DAY_MS <= WINDOW_DAYS
      ? Math.floor((now - lastDelMs) / DAY_MS) : null;
    // Колонка.
    let col: ColumnKey;
    if (mark?.kind === 'no_call') col = 'brak';
    else if (current && LOST_STAGES.has(current.stageId)) {
      const lostMs = current.lostAt ? new Date(current.lostAt).getTime() : new Date(current.createdAt).getTime();
      const onReview = lostMs >= new Date(REVIEW_SINCE).getTime() || task !== null;
      if (onReview && (!review || review.decision === 'return')) col = 'review';
      else col = poolColumn(r.purchasesDelivered, freshDays);
    } else if (current && NEW_STAGES.has(current.stageId)) {
      col = (`touch_${Math.min(win?.count ?? 0, TOUCHES)}`) as ColumnKey;
    } else if (current && STAGE_TO_COLUMN.has(current.stageId)) {
      col = STAGE_TO_COLUMN.get(current.stageId)!;
    } else if (r.hasOpenOrder) col = 'st_sold';
    else col = poolColumn(r.purchasesDelivered, freshDays);

    const inPool = col.startsWith('pool') || col === 'brak';
    const typeKey = profileType ?? 'none';
    typeCounts[typeKey] = (typeCounts[typeKey] ?? 0) + 1;
    if (opts.typeFilter && opts.typeFilter !== typeKey) continue;
    if (col.startsWith('pool')) {
      const g = r.lastDeliveredGroup ?? 'Без группы';
      poolGroupCounts[g] = (poolGroupCounts[g] ?? 0) + 1;
      if (poolGroups.size && !poolGroups.has(g)) continue;
    }

    buckets.get(col)!.push({
      clientKey: r.clientKey, clientType: r.clientType, clientId: r.clientId, name: null,
      managerId: r.managerId, managerName: r.managerName,
      purchases: r.purchasesDelivered, sumDelivered: r.sumDelivered,
      lastDeliveredAt: r.lastDeliveredAt, lastDeliveredGroup: r.lastDeliveredGroup,
      lastDeliveredDealId: lastDelivered.get(r.clientKey) ?? null,
      repeatChance: r.repeatChance, expectedValue: r.expectedValue,
      ...(() => { const p = tailPotential(tailTable, r.purchasesDelivered, r.clientType === 'company' || r.clientKey.startsWith('x')); return { potential: p?.value ?? null, potentialInfo: p }; })(),
      profileType,
      // В пуле и браке отказная сделка — история, не «текущая»: иначе кнопка предлагала бы
      // задачу к закрытой сделке вместо новой сделки, а окно контактов висело бы зря.
      deal: inPool ? null : current,
      lastLost: inPool && current && LOST_STAGES.has(current.stageId) ? current : null,
      attempts: inPool ? null : win,
      calls: inPool ? [] : callsInWindow.slice(0, 10), missedCalls: inPool ? 0 : callsInWindow.filter(c => c.missed).length,
      task, review,
      brak: mark?.kind === 'no_call' ? { reason: mark.reason, comment: mark.comment, by: mark.createdBy, at: mark.createdAt } : null,
      // Закрыли в отказ, не дозвонившись и не сделав трёх попыток — нарушение правила.
      lostEarly: col === 'review' && !(win?.reached) && (win?.count ?? 0) < TOUCHES,
      sleeping: r.sleeping, atRisk: r.atRisk,
      freshDays,
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
      const start = (c: KanbanCard) => (c.attempts ? new Date(c.attempts.startAt).getTime() : 0);
      list.sort((a, b) => start(a) - start(b) || typeRank(a) - typeRank(b) || ev(b) - ev(a));
    } else if (def.key === 'pool_hot') {
      // Срочно: сначала те, у кого окно закрывается раньше (больше дней с отгрузки).
      list.sort((a, b) => (b.freshDays ?? 0) - (a.freshDays ?? 0) || typeRank(a) - typeRank(b) || ev(b) - ev(a));
    } else if (def.key === 'review' || def.key === 'brak') {
      const at = (c: KanbanCard) => c.brak?.at ?? c.deal?.lostAt ?? '';
      list.sort((a, b) => at(b).localeCompare(at(a)));
    } else {
      list.sort((a, b) => typeRank(a) - typeRank(b) || Number(a.sleeping) - Number(b.sleeping) || ev(b) - ev(a));
    }
    const limit = Math.max(1, Math.min(opts.limits?.[def.key] ?? COLUMN_PAGE, 2000));
    const ageOf = (c: KanbanCard): number | null => {
      const iso = def.group === 'pool' ? c.lastDeliveredAt : def.group === 'touch' ? c.attempts?.startAt ?? null : c.deal?.createdAt ?? null;
      return iso ? (now - new Date(iso).getTime()) / DAY_MS : null;
    };
    const ages = list.map(ageOf).filter((x): x is number => x !== null);
    const openTask = (c: KanbanCard) => c.task && c.task.state !== 'done';
    columns.push({
      key: def.key, total: list.length,
      sum: list.reduce((s, c) => s + (c.deal?.amount ?? 0), 0),
      potential: list.reduce((s, c) => s + (c.potential ?? 0), 0),
      avgAgeDays: ages.length ? Math.round(ages.reduce((s, x) => s + x, 0) / ages.length) : null,
      noTask: def.group === 'touch' || def.group === 'stage' ? list.filter(c => !openTask(c)).length : 0,
      overdue: list.filter(c => openTask(c) && c.task!.state !== 'control' && c.task!.deadlineAt && new Date(c.task!.deadlineAt).getTime() < now).length,
      sleeping: def.group === 'pool' ? list.filter(c => c.sleeping).length : 0,
      cards: list.slice(0, limit),
    });
  }

  // Имена: кэш для всех видимых, ленивый добор из Битрикса — только для видимых.
  const visibleKeys = columns.flatMap(c => c.cards.map(x => x.clientKey));
  const names = await resolveClientNames(visibleKeys).catch(() => getCachedClientNames(visibleKeys));
  for (const c of columns) for (const card of c.cards) card.name = names.get(card.clientKey) ?? null;

  const sumBy = (g: string, f: (c: KanbanColumn) => number) => columns.filter(c => COLUMNS.find(d => d.key === c.key)!.group === g).reduce((s, c) => s + f(c), 0);
  const allIn = (g: string) => COLUMNS.filter(d => d.group === g).flatMap(d => buckets.get(d.key)!);
  const kpi: BoardKpi = {
    pool: sumBy('pool', c => c.total), poolPotential: sumBy('pool', c => c.potential),
    inWork: sumBy('touch', c => c.total), inWorkPotential: sumBy('touch', c => c.potential),
    reached: allIn('touch').filter(c => c.attempts?.reached).length,
    funnel: sumBy('stage', c => c.total), funnelSum: sumBy('stage', c => c.sum),
    tasksOverdue: columns.reduce((s, c) => s + c.overdue, 0),
    tasksControl: [...allIn('touch'), ...allIn('stage'), ...allIn('review')].filter(c => c.task?.state === 'control').length,
    noTaskInWork: sumBy('touch', c => c.noTask) + sumBy('stage', c => c.noTask),
    review: buckets.get('review')!.length, reviewEarly: buckets.get('review')!.filter(c => c.lostEarly).length,
    brak: buckets.get('brak')!.length,
  };
  return { ...base, columns, typeCounts, poolGroupCounts, kpi, notice: null };
}
