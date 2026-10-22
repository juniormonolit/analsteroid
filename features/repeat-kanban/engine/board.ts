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
import { fetchManagerCustomers, fetchCustomersOfManagers, fetchCustomerMarks, type CustomerRow } from '@/features/customers/engine/customers';
import { getCachedClientNames, resolveClientNames, warmClientNames } from '@/lib/bitrix/clientNames';
import {
  COLUMNS, CLIENT_TYPE_NONE_RANK, CLIENT_TYPE_ORDER, LOST_STAGES, NEW_STAGES, REPEAT_FUNNEL_IDS, REPEAT_PROJECT_GROUP_ID, REVIEW_SINCE,
  STAGE_TO_COLUMN, TOUCHES, WEEK_DAYS, WINDOW_DAYS, WON_STAGES, type ColumnKey,
} from './config';
import { fetchTasksForDeals, type RepeatTask } from './tasks';
import { fetchClientTypesBulk } from './clientTypes';
import { fetchTailTable, tailPotential, type PotentialInfo } from './potential';
import { fetchHideRequests, type HideRequest } from './reviews';
import { fetchKanbanSettings } from './settings';
import { fetchOrphanDealClients, fetchWrongFunnelDeals, type WrongFunnelDeal } from './dealFixes';

const DAY_MS = 86_400_000;
/** Карточек в колонке за один ответ (остальные — счётчиком и «показать ещё»). */
export const COLUMN_PAGE = 40;
/** Пока общего снимка нет (самый первый запуск), столько менеджеров ещё грузим старым путём
 *  (~1,7 с на менеджера); больше — «данные готовятся», клиент повторит запрос. */
const FALLBACK_MANAGERS = 20;
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
  /** Колонка карточки — для журнала действий («откуда взяли»). */
  column: ColumnKey;
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
  /** Скрыт из пула до даты (отметка snooze): комментарий обязателен. */
  hidden: { until: string; comment: string | null; by: string; at: string } | null;
  /** Отказ до трёх недель контакта — красная плашка на разборе. */
  lostEarly: boolean;
  sleeping: boolean;
  atRisk: boolean;
  /** Пул: окно открыто — последняя отгрузка ≤ 22 дн. назад, сделки нет (колонка «Срочно»). */
  freshDays: number | null;
  /** Чем кончилась последняя сделка (владелец 21.10: «в приоритете — у кого предыдущая
   *  успешная»): won — после последней отгрузки отказов не было; lost — повторная сделка
   *  после неё закрыта в отказ (на карточке это кнопка «Вернуть сделку»). */
  lastOutcome: 'won' | 'lost';
  /** Выход из дозвона (аудит 21.10): три попытки в разные дни без дозвона — на разбор РОПу. */
  dozvonFail: boolean;
  /** Менеджер предложил скрыть из пула — ждёт решения РОПа (миграция 234). */
  hideRequest: HideRequest | null;
  /** Открытая сделка в ПЕРВИЧНОЙ воронке у повторного заказчика — ошибка менеджера при создании
   *  (владелец 21.10: «кроме самой первой сделки все должны быть в повторной воронке»). */
  wrongFunnel: WrongFunnelDeal | null;
  /** «Брак», а повторная сделка в Битриксе осталась открытой (тестировщик 22.10: «отправляю сразу в
   *  брак, но не закрываю сделку — будет светиться?»): в канбане заказчик в «Браке», но сделка висит
   *  у менеджера — номер, чтобы её закрыли. */
  openDealInBrak: number | null;
  /** Отказник/брак сам позвонил после отказа — карточка в «Срочно» (22.10). */
  returned: { at: string; missed: boolean } | null;
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
/** Состояние задачи заказчика для фильтра: none — открытой задачи нет (не ставили или приняли). */
export type TaskBucket = 'none' | 'unread' | 'work' | 'overdue' | 'control' | 'done';
export type BoardSort = 'default' | 'ltv' | 'potential' | 'fresh' | 'task' | 'ev';

export function taskBucketOf(c: Pick<KanbanCard, 'task'>, now = Date.now()): TaskBucket {
  const t = c.task;
  if (!t || t.state === 'deferred') return 'none';
  if (t.state === 'done') return 'done';
  if (t.state === 'control') return 'control';
  if (t.deadlineAt && new Date(t.deadlineAt).getTime() < now) return 'overdue';
  if (t.state === 'unread') return 'unread';
  return 'work';
}

