import { analyticsDb, systemDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { CLIENT_KEY_CASE_SQL, deriveClientType } from './clientKey';

// ── «Мои заказчики» (фича Серёги 01.08) ──────────────────────────────────────
// Список клиентов менеджера с сигналом «пора позвонить». Мотив: анализ показал,
// что 24,8% повторных сделок 2026 закрыты в отказ без единого звонка — менеджеру
// нужен рабочий список «кому позвонить сегодня».
//
// КЛИЕНТ — та же сегментация, что в разделе «Повторные» (features/reports/engine/repeat.ts):
//   funnel_id IN (0,2) → ФИЗ (B2C), клиент = contact_id;
//   funnel_id IN (1,3) → ЮР  (B2B), клиент = company_id;
//   воронки 4 (холодные) и 7 (тендеры) исключены.
// «Покупка» здесь = sold_at IS NOT NULL (эталон продаж внутри analsteroid —
// sa.deals.sold_at; в «Повторных» покупкой считается delivered_at — осознанное
// отличие: сигнал обзвона должен опираться на момент продажи, а не отгрузки,
// которая может отставать на недели).
//
// АТРИБУЦИЯ клиента менеджеру: current_manager_id ПОСЛЕДНЕЙ сделки клиента
// (по created_at, тай-брейк deal_id). Решение: «чей клиент» в живой практике —
// тот, кто вёл его последним; история сделок клиента при этом учитывается ВСЯ
// (сделок всего/продано — по всем сделкам клиента, независимо от менеджера).
//
// СИГНАЛ «пора позвонить» (главная колонка, сортировка по нему):
//   (а) overdue_repeat — активных сделок нет И с последней покупки прошло больше
//       типичного цикла повторки клиента. Цикл = медиана интервалов между его
//       покупками (только при >=3 покупках, т.е. >=2 интервалах), иначе — медиана
//       по всей базе (константа ниже); нижняя планка MIN_CYCLE_DAYS.
//   (б) active_no_call — есть активная сделка (стадия NEW или WORK без
//       sold/shipped — то же определение «открытой», что в features/offload),
//       по которой не было ни одного звонка ACTIVE_NO_CALL_DAYS дней
//       (отсчёт от максимума из created_at сделки и последнего звонка по ней).
// Бейдж «были отказы без звонка»: у клиента есть сделка с lost_at, по которой
// в va.calls нет НИ ОДНОГО звонка (deal_id, direction любой).

/**
 * Медиана интервала между покупками по ВСЕЙ базе (глобальный фолбэк цикла
 * повторки). Посчитана SQL-ом на живых данных 01.08.2026:
 *   WITH p AS (SELECT client_key, sold_at FROM sa.deals ... funnel_id IN (0,1,2,3))
 *   SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FROM (lag по клиенту) WHERE gap >= 1;
 *   → 16.0 дней (8257 интервалов; p25=1.3, p75=30.9).
 * Без фильтра gap>=1 медиана 9.0 (10734 интервала) — куча покупок в тот же/следующий
 * день (разбиение одного заказа на несколько сделок), это НЕ цикл повторки,
 * поэтому интервалы <1 дня из оценки исключены.
 */
export const GLOBAL_REPEAT_CYCLE_DAYS = 16;
/** Нижняя планка цикла: клиент с медианой 1–2 дня (серия дробных заказов) не должен
 *  загораться «пора позвонить» через двое суток после покупки. */
export const MIN_CYCLE_DAYS = 7;
/** (б): активная сделка без единого звонка столько дней = сигнал. Дефолт из брифа. */
export const ACTIVE_NO_CALL_DAYS = 7;
/** Клиентская медиана цикла применяется только при >=3 покупках (из брифа). */
const MIN_PURCHASES_FOR_OWN_CYCLE = 3;
/** «Постоянник под угрозой» (доработка 01.08): постоянник без активных сделок,
 *  у которого давность с последней покупки больше стольких его циклов повторки. */
export const AT_RISK_CYCLE_MULTIPLIER = 2;
/** Авто-архив «Спящие» (продолжение 01.08): купивший клиент без активных сделок,
 *  молчащий дольше max(SLEEP_CYCLE_MULTIPLIER × его цикла, SLEEP_MIN_DAYS дней),
 *  уходит из основного вида и горящих сигналов во вкладку «Спящие» (вернуть может
 *  менеджер/РОП отметкой wake). Порог выбран по данным 01.08: без него «под
 *  угрозой» по базе 3171 клиент (2106 постоянников молчат 200+ дней), с ним — 785;
 *  у топ-3 менеджеров по клиентам список сжимается 93→25, 93→22, 82→16. */
export const SLEEP_CYCLE_MULTIPLIER = 3;
export const SLEEP_MIN_DAYS = 120;

export interface ActiveDealInfo {
  dealId: number;
  name: string | null;
  stage: string | null;
  amount: number | null;
  createdAt: string;        // ISO
  lastCallAt: string | null;
  /** Дней без звонка по этой сделке (от max(created_at, последний звонок)). */
  daysSilent: number;
}

export type CallSignal = 'overdue_repeat' | 'active_no_call';

/** Секции списка (доработка Серёги 01.08): постоянники (2+ успешных сделок по
 *  sold_at) → купили один раз (кандидаты) → ещё не купили (отдельная вкладка).
 *  Постоянничество — свойство КЛИЕНТА: считается по ВСЕЙ истории его сделок,
 *  без привязки к менеджеру (dealsSold и так агрегирует все сделки клиента). */
export type CustomerSection = 'regular' | 'once' | 'never';

/** Один менеджер в истории клиента. Имя — НА МОМЕНТ работы с клиентом
 *  (sa.employee_name_history, SCD2: на логине люди меняются — слот-модель),
 *  фолбэк — текущее имя sa.employees. */
export interface ManagerHistoryItem {
  managerId: number;
  name: string | null;   // null → «Менеджер #id» в UI
  deals: number;
  sold: number;
  firstAt: string;       // ISO: первая сделка этого менеджера с клиентом
  lastAt: string;        // ISO: последняя (имя взято на эту дату)
}

export interface CustomerRow {
  clientKey: string;               // 'c<contact_id>' | 'k<company_id>'
  clientType: 'contact' | 'company';
  clientId: number;                // bitrix contact/company id
  name: string | null;             // из кэша имён (lazily из Битрикса); null → «Контакт #…»
  dealsTotal: number;
  dealsSold: number;
  sumSold: number;
  lastSoldAt: string | null;       // ISO
  /** Сумма и материал (head-группы) последней проданной сделки (доп. Серёги 01.08). */
  lastSoldAmount: number | null;
  lastSoldGroups: string[];
  lastCallAt: string | null;       // ISO, по всем сделкам клиента
  lastActivityAt: string | null;   // ISO: max(событие стадии, звонок)
  activeCount: number;
  activeDeals: ActiveDealInfo[];
  refusedNoCall: boolean;          // бейдж «были отказы без звонка»
  /** Head-группы последней покупки — база кросс-селл рекомендации (crossSell.ts). */
  lastGroups: string[];
  cycleDays: number;               // применённый цикл повторки (для тултипа)
  cycleSource: 'own' | 'global';
  signals: CallSignal[];           // пусто = звонить не пора
  /** Вес для сортировки: чем больше, тем выше в списке. */
  urgency: number;
  /** Секция списка: постоянник (2+ покупок) / купил один раз / ещё не купил. */
  section: CustomerSection;
  /** «Постоянник под угрозой»: без активных сделок и давность с последней
   *  покупки > AT_RISK_CYCLE_MULTIPLIER × его цикла повторки (спящие исключены). */
  atRisk: boolean;
  /** Правило авто-архива: молчание > max(3×цикла, 120 дн) без активных сделок.
   *  Отметка wake (customer_marks) возвращает клиента в основной вид — это
   *  применяется поверх, в роуте (кэш движка отметок не знает). */
  sleeping: boolean;
  /** Категории клиентов (дополнение Серёги 01.08): сырьё для classifyCategory. */
  dealsDelivered: number;
  sumDelivered: number;
  distinctGroups: number;
  avgGapDays: number | null;
  lastGapDays: number | null;
  /** Все менеджеры, вёдшие сделки клиента (имена на момент работы), свежие сверху. */
  managerHistory: ManagerHistoryItem[];
  /** Имена ПРЕДЫДУЩИХ менеджеров (все из истории, кроме текущего) — для пометки
   *  «ранее работал с: …» в строке. */
  prevManagerNames: string[];
}

interface RawRow {
  client_key: string;
  deals_total: string;
  deals_sold: string;
  sum_sold: string;
  last_sold_at: string | Date | null;
  last_call_at: string | Date | null;
  last_event_at: string | Date | null;
  median_gap_days: string | null;
  avg_gap_days: string | null;
  last_gap_days: string | null;
  deals_delivered: string;
  sum_delivered: string;
  distinct_groups: string;
  refused_no_call: boolean;
  last_groups: string[] | null;
  last_sold_amount: string | null;
  last_sold_groups: string[] | null;
  active_deals: {
    dealId: number; name: string | null; stage: string | null; amount: number | null;
    createdAt: string; lastCallAt: string | null;
  }[] | null;
  manager_history: {
    managerId: number; name: string | null; deals: number; sold: number;
    firstAt: string; lastAt: string;
  }[] | null;
}

const DAY_MS = 86_400_000;

function daysSince(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / DAY_MS;
}

// node-pg отдаёт timestamptz-колонки как Date (jsonb-вложенные даты — строками);
// нормализуем всё в ISO-строки, иначе сортировка localeCompare падает (пойман живьём).
function toIso(v: string | Date | null): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

// Один SQL на менеджера: атрибуция клиентов + агрегаты + активные сделки +
// звонки + последняя активность. ~1с на менеджере с 1100 клиентами (замер
// 01.08 на проде), поэтому результат живёт в Redis-кэше 10 минут (ниже).
const CUSTOMERS_SQL = `
WITH cd AS (
  SELECT * FROM (
    SELECT d.deal_id, d.deal_name, d.amount, d.created_at, d.sold_at, d.lost_at,
           d.delivered_at, d.head_group_name, d.stage_id, d.current_manager_id,
           (${CLIENT_KEY_CASE_SQL}) AS client_key
    FROM sa.deals d
    WHERE d.funnel_id IN (0,1,2,3)
  ) t
  WHERE client_key IS NOT NULL
),
attr AS (
  SELECT DISTINCT ON (client_key) client_key, current_manager_id AS mgr
  FROM cd ORDER BY client_key, created_at DESC, deal_id DESC
),
mcd AS (SELECT cd.* FROM cd JOIN attr USING (client_key) WHERE attr.mgr = $1),
deal_calls AS (
  SELECT c.deal_id, max(c.called_at) AS last_call_at
  FROM va.calls c WHERE c.deal_id IN (SELECT deal_id FROM mcd)
  GROUP BY 1
),
ev AS (
  SELECT m.client_key, max(de.event_at) AS last_event_at
  FROM sa.deal_events de JOIN mcd m ON m.deal_id = de.deal_id
  GROUP BY 1
),
opens AS (
  SELECT m.client_key,
         jsonb_agg(jsonb_build_object(
           'dealId', m.deal_id, 'name', m.deal_name, 'stage', s.name, 'amount', m.amount,
           'createdAt', m.created_at, 'lastCallAt', dc.last_call_at) ORDER BY m.created_at DESC) AS active_deals
  FROM mcd m JOIN sa.stages s ON s.id = m.stage_id
  LEFT JOIN deal_calls dc ON dc.deal_id = m.deal_id
  WHERE s.stage_type = 'NEW' OR (s.stage_type = 'WORK' AND s.event_type NOT IN ('sold','shipped'))
  GROUP BY 1
),
lastg AS (
  -- Группы последней покупки (для кросс-селл рекомендации «что предложить»):
  -- последняя проданная сделка клиента, у которой есть ТОВАРНЫЕ head-группы
  -- (услуги/доставка/«Разное» исключены — та же выборка, что в матрице
  -- переходов features/customers/engine/crossSell.ts).
  SELECT DISTINCT ON (client_key) client_key, grps AS last_groups
  FROM (
    SELECT m.client_key, m.sold_at, m.deal_id,
           array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
                 WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                   AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS grps
    FROM mcd m JOIN sa.deals d ON d.deal_id = m.deal_id
    WHERE m.sold_at IS NOT NULL
  ) t
  WHERE cardinality(grps) > 0
  ORDER BY client_key, sold_at DESC, deal_id DESC
),
lasts AS (
  -- Последняя ПРОДАННАЯ сделка клиента целиком (доп. Серёги 01.08: показывать
  -- материал и сумму последней покупки в строке): дата = max(sold_at) из agg,
  -- группы/сумма — этой сделки. Группы могут быть пусты (сделка из услуг) — UI
  -- покажет только сумму; рекомендация «Предложить» продолжает считаться от
  -- последней сделки С ТОВАРНЫМИ группами (lastg ниже) — это разные вещи.
  SELECT DISTINCT ON (m.client_key) m.client_key, m.amount AS last_sold_amount,
         array(SELECT DISTINCT (p->>'head_group_name') FROM jsonb_array_elements(d.products) p
               WHERE coalesce(p->>'type','') <> 'услуга' AND (p->>'head_group_name') IS NOT NULL
                 AND (p->>'head_group_name') !~* '^(доставка|перевозка|услуг|разное)') AS last_sold_groups
  FROM mcd m JOIN sa.deals d ON d.deal_id = m.deal_id
  WHERE m.sold_at IS NOT NULL
  ORDER BY m.client_key, m.sold_at DESC, m.deal_id DESC
),
mgr_hist AS (
  -- История менеджеров клиента (доработка 01.08): кто вёл сделки, по ИМЕНАМ НА
  -- МОМЕНТ работы. На одном bitrix-логине люди меняются (слот-модель), поэтому
  -- имя берём из sa.employee_name_history (SCD2, ведёт ночной org-sync) на дату
  -- ПОСЛЕДНЕЙ сделки менеджера с клиентом; фолбэк — текущее имя sa.employees.
  SELECT t.client_key,
         jsonb_agg(jsonb_build_object(
           'managerId', t.mgr, 'name', coalesce(h.name, e.full_name),
           'deals', t.deals, 'sold', t.sold,
           'firstAt', t.first_at, 'lastAt', t.last_at) ORDER BY t.last_at DESC) AS manager_history
  FROM (
    SELECT client_key, current_manager_id AS mgr, count(*)::int AS deals,
           count(*) FILTER (WHERE sold_at IS NOT NULL)::int AS sold,
           min(created_at) AS first_at, max(created_at) AS last_at
    FROM mcd WHERE current_manager_id IS NOT NULL
    GROUP BY 1, 2
  ) t
  LEFT JOIN LATERAL (
    SELECT name FROM sa.employee_name_history nh
    WHERE nh.bitrix_user_id = t.mgr::text AND nh.valid_from <= t.last_at
      AND (nh.valid_to IS NULL OR nh.valid_to > t.last_at)
    ORDER BY nh.valid_from DESC LIMIT 1
  ) h ON true
  LEFT JOIN sa.employees e ON e.bitrix_id = t.mgr
  GROUP BY t.client_key
),
gaps AS (
  SELECT client_key, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap_days,
         avg(gap) AS avg_gap_days,
         max(gap) FILTER (WHERE rn = 1) AS last_gap_days
  FROM (
    SELECT client_key, sold_at,
           EXTRACT(EPOCH FROM sold_at - lag(sold_at) OVER (PARTITION BY client_key ORDER BY sold_at))/86400.0 AS gap,
           row_number() OVER (PARTITION BY client_key ORDER BY sold_at DESC) AS rn
    FROM mcd WHERE sold_at IS NOT NULL
  ) g
  -- Интервалы <1 дня — дробление одного заказа, циклом повторки не считаем
  -- (та же логика, что у глобальной константы GLOBAL_REPEAT_CYCLE_DAYS).
  WHERE gap >= 1 GROUP BY 1
)
SELECT a.client_key,
       a.deals_total::text, a.deals_sold::text, a.sum_sold::text,
       a.last_sold_at, a.last_call_at, ev.last_event_at,
       g.median_gap_days::text, g.avg_gap_days::text, g.last_gap_days::text, a.refused_no_call,
       a.deals_delivered::text, a.sum_delivered::text, a.distinct_groups::text,
       o.active_deals, lg.last_groups,
       ls.last_sold_amount::text, ls.last_sold_groups,
       mh.manager_history
FROM (
  SELECT m.client_key,
         count(*) AS deals_total,
         count(*) FILTER (WHERE m.sold_at IS NOT NULL) AS deals_sold,
         COALESCE(sum(m.amount) FILTER (WHERE m.sold_at IS NOT NULL), 0) AS sum_sold,
         max(m.sold_at) AS last_sold_at,
         max(dc.last_call_at) AS last_call_at,
         bool_or(m.lost_at IS NOT NULL AND dc.deal_id IS NULL) AS refused_no_call,
         -- Категории клиентов (дополнение Серёги 01.08): «отгрузка» = delivered_at
         -- (как «покупка» в отчёте «Повторные»), комплексность = разные deal-level
         -- head-группы отгруженных сделок (шкала by_max — как complex_clients там же).
         count(*) FILTER (WHERE m.delivered_at IS NOT NULL) AS deals_delivered,
         COALESCE(sum(m.amount) FILTER (WHERE m.delivered_at IS NOT NULL), 0) AS sum_delivered,
         count(DISTINCT m.head_group_name) FILTER (WHERE m.delivered_at IS NOT NULL AND m.head_group_name IS NOT NULL) AS distinct_groups
  FROM mcd m LEFT JOIN deal_calls dc ON dc.deal_id = m.deal_id
  GROUP BY 1
) a
LEFT JOIN opens o USING (client_key)
LEFT JOIN gaps g USING (client_key)
LEFT JOIN lastg lg USING (client_key)
LEFT JOIN lasts ls USING (client_key)
LEFT JOIN mgr_hist mh USING (client_key)
LEFT JOIN ev USING (client_key)
`;

function toRow(r: RawRow, now: number, managerBitrixId: number): CustomerRow {
  const dealsSold = Number(r.deals_sold);
  const ownMedian = r.median_gap_days !== null ? Number(r.median_gap_days) : null;
  const useOwn = ownMedian !== null && dealsSold >= MIN_PURCHASES_FOR_OWN_CYCLE;
  const cycleDays = Math.max(useOwn ? ownMedian : GLOBAL_REPEAT_CYCLE_DAYS, MIN_CYCLE_DAYS);

  const active: ActiveDealInfo[] = (r.active_deals ?? []).map(d => ({
    ...d,
    amount: d.amount !== null ? Number(d.amount) : null,
    daysSilent: daysSince(d.lastCallAt ?? d.createdAt, now),
  }));

  const lastSoldAt = toIso(r.last_sold_at);
  const lastCallAt = toIso(r.last_call_at);
  const lastEventAt = toIso(r.last_event_at);

  const signals: CallSignal[] = [];
  let urgency = 0;
  const sinceSold = lastSoldAt !== null ? daysSince(lastSoldAt, now) : null;
  if (active.length === 0 && sinceSold !== null && sinceSold > cycleDays) {
    signals.push('overdue_repeat');
    // Насколько просрочен контакт относительно цикла клиента (2 = просрочка вдвое).
    urgency += Math.min(sinceSold / cycleDays, 50);
  }
  const maxSilent = active.reduce((mx, d) => Math.max(mx, d.daysSilent), 0);
  if (maxSilent > ACTIVE_NO_CALL_DAYS) {
    signals.push('active_no_call');
    // Активная сделка без звонка — горячее просроченной повторки: деньги на столе.
    urgency += 100 + Math.min(maxSilent, 365);
  }
  if (r.refused_no_call) urgency += 0.5; // тай-брейк: отказники без звонка чуть выше

  // Секции (доработка 01.08): 2+ успешных сделок = постоянник; постоянничество —
  // свойство клиента (dealsSold считает ВСЕ его сделки, не только менеджера $1).
  const section: CustomerSection = dealsSold >= 2 ? 'regular' : dealsSold === 1 ? 'once' : 'never';
  // Авто-архив «Спящие»: купивший, без активных, молчание > max(3×цикла, 120 дн).
  const sleeping = dealsSold >= 1 && active.length === 0 && sinceSold !== null
    && sinceSold > Math.max(SLEEP_CYCLE_MULTIPLIER * cycleDays, SLEEP_MIN_DAYS);
  // «Под угрозой»: постоянник без активных сделок, молчание > 2× его цикла
  // повторки, но ещё НЕ спящий (спящие — уже архив, не «горящий» список).
  const atRisk = section === 'regular' && active.length === 0
    && sinceSold !== null && sinceSold > AT_RISK_CYCLE_MULTIPLIER * cycleDays
    && !sleeping;

  // История менеджеров: имена на момент работы (SQL выше), свежие сверху.
  const managerHistory: ManagerHistoryItem[] = (r.manager_history ?? []).map(m => ({
    ...m,
    firstAt: toIso(m.firstAt)!,
    lastAt: toIso(m.lastAt)!,
  }));
  const prevManagerNames = managerHistory
    .filter(m => m.managerId !== managerBitrixId)
    .map(m => m.name ?? `Менеджер #${m.managerId}`);

  const clientType = deriveClientType(r.client_key);
  return {
    clientKey: r.client_key,
    clientType,
    clientId: Number(r.client_key.slice(1)),
    name: null,
    dealsTotal: Number(r.deals_total),
    dealsSold,
    sumSold: Math.round(Number(r.sum_sold)),
    lastSoldAt,
    lastSoldAmount: r.last_sold_amount !== null ? Math.round(Number(r.last_sold_amount)) : null,
    lastSoldGroups: r.last_sold_groups ?? [],
    lastCallAt,
    lastActivityAt: [lastEventAt, lastCallAt].filter((v): v is string => v !== null).sort().pop() ?? null,
    activeCount: active.length,
    activeDeals: active,
    refusedNoCall: r.refused_no_call,
    dealsDelivered: Number(r.deals_delivered),
    sumDelivered: Math.round(Number(r.sum_delivered)),
    distinctGroups: Number(r.distinct_groups),
    avgGapDays: r.avg_gap_days !== null ? Number(r.avg_gap_days) : null,
    lastGapDays: r.last_gap_days !== null ? Number(r.last_gap_days) : null,
    lastGroups: r.last_groups ?? [],
    cycleDays: Math.round(cycleDays * 10) / 10,
    cycleSource: useOwn ? 'own' : 'global',
    signals,
    urgency,
    section,
    atRisk,
    sleeping,
    managerHistory,
    prevManagerNames,
  };
}

/**
 * Полный список заказчиков менеджера, отсортированный по сигналу (главная
 * сортировка из брифа): сначала «пора позвонить» по убыванию urgency, потом
 * остальные по давности последней активности. Redis-кэш 10 минут (список
 * тяжёлый — full-scan sa.deals; фильтры/поиск/пагинация режутся уже поверх
 * кэша в API-роуте).
 */
export async function fetchManagerCustomers(managerBitrixId: number): Promise<CustomerRow[]> {
  // v3 в ключе: форма строки расширена (v2 — секции/atRisk/история менеджеров,
  // v3 — sleeping) — старые кэши без этих полей ломали бы новый код 10 минут.
  // v4 — поля категорий клиентов (отгрузки/комплексность/интервалы, 01.08).
  // v5 (задача 2776) — формула client_key поменялась (фикс «k0»): без бампа
  // версии до 10 минут после деплоя отдавался бы старый кэш со «схлопнутым»
  // client_key='k0' под старым TTL — версия форсирует немедленный промах.
  return cached(`customers:mgr:v5:${managerBitrixId}`, 10 * 60, async () => {
    const res = await analyticsDb().query<RawRow>(CUSTOMERS_SQL, [managerBitrixId]);
    const now = Date.now();
    const rows = res.rows.map(r => toRow(r, now, managerBitrixId));
    rows.sort((a, b) => {
      if ((a.signals.length > 0) !== (b.signals.length > 0)) return a.signals.length > 0 ? -1 : 1;
      if (a.urgency !== b.urgency) return b.urgency - a.urgency;
      return (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
    });
    return rows;
  });
}

// ── Категории клиентов (дополнение Серёги 01.08) ─────────────────────────────
// Именные категории вместо RFM-скоров. Правила читаемые, пороги — в системной
// таблице customer_category_settings (миграция 129, редактор в настройках).
// Классификация — чистая функция ПОВЕРХ кэша движка: правка порога действует
// сразу. «Отгрузка» = delivered_at (шкала отчёта «Повторные»), «покупка» =
// sold_at (шкала этого списка) — сознательно две шкалы, как в самих отчётах.

export type CustomerCategory = 'key' | 'large' | 'regular' | 'once' | 'potential' | 'none';
export type CustomerModifier = 'complex' | 'frequent' | 'fading';

export interface CustomerCategorySettings {
  keyMinShipments: number;
  keyMinSum: number;
  largeMinSum: number;
  largeMinShipments: number;
  complexMinGroups: number;
  frequentFactor: number;
  fadingFactor: number;
}

export const DEFAULT_CATEGORY_SETTINGS: CustomerCategorySettings = {
  keyMinShipments: 2, keyMinSum: 5_000_000,
  largeMinSum: 1_500_000, largeMinShipments: 5,
  complexMinGroups: 3, frequentFactor: 0.5, fadingFactor: 2,
};

export async function fetchCategorySettings(): Promise<CustomerCategorySettings> {
  try {
    const res = await systemDb().query<{
      key_min_shipments: number; key_min_sum: string; large_min_sum: string;
      large_min_shipments: number; complex_min_groups: number;
      frequent_factor: string; fading_factor: string;
    }>('SELECT * FROM customer_category_settings WHERE id = 1');
    const r = res.rows[0];
    if (!r) return DEFAULT_CATEGORY_SETTINGS;
    return {
      keyMinShipments: Number(r.key_min_shipments),
      keyMinSum: Number(r.key_min_sum),
      largeMinSum: Number(r.large_min_sum),
      largeMinShipments: Number(r.large_min_shipments),
      complexMinGroups: Number(r.complex_min_groups),
      frequentFactor: Number(r.frequent_factor),
      fadingFactor: Number(r.fading_factor),
    };
  } catch { return DEFAULT_CATEGORY_SETTINGS; } // таблицы может не быть до миграции 129
}

export function classifyCategory(r: CustomerRow, s: CustomerCategorySettings, now = Date.now()): {
  category: CustomerCategory; modifiers: CustomerModifier[];
} {
  let category: CustomerCategory;
  if (r.dealsDelivered >= s.keyMinShipments && r.sumDelivered >= s.keyMinSum) category = 'key';
  else if (r.sumDelivered >= s.largeMinSum || r.dealsDelivered >= s.largeMinShipments) category = 'large';
  else if (r.dealsSold >= 2) category = 'regular';
  else if (r.dealsSold === 1) category = 'once';
  else if (r.activeCount > 0) category = 'potential';
  else category = 'none';

  const modifiers: CustomerModifier[] = [];
  if (r.distinctGroups >= s.complexMinGroups) modifiers.push('complex');
  // «Частый»: свой (не глобальный) цикл заметно чаще медианы базы.
  if (r.cycleSource === 'own' && r.cycleDays < s.frequentFactor * GLOBAL_REPEAT_CYCLE_DAYS) modifiers.push('frequent');
  // «Затухающий»: частота падает — последний ЗАВЕРШЁННЫЙ интервал или ТЕКУЩАЯ
  // тишина с последней покупки больше fadingFactor × его среднего интервала
  // (текущая тишина включена сознательно: клиент, который «ещё не купил снова»,
  // затухает точно так же — отмечено в отчёте задачи).
  if (r.avgGapDays !== null && r.avgGapDays > 0 && r.lastSoldAt !== null) {
    const silence = (now - new Date(r.lastSoldAt).getTime()) / 86_400_000;
    const worst = Math.max(r.lastGapDays ?? 0, silence);
    if (worst > s.fadingFactor * r.avgGapDays) modifiers.push('fading');
  }
  return { category, modifiers };
}

// ── Отметки клиентов: снуз / «не звонить» / вернуть из спящих (01.08, п.2) ───
// Хранение — системная БД, таблица customer_marks (миграция 123), одна отметка
// на клиента. Отметки применяются ПОВЕРХ кэша движка (свежим запросом): снуз и
// «не звонить» должны действовать сразу, а не через 10 минут TTL.

export type MarkKind = 'snooze' | 'no_call' | 'wake';
export type NoCallReason = 'nothing_needed' | 'competitor' | 'negative' | 'other';

export const NO_CALL_REASON_LABELS: Record<NoCallReason, string> = {
  nothing_needed: 'Ничего не нужно',
  competitor: 'Ушёл к конкуренту',
  negative: 'Негатив',
  other: 'Прочее',
};

export interface CustomerMark {
  kind: MarkKind;
  snoozeUntil: string | null;   // YYYY-MM-DD
  reason: NoCallReason | null;
  comment: string | null;
  createdBy: string;
  createdAt: string;            // ISO
}

export async function fetchCustomerMarks(clientKeys: string[]): Promise<Map<string, CustomerMark>> {
  if (clientKeys.length === 0) return new Map();
  const res = await systemDb().query<{
    client_key: string; kind: MarkKind; snooze_until: string | Date | null;
    reason: NoCallReason | null; comment: string | null; created_by: string; created_at: string | Date;
  }>(
    `SELECT client_key, kind, to_char(snooze_until, 'YYYY-MM-DD') AS snooze_until,
            reason, comment, created_by, created_at
       FROM customer_marks WHERE client_key = ANY($1::text[])`,
    [clientKeys],
  );
  return new Map(res.rows.map(r => [r.client_key, {
    kind: r.kind,
    snoozeUntil: (r.snooze_until as string | null) ?? null,
    reason: r.reason,
    comment: r.comment,
    createdBy: r.created_by,
    createdAt: toIso(r.created_at)!,
  }]));
}

/** Куда попадает клиент с учётом отметки: основной вид / «Спящие» / «Отказались». */
export type CustomerBucket = 'main' | 'sleeping' | 'refused';

export function classifyWithMark(r: CustomerRow, mark: CustomerMark | undefined, todayYmd: string): {
  bucket: CustomerBucket;
  /** Активный снуз: клиент в основном виде, но сигналы/«под угрозой» погашены до даты. */
  snoozedActive: boolean;
} {
  if (mark?.kind === 'no_call') return { bucket: 'refused', snoozedActive: false };
  const snoozedActive = mark?.kind === 'snooze' && mark.snoozeUntil !== null && mark.snoozeUntil >= todayYmd;
  if (snoozedActive) return { bucket: 'main', snoozedActive: true };  // снуз держит клиента на виду
  if (mark?.kind === 'wake') return { bucket: 'main', snoozedActive: false };  // возвращён из спящих
  if (r.sleeping) return { bucket: 'sleeping', snoozedActive: false };
  return { bucket: 'main', snoozedActive: false };
}

export function todayYmdMsk(): string {
  // Дата «сегодня» для сравнения со snooze_until — по Москве (как всё в приложении).
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}

// ── Агрегат для РОПа («Моя команда» из брифа) ────────────────────────────────

export interface TeamCustomerStats {
  bitrixId: number;
  clients: number;
  keyClients: number;       // «Ключевые» (категория key) — дополнение 01.08
  keyAtRisk: number;        // ключевые под угрозой — главный сигнал РОПа
  callNow: number;          // клиентов с любым сигналом
  overdueRepeat: number;    // (а) просроченная повторка
  activeNoCall: number;     // (б) активная сделка без звонка
  refusedNoCall: number;    // «были отказы без звонка»
  regulars: number;         // постоянников всего (2+ успешных сделок)
  regularsAtRisk: number;   // из них «под угрозой» (молчание > 2× цикла)
}

/** Счётчики по подчинённым. Считается из тех же пер-менеджерских списков
 *  (единая логика сигнала, никакого второго SQL), конкурентность ограничена,
 *  чтобы отдел из 15 человек не выжирал пул подключений. */
export async function fetchTeamCustomerStats(managerIds: number[]): Promise<TeamCustomerStats[]> {
  const out: TeamCustomerStats[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < managerIds.length; i += CONCURRENCY) {
    const chunk = managerIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async id => {
      const rows = await fetchManagerCustomers(id);
      // Отметки применяются и здесь: «не звонить»/спящие не должны раздувать
      // РОП-счётчики, снуз гасит сигналы до даты (та же логика, что в списке).
      const marks = await fetchCustomerMarks(rows.map(r => r.clientKey));
      const today = todayYmdMsk();
      const cls = rows.map(r => ({ r, ...classifyWithMark(r, marks.get(r.clientKey), today) }));
      const main = cls.filter(c => c.bucket === 'main').map(c => c.r);
      const live = cls.filter(c => c.bucket === 'main' && !c.snoozedActive).map(c => c.r);
      const catSettings = await fetchCategorySettings();
      const keyRows = main.filter(r => classifyCategory(r, catSettings).category === 'key');
      return {
        bitrixId: id,
        clients: main.length,
        keyClients: keyRows.length,
        // «Ключевой под угрозой» — самый дорогой сигнал: без активных сделок и
        // молчит дольше 2× своего цикла (общий atRisk-предикат, но БЕЗ требования
        // «постоянник» — ключевой определяется отгрузками; снуз гасит, как всё).
        keyAtRisk: keyRows.filter(r => {
          const snoozed = cls.find(c => c.r.clientKey === r.clientKey)?.snoozedActive ?? false;
          if (snoozed || r.activeCount > 0 || r.lastSoldAt === null) return false;
          const since = (Date.now() - new Date(r.lastSoldAt).getTime()) / 86_400_000;
          return since > AT_RISK_CYCLE_MULTIPLIER * r.cycleDays;
        }).length,
        callNow: live.filter(r => r.signals.length > 0).length,
        overdueRepeat: live.filter(r => r.signals.includes('overdue_repeat')).length,
        activeNoCall: live.filter(r => r.signals.includes('active_no_call')).length,
        refusedNoCall: main.filter(r => r.refusedNoCall).length,
        regulars: main.filter(r => r.section === 'regular').length,
        regularsAtRisk: live.filter(r => r.atRisk).length,
      };
    }));
    out.push(...results);
  }
  return out;
}