export interface BoardKpi {
  pool: number; poolPotential: number;
  totalPotential: number;
  inWork: number; inWorkPotential: number;
  reached: number;
  funnel: number; funnelSum: number;
  tasksOverdue: number; tasksControl: number; noTaskInWork: number;
  review: number; reviewEarly: number;
  brak: number;
  hidden: number;
  /** «Срочно: окно открыто» — заказчики и их потенциал: деньги под риском (окно ≤ 22 дн.). */
  hot: number; hotPotential: number;
  /** Из них окно закрывается в ближайшие 3 дня. */
  hotClosing: number;
  /** Проработаны РОПом: в дозвоне/воронке/на разборе И есть задача проекта «Повторные продажи»
   *  (сделки роботов и менеджеров без задачи — не проработка, владелец 21.10). */
  workedByTask: number;
}

/** Режим «Сегодня» (аудит 21.10): одна лента того, что РОПу решить сегодня. */
export type TodayKey = 'control' | 'overdue' | 'hide_request' | 'wrong_funnel' | 'review' | 'closing';
export interface TodaySection { key: TodayKey; title: string; hint: string; total: number; cards: KanbanCard[] }

export interface RepeatBoard {
  generatedAt: string;
  managers: { id: string; name: string }[];
  /** Отмеченные галочками менеджеры (пусто — все менеджеры зоны/отделов). */
  selectedManagers: string[];
  columns: KanbanColumn[];
  typeCounts: Record<string, number>;
  /** Пул: товарная группа ПОСЛЕДНЕЙ отгрузки («по наибольшему», head_group_name) → заказчиков. */
  poolGroupCounts: Record<string, number>;
  /** Сколько заказчиков в каждом состоянии задачи (до фильтра по задачам). */
  taskCounts: Record<string, number>;
  kpi: BoardKpi | null;
  /** Битрикс-id смотрящего — менеджеру «Скрыть из пула» доступно по своим заказчикам. */
  viewerBitrixId?: string | null;
  /** Кнопка «Аналитика» — директорам и выше. */
  canSeeAnalytics?: boolean;
  /** Кнопка «Настройки» (норма задач, шаблоны сообщений) — только админам. */
  canManageSettings?: boolean;
  notice: string | null;
  /** Общий список заказчиков ещё считается (первый запуск) — клиент повторит запрос. */
  warming?: boolean;
  /** «Данные на ЧЧ:ММ»: когда посчитан общий список заказчиков (живые стадии/звонки/задачи — на сейчас). */
  dataAt?: string | null;
  canManage: boolean;
  /** Норма активных задач на менеджера (настройки) и текущая загрузка: менеджер → задач
   *  проекта «Повторные продажи» в работе (не сданных на проверку). */
  taskLimit?: number;
  /** «И сменить менеджера» при постановке задачи включено в настройках (БП «Сменить ответственного»). */
  reassignEnabled?: boolean;
  managerLoad?: Record<string, number>;
  /** Последняя сделка: успешная / проигранная — счётчики по пулу (фильтр «Последняя сделка»). */
  outcomeCounts?: Record<string, number>;
  today?: TodaySection[];
}

interface RepeatDealRow {
  client_key: string; deal_id: number; funnel_id: number; stage_id: string; stage_name: string | null;
  amount: string | null; created_at: Date; lost_at: Date | null; sold_at: Date | null; delivered_at: Date | null;
  current_manager_id: number | null;
  is_open: boolean;
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

/**
 * Последняя повторная сделка каждого заказчика (по created_at).
 * Привязка — НЕ общей формулой client_key отчётов: та отбрасывает юр-сделки без компании
 * (funnel 3, company_id IS NULL), и у заказчика с такой ОТКРЫТОЙ сделкой доска писала «Нет
 * активной сделки» (живой случай 20.10: контакт 182561, сделка 260068 «Отправил счёт»).
 * Здесь, как в единой карточке клиента (контакт = все его сделки): сделка принадлежит И контакту,
 * И компании, если указаны оба (21.10, живой случай Хорев: первая покупка — юр-сделка без компании
 * → заказчик «контакт», следующие и открытая 112192 — на компанию → заказчик «компания»; карточка
 * клиента контакта видела сделку в работе, канбан писал «Нет активной сделки»). Обе карточки
 * заказчика теперь видят свою открытую повторную сделку. Ключи c<id>/x<id> — один и тот же контакт.
 */
async function fetchLatestRepeatDeals(keys: string[]): Promise<Map<string, RepeatDealInfo>> {
  if (!keys.length) return new Map();
  const refOf = (k: string) => (k.startsWith('k') ? k : `p${k.slice(1)}`);
  // Компании — и сделки её контактов (21.10, компания 20460: свежие проданные сделки заведены на
  // контакт 128037 без компании, канбан показывал «постоянника без сделок»). Контакты компании —
  // встречавшиеся в её сделках (обе стороны заполнены).
  const companyIds = [...new Set(keys.filter(k => k.startsWith('k')).map(k => Number(k.slice(1))))];
  const contactsOf = new Map<string, string[]>();
  if (companyIds.length) {
    const cr = await analyticsDb().query<{ company_id: string; contact_id: string }>(
      `SELECT DISTINCT company_id::text AS company_id, contact_id::text AS contact_id FROM sa.deals
        WHERE company_id = ANY($1::bigint[]) AND coalesce(contact_id, 0) <> 0 AND funnel_id IN (0, 1, 2, 3)`, [companyIds],
    ).catch(() => ({ rows: [] as { company_id: string; contact_id: string }[] }));
    for (const r of cr.rows) {
      const l = contactsOf.get(`k${r.company_id}`) ?? [];
      if (l.length < 20) l.push(`p${r.contact_id}`);
      contactsOf.set(`k${r.company_id}`, l);
    }
  }
  const refs = [...new Set([...keys.map(refOf), ...[...contactsOf.values()].flat()])];
  // Сделки, у которых синк потерял клиента, — клиент из Битрикса (dealFixes.ts, 21.10).
  const fix = await fetchOrphanDealClients().catch(() => new Map<number, { contactId: number | null; companyId: number | null }>());
  const fixIds = [...fix.keys()];
  const res = await analyticsDb().query<RepeatDealRow>(
    `WITH fix AS (SELECT * FROM unnest($3::bigint[], $4::bigint[], $5::bigint[]) AS f(deal_id, contact_id, company_id))
     SELECT * FROM (
       SELECT DISTINCT ON (client_key) * FROM (
         SELECT r.ref AS client_key,
                d.deal_id, d.funnel_id, d.stage_id, s.name AS stage_name,
                d.amount, d.created_at, d.lost_at, d.sold_at, d.delivered_at, d.current_manager_id,
                -- Открытая (не отказ и не отгружена, в т.ч. «Продано») — важнее самой свежей (21.10,
                -- контакт 238334: открытая 215670 «Бронь» была старше отгруженной 267699).
                coalesce(s.event_type NOT IN ('lost', 'shipped'), false) AS is_open
           FROM sa.deals d LEFT JOIN sa.stages s ON s.id = d.stage_id
           LEFT JOIN fix f ON f.deal_id = d.deal_id
           CROSS JOIN LATERAL unnest(ARRAY[
             CASE WHEN coalesce(nullif(d.company_id, 0), f.company_id, 0) <> 0 THEN 'k'||coalesce(nullif(d.company_id, 0), f.company_id) END,
             CASE WHEN coalesce(nullif(d.contact_id, 0), f.contact_id, 0) <> 0 THEN 'p'||coalesce(nullif(d.contact_id, 0), f.contact_id) END
           ]) AS r(ref)
          WHERE d.funnel_id = ANY($2::int[]) AND r.ref IS NOT NULL
       ) t WHERE client_key = ANY($1::text[])
       ORDER BY client_key, is_open DESC, created_at DESC, deal_id DESC
     ) x`,
    [refs, [...REPEAT_FUNNEL_IDS], fixIds, fixIds.map(id => fix.get(id)!.contactId), fixIds.map(id => fix.get(id)!.companyId)],
  );
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  const openRef = new Set(res.rows.filter(r => r.is_open).map(r => r.client_key));
  const byRef = new Map(res.rows.map(r => [r.client_key, {
    dealId: Number(r.deal_id), funnelId: Number(r.funnel_id), stageId: r.stage_id, stageName: r.stage_name,
    amount: r.amount !== null ? Math.round(Number(r.amount)) : null,
    createdAt: iso(r.created_at)!, lostAt: iso(r.lost_at), soldAt: iso(r.sold_at), deliveredAt: iso(r.delivered_at),
    managerId: r.current_manager_id !== null ? String(r.current_manager_id) : null,
  } as RepeatDealInfo]));
  const out = new Map<string, RepeatDealInfo>();
  for (const k of keys) {
    // Свои сделки + (для компании) сделки её контактов: открытая важнее, дальше — самая свежая.
    const cands = [refOf(k), ...(contactsOf.get(k) ?? [])].filter(r => byRef.has(r));
    cands.sort((a, b) => Number(openRef.has(b)) - Number(openRef.has(a)) || byRef.get(b)!.createdAt.localeCompare(byRef.get(a)!.createdAt));
    if (cands[0]) out.set(k, byRef.get(cands[0])!);
  }
  return out;
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

/** Входящие звонки заказчиков за 90 дней — самый свежий на заказчика (ref p<контакт> / k<компания>).
 *  «Отказник вернулся» (владелец 22.10): позвонил сам после брака или отказа — в «Срочно». */
async function fetchInboundCalls(refs: string[]): Promise<Map<string, { at: string; missed: boolean }>> {
  if (!refs.length) return new Map();
  const r = await analyticsDb().query<{ ref: string; called_at: Date; result: string | null }>(
    `SELECT DISTINCT ON (r.ref) r.ref, c.called_at, c.result FROM va.calls c
       CROSS JOIN LATERAL unnest(ARRAY[
         CASE WHEN coalesce(c.contact_id, 0) <> 0 THEN 'p'||c.contact_id END,
         CASE WHEN coalesce(c.company_id, 0) <> 0 THEN 'k'||c.company_id END]) AS r(ref)
      WHERE c.direction = 'inbound' AND c.called_at > now() - interval '90 days' AND r.ref = ANY($1::text[])
      ORDER BY r.ref, c.called_at DESC`, [refs],
  ).catch(e => { console.warn('[repeat-kanban] входящие звонки:', e instanceof Error ? e.message : e); return { rows: [] }; });
  return new Map(r.rows.map(x => [x.ref, { at: new Date(x.called_at).toISOString(), missed: x.result === 'missed' }]));
}

/** Загрузка менеджеров: задачи проекта «Повторные продажи» в работе (новая/ждёт/выполняется;
 *  сданные на проверку — уже не на менеджере). */
export async function fetchManagerLoad(managerIds: string[]): Promise<Record<string, number>> {
  if (!managerIds.length) return {};
  const r = await analyticsDb().query<{ mgr: string; n: string }>(
    `SELECT responsible_id::text AS mgr, count(*)::text AS n FROM sa.bitrix_task_current
      WHERE group_id = $2 AND NOT is_deleted AND status IN (1, 2, 3) AND responsible_id::text = ANY($1::text[])
      GROUP BY 1`, [managerIds, REPEAT_PROJECT_GROUP_ID],
  ).catch(() => ({ rows: [] as { mgr: string; n: string }[] }));
  return Object.fromEntries(r.rows.map(x => [x.mgr, Number(x.n)]));
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
  /** Фильтр по задаче заказчика (владелец 20.10: «РОП разбирает задачи на канбане»). */
  taskFilter?: TaskBucket[];
  /** Пул: последняя сделка успешная / проигранная (владелец 21.10). */
  outcome?: 'won' | 'lost' | null;
  /** Поиск заказчика (владелец 21.10): имя/название (все слова), или число — id контакта/
   *  компании, номер сделки (текущей, отказной, последней отгрузки) или задачи. По всем колонкам. */
  search?: string | null;
  /** Сортировка карточек во всех колонках: default — тип клиента → потенциал. */
  sort?: BoardSort;
  /** Сколько карточек отдать по каждой колонке (пагинация «показать ещё»). */
  limits?: Partial<Record<ColumnKey, number>>;
  canManage: boolean;
  /** Ночной снимок: имена и типы клиентов не нужны — не ходим в Битрикс. */
  skipNames?: boolean;
}): Promise<RepeatBoard> {
  const now = Date.now();
  const pick = new Set(opts.selectedManagers);
  const roster = pick.size ? opts.managers.filter(m => pick.has(m.id)) : opts.managers;
  const base = {
    generatedAt: new Date(now).toISOString(), managers: opts.managers, selectedManagers: opts.selectedManagers,
    typeCounts: {}, poolGroupCounts: {}, taskCounts: {}, kpi: null, canManage: opts.canManage,
  };
  const emptyCols = (): KanbanColumn[] => COLUMNS.map(c => ({ key: c.key, total: 0, sum: 0, potential: 0, avgAgeDays: null, noTask: 0, overdue: 0, sleeping: 0, cards: [] }));
  if (roster.length === 0) return { ...base, columns: emptyCols(), notice: 'В вашей зоне нет менеджеров.' };

  // 1. Заказчики менеджеров — срез общего снимка компании (companySnapshot.ts, 21.10: лимит
  // «150 менеджеров за раз» снят — вся компания читается так же быстро, как один менеджер).
  const rows: Row[] = [];
  let dataAt: string | null = null;
  const snap = await fetchCustomersOfManagers(roster.map(m => Number(m.id)), roster.length > FALLBACK_MANAGERS ? 40_000 : 0);
  if (snap) {
    dataAt = new Date(snap.at).toISOString();
    for (const m of roster) for (const r of snap.byMgr.get(Number(m.id)) ?? []) rows.push({ ...r, managerId: m.id, managerName: m.name });
  } else if (roster.length <= FALLBACK_MANAGERS) {
    // Снимка ещё нет — старый путь на менеджера, 4 параллельно (пул SA — 8 соединений).
    const CONCURRENCY = 4;
    for (let i = 0; i < roster.length; i += CONCURRENCY) {
      const lists = await Promise.all(roster.slice(i, i + CONCURRENCY).map(m => fetchManagerCustomers(Number(m.id))
        .then(list => list.map(r => ({ ...r, managerId: m.id, managerName: m.name })))));
      for (const l of lists) rows.push(...l);
    }
  } else {
    return { ...base, columns: emptyCols(), warming: true, notice: 'Список заказчиков компании готовится — меньше минуты, доска обновится сама.' };
  }
  const keys = rows.map(r => r.clientKey);

  // 2. Свежие данные поверх кэша.
  const refOfKey = (k: string) => (k.startsWith('k') ? k : `p${k.slice(1)}`);
  const [deals, marks, profileTypes, tailTable, lastDelivered, wrongFunnel, inbound] = await Promise.all([
    fetchLatestRepeatDeals(keys),
    fetchCustomerMarks(keys),
    // Ночной снимок типы клиентов не использует — не ходим за ними в Битрикс (20.10: первый
    // снимок завис на 214-м менеджере на запросе типов в Битрикс).
    opts.skipNames ? Promise.resolve(new Map<string, string>()) :
    fetchClientTypesBulk(keys).catch(() => new Map<string, string>()),
    fetchTailTable().catch(() => ({ seg: {} })),
    fetchLastDeliveredDeals(keys).catch(() => new Map<string, number>()),
    fetchWrongFunnelDeals([...new Set(keys.map(k => (k.startsWith('k') ? k : `p${k.slice(1)}`)))]),
    fetchInboundCalls([...new Set(keys.map(refOfKey))]),
  ]);
  const windowFloor = new Date(now - (WINDOW_DAYS + 120) * DAY_MS).toISOString();
  const activeDealIds = [...deals.values()].filter(d => !WON_STAGES.has(d.stageId)).map(d => d.dealId);
  const [calls, manual, reviews, tasks, hideReqs, settings, managerLoad] = await Promise.all([
    fetchDealCalls(activeDealIds, windowFloor),
    fetchManualContacts(keys, windowFloor),
    // Решения РОПа: по отказам и по «выходу из дозвона» (открытые сделки) — по всем текущим.
    fetchReviews([...deals.values()].filter(d => !WON_STAGES.has(d.stageId)).map(d => d.dealId)),
    // Задачи проекта «Повторные продажи» (Битрикс, гр. 118) — по последней повторной сделке.
    fetchTasksForDeals([...deals.values()].map(d => d.dealId)),
    fetchHideRequests(keys),
    fetchKanbanSettings(),
    opts.skipNames ? Promise.resolve({} as Record<string, number>) : fetchManagerLoad(roster.map(m => m.id)),
  ]);

  const typeCounts: Record<string, number> = {};
  const poolGroupCounts: Record<string, number> = {};
  const outcomeCounts: Record<string, number> = {};

  // Поиск: имена — из кэша (без Битрикса; кэш на всю компанию докачивается прогревом ниже).
  const norm = (x: string) => x.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const q = opts.search ? norm(opts.search).slice(0, 80) : '';
  const qNum = /^#?\d{2,12}$/.test(q) ? Number(q.replace('#', '')) : null;
  const qWords = q && qNum === null ? q.split(' ').filter(Boolean) : [];
  const searchNames = qWords.length ? await getCachedClientNames(keys).catch(() => new Map<string, string | null>()) : null;
  if (!opts.skipNames) warmClientNames(keys);
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
    let dozvonFail = false;
    // «Скрыть из пула» действует, пока срок не вышел и пока нет открытой сделки: взяли в
    // работу — заказчик в своей рабочей колонке, а не в «Скрытых».
    const todayMsk = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
    const hiddenNow = mark?.kind === 'snooze' && !!mark.snoozeUntil && mark.snoozeUntil >= todayMsk
      && !(current && !LOST_STAGES.has(current.stageId)) && !r.hasOpenOrder;
    // «Вернулся»: после брака или отказа заказчик сам позвонил (даже пропущенный) — в «Срочно».
    const refusedAt = mark?.kind === 'no_call' ? mark.createdAt
      : current && LOST_STAGES.has(current.stageId) ? current.lostAt ?? current.createdAt : null;
    const inb = inbound.get(refOfKey(r.clientKey));
    const returned = inb && refusedAt && new Date(inb.at).getTime() > new Date(refusedAt).getTime() ? inb : null;
    if (mark?.kind === 'no_call' && !returned) col = 'brak';
    else if (hiddenNow) col = 'hidden';
    else if (current && LOST_STAGES.has(current.stageId)) {
      const lostMs = current.lostAt ? new Date(current.lostAt).getTime() : new Date(current.createdAt).getTime();
      const onReview = lostMs >= new Date(REVIEW_SINCE).getTime() || task !== null;
      // Решение по ЭТОМУ отказу — принятое не раньше закрытия (решение «ещё попытки» по
      // дозвону той же сделки, принятое до отказа, разбор отказа не отменяет).
      const decidedLost = review && new Date(review.decidedAt).getTime() >= lostMs - 60_000;
      if (onReview && (!decidedLost || review!.decision === 'return')) col = 'review';
      else col = poolColumn(r.purchasesDelivered, freshDays);
    } else if (current && NEW_STAGES.has(current.stageId)) {
      col = (`touch_${Math.min(win?.count ?? 0, TOUCHES)}`) as ColumnKey;
      // Выход из дозвона: три попытки в разные дни, последний день прошёл — дозвона нет. РОП
      // решает на разборе: брак / ещё попытки («недозвон» — карточка остаётся в дозвоне) /
      // вернуть менеджеру. Решение действует, если принято после начала этого окна.
      const lastDay = win?.days[win.days.length - 1];
      const decided = review && windowStartMs !== null && new Date(review.decidedAt).getTime() >= windowStartMs;
      if (win && win.count >= TOUCHES && !win.reached && lastDay && lastDay < todayMsk
        && (!decided || review!.decision === 'return')) { col = 'review'; dozvonFail = true; }
    } else if (current && STAGE_TO_COLUMN.has(current.stageId)) {
      col = STAGE_TO_COLUMN.get(current.stageId)!;
    } else if (r.hasOpenOrder) col = 'st_sold';
    else col = poolColumn(r.purchasesDelivered, freshDays);

    if (returned && col.startsWith('pool')) col = 'pool_hot';
    const inPool = col.startsWith('pool') || col === 'brak' || col === 'hidden';
    const typeKey = profileType ?? 'none';
    typeCounts[typeKey] = (typeCounts[typeKey] ?? 0) + 1;
    if (opts.typeFilter && opts.typeFilter !== typeKey) continue;
    const lastOutcome: 'won' | 'lost' = current && LOST_STAGES.has(current.stageId) ? 'lost' : 'won';
    if (qNum !== null && ![r.clientId, deal?.dealId, lastDelivered.get(r.clientKey), task?.id].includes(qNum)) continue;
    if (qWords.length) {
      const nm = norm(searchNames?.get(r.clientKey) ?? '');
      if (!nm || !qWords.every(w => nm.includes(w))) continue;
    }
    if (col.startsWith('pool')) {
      const g = r.lastDeliveredGroup ?? 'Без группы';
      poolGroupCounts[g] = (poolGroupCounts[g] ?? 0) + 1;
      outcomeCounts[lastOutcome] = (outcomeCounts[lastOutcome] ?? 0) + 1;
      if (poolGroups.size && !poolGroups.has(g)) continue;
      if (opts.outcome && opts.outcome !== lastOutcome) continue;
    }

    buckets.get(col)!.push({
      column: col,
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
      hidden: hiddenNow && mark ? { until: mark.snoozeUntil!, comment: mark.comment, by: mark.createdBy, at: mark.createdAt } : null,
      // Закрыли в отказ, не дозвонившись и не сделав трёх попыток — нарушение правила.
      lostEarly: col === 'review' && !dozvonFail && !(win?.reached) && (win?.count ?? 0) < TOUCHES,
      sleeping: r.sleeping, atRisk: r.atRisk,
      freshDays,
      lastOutcome, dozvonFail,
      hideRequest: hideReqs.get(r.clientKey) ?? null,
      openDealInBrak: col === 'brak' && hasOpenDeal && current ? current.dealId : null,
      returned: col === 'pool_hot' ? returned ?? null : null,
      // Только если в повторной воронке открытой сделки нет — иначе это история, не ошибка сейчас.
      wrongFunnel: hasOpenDeal ? null : wrongFunnel.get(r.clientKey.startsWith('k') ? r.clientKey : `p${r.clientKey.slice(1)}`) ?? null,
    });
  }

  // Сортировка: тип клиента (прорабы сверху) → ожидаемые деньги. В колонках контактов
  // сначала то, где окно сгорает раньше; на разборе — свежие отказы сверху.
  const typeRank = (c: KanbanCard) => (c.profileType ? CLIENT_TYPE_ORDER[c.profileType] ?? CLIENT_TYPE_NONE_RANK : CLIENT_TYPE_NONE_RANK);
  const ev = (c: KanbanCard) => c.expectedValue ?? 0;
  // Пул: сначала те, у кого последняя сделка успешная (владелец 21.10).
  const lostRank = (c: KanbanCard) => (c.lastOutcome === 'lost' ? 1 : 0);
  const columns: KanbanColumn[] = [];
  // Показатели доски — до фильтра по задачам: фильтр «ждёт приёмки» не должен обнулять
  // «Потенциал пула» (у заказчиков пула задач нет). Снимок списков колонок.
  const kpiBuckets = new Map([...buckets].map(([k, l]) => [k, [...l]]));
  // Фильтр по задачам — после сборки карточек (нужны статус и срок задачи).
  const taskCounts: Record<string, number> = {};
  const taskPick = new Set(opts.taskFilter ?? []);
  for (const [k, list] of buckets) {
    const kept: KanbanCard[] = [];
    for (const c of list) {
      const tb = taskBucketOf(c, now);
      taskCounts[tb] = (taskCounts[tb] ?? 0) + 1;
      if (!taskPick.size || taskPick.has(tb)) kept.push(c);
    }
    buckets.set(k, kept);
  }
  // «По задачам»: сверху то, что требует действия РОПа.
  const TASK_SORT: Record<TaskBucket, number> = { control: 0, overdue: 1, unread: 2, work: 3, none: 4, done: 5 };
  const sortMode = opts.sort ?? 'default';
  const deliveredMs = (c: KanbanCard) => (c.lastDeliveredAt ? new Date(c.lastDeliveredAt).getTime() : 0);
  for (const def of COLUMNS) {
    const list = buckets.get(def.key)!;
    if (def.group === 'touch') {
      const start = (c: KanbanCard) => (c.attempts ? new Date(c.attempts.startAt).getTime() : 0);
      list.sort((a, b) => start(a) - start(b) || typeRank(a) - typeRank(b) || ev(b) - ev(a));
    } else if (def.key === 'pool_hot') {
      // Срочно: сначала те, у кого окно закрывается раньше (больше дней с отгрузки).
      // «Вернулся сам» — первым: клиент ждёт звонка.
      list.sort((a, b) => Number(!!b.returned) - Number(!!a.returned) || lostRank(a) - lostRank(b) || (b.freshDays ?? 0) - (a.freshDays ?? 0) || typeRank(a) - typeRank(b) || ev(b) - ev(a));
    } else if (def.key === 'hidden') {
      list.sort((a, b) => (a.hidden?.until ?? '').localeCompare(b.hidden?.until ?? ''));
    } else if (def.key === 'review' || def.key === 'brak') {
      const at = (c: KanbanCard) => c.brak?.at ?? c.deal?.lostAt ?? '';
      list.sort((a, b) => at(b).localeCompare(at(a)));
    } else if (def.group === 'pool') {
      list.sort((a, b) => lostRank(a) - lostRank(b) || typeRank(a) - typeRank(b) || Number(a.sleeping) - Number(b.sleeping) || ev(b) - ev(a));
    } else {
      list.sort((a, b) => typeRank(a) - typeRank(b) || Number(a.sleeping) - Number(b.sleeping) || ev(b) - ev(a));
    }
    // Явная сортировка из фильтров перекрывает колоночную по умолчанию (правка владельца 20.10).
    if (sortMode === 'ltv') list.sort((a, b) => b.sumDelivered - a.sumDelivered);
    else if (sortMode === 'potential') list.sort((a, b) => (b.potential ?? 0) - (a.potential ?? 0) || b.sumDelivered - a.sumDelivered);
    else if (sortMode === 'fresh') list.sort((a, b) => deliveredMs(b) - deliveredMs(a));
    // Ожидаемые деньги: шанс на повтор × ожидаемая сумма следующей покупки.
    else if (sortMode === 'ev') list.sort((a, b) => ev(b) - ev(a) || b.sumDelivered - a.sumDelivered);
    else if (sortMode === 'task') list.sort((a, b) => TASK_SORT[taskBucketOf(a, now)] - TASK_SORT[taskBucketOf(b, now)] || typeRank(a) - typeRank(b));
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

  // «Сегодня» — из колонок до фильтра по задачам (как показатели): что РОПу решить сегодня.
  const TODAY_LIMIT = 60;
  const everyCard = [...kpiBuckets.values()].flat();
  const changed = (c: KanbanCard) => c.task?.changedAt ?? c.task?.createdAt ?? '';
  const todayDefs: { key: TodayKey; title: string; hint: string; pick: (c: KanbanCard) => boolean; order: (a: KanbanCard, b: KanbanCard) => number }[] = [
    { key: 'control', title: 'Ждут приёмки', hint: 'Менеджер сдал задачу — примите или верните в Битриксе', pick: c => c.task?.state === 'control', order: (a, b) => changed(a).localeCompare(changed(b)) },
    { key: 'overdue', title: 'Просрочены', hint: 'Срок задачи прошёл, менеджер не сдал', pick: c => taskBucketOf(c, now) === 'overdue', order: (a, b) => (a.task?.deadlineAt ?? '').localeCompare(b.task?.deadlineAt ?? '') },
    { key: 'hide_request', title: 'Предлагают скрыть', hint: 'Менеджер предложил скрыть заказчика из пула', pick: c => !!c.hideRequest, order: (a, b) => a.hideRequest!.at.localeCompare(b.hideRequest!.at) },
    { key: 'wrong_funnel', title: 'Не в той воронке', hint: 'Повторная сделка заведена в первичной воронке — перенесите в «Повторные» в Битриксе', pick: c => !!c.wrongFunnel, order: (a, b) => b.wrongFunnel!.createdAt.localeCompare(a.wrongFunnel!.createdAt) },
    { key: 'review', title: 'На разборе', hint: 'Отказы и три попытки без дозвона — решите: брак, ещё попытки или вернуть', pick: c => c.column === 'review', order: (a, b) => (b.deal?.lostAt ?? b.deal?.createdAt ?? '').localeCompare(a.deal?.lostAt ?? a.deal?.createdAt ?? '') },
    { key: 'closing', title: 'Окно закрывается', hint: `Отгрузили ${WINDOW_DAYS - 3}+ дней назад, сделки нет — осталось 3 дня или меньше`, pick: c => c.column === 'pool_hot' && (c.freshDays ?? 0) >= WINDOW_DAYS - 3, order: (a, b) => lostRank(a) - lostRank(b) || (b.freshDays ?? 0) - (a.freshDays ?? 0) || ev(b) - ev(a) },
  ];
  const today: TodaySection[] = todayDefs.map(d => {
    const list = everyCard.filter(d.pick).sort(d.order);
    return { key: d.key, title: d.title, hint: d.hint, total: list.length, cards: list.slice(0, TODAY_LIMIT) };
  });

  // Имена: кэш для всех видимых, ленивый добор из Битрикса — только для видимых.
  if (!opts.skipNames) {
    const visible = [...columns.flatMap(c => c.cards), ...today.flatMap(t => t.cards)];
    const visibleKeys = [...new Set(visible.map(x => x.clientKey))];
    const names = await resolveClientNames(visibleKeys).catch(() => getCachedClientNames(visibleKeys));
    for (const card of visible) card.name = names.get(card.clientKey) ?? null;
  }

  const allIn = (g: string) => COLUMNS.filter(d => d.group === g).flatMap(d => kpiBuckets.get(d.key)!);
  const openTask = (c: KanbanCard) => !!c.task && c.task.state !== 'done' && c.task.state !== 'deferred';
  const pot = (l: KanbanCard[]) => l.reduce((s, c) => s + (c.potential ?? 0), 0);
  const work = [...allIn('touch'), ...allIn('stage')];
  const kpi: BoardKpi = {
    pool: allIn('pool').length, poolPotential: pot(allIn('pool')),
    // Потенциал всей базы (кроме брака): не тает от работы — работа перекладывает его из пула в работу.
    totalPotential: pot([...allIn('pool'), ...allIn('touch'), ...allIn('stage'), ...allIn('review'), ...allIn('hidden')]),
    inWork: allIn('touch').length, inWorkPotential: pot(allIn('touch')),
    reached: allIn('touch').filter(c => c.attempts?.reached).length,
    funnel: allIn('stage').length, funnelSum: allIn('stage').reduce((s, c) => s + (c.deal?.amount ?? 0), 0),
    // По всем карточкам, как в «Сегодня»: сданная задача по сделке, ушедшей в пул, тоже ждёт приёмки.
    tasksOverdue: everyCard.filter(c => taskBucketOf(c, now) === 'overdue').length,
    tasksControl: everyCard.filter(c => c.task?.state === 'control').length,
    noTaskInWork: work.filter(c => !openTask(c)).length,
    review: kpiBuckets.get('review')!.length, reviewEarly: kpiBuckets.get('review')!.filter(c => c.lostEarly).length,
    brak: kpiBuckets.get('brak')!.length,
    hidden: kpiBuckets.get('hidden')!.length,
    hot: kpiBuckets.get('pool_hot')!.length, hotPotential: pot(kpiBuckets.get('pool_hot')!),
    hotClosing: kpiBuckets.get('pool_hot')!.filter(c => (c.freshDays ?? 0) >= WINDOW_DAYS - 3).length,
    workedByTask: [...work, ...allIn('review')].filter(c => !!c.task).length,
  };
  const found = columns.reduce((s, c) => s + c.total, 0);
  const notice = q && found === 0
    ? `По запросу «${opts.search}» никого не нашли. Ищется по имени или названию (все слова) и по номерам контакта, компании, сделки, задачи; имена из Битрикса ещё докачиваются — попробуйте через пару минут.`
    : null;
  return { ...base, columns, typeCounts, poolGroupCounts, taskCounts, kpi, notice, dataAt,
    taskLimit: settings.managerTaskLimit, reassignEnabled: settings.reassignEnabled, managerLoad, outcomeCounts, today };
}
