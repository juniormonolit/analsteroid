import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';

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
  refused_no_call: boolean;
  last_groups: string[] | null;
  last_sold_amount: string | null;
  last_sold_groups: string[] | null;
  active_deals: {
    dealId: number; name: string | null; stage: string | null; amount: number | null;
    createdAt: string; lastCallAt: string | null;
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
  SELECT d.deal_id, d.deal_name, d.amount, d.created_at, d.sold_at, d.lost_at,
         d.stage_id, d.current_manager_id,
         (CASE WHEN d.funnel_id IN (0,2) THEN 'c'||d.contact_id ELSE 'k'||d.company_id END) AS client_key
  FROM sa.deals d
  WHERE d.funnel_id IN (0,1,2,3)
    AND (CASE WHEN d.funnel_id IN (0,2) THEN d.contact_id ELSE d.company_id END) IS NOT NULL
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
gaps AS (
  SELECT client_key, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap_days
  FROM (
    SELECT client_key,
           EXTRACT(EPOCH FROM sold_at - lag(sold_at) OVER (PARTITION BY client_key ORDER BY sold_at))/86400.0 AS gap
    FROM mcd WHERE sold_at IS NOT NULL
  ) g
  -- Интервалы <1 дня — дробление одного заказа, циклом повторки не считаем
  -- (та же логика, что у глобальной константы GLOBAL_REPEAT_CYCLE_DAYS).
  WHERE gap >= 1 GROUP BY 1
)
SELECT a.client_key,
       a.deals_total::text, a.deals_sold::text, a.sum_sold::text,
       a.last_sold_at, a.last_call_at, ev.last_event_at,
       g.median_gap_days::text, a.refused_no_call,
       o.active_deals, lg.last_groups,
       ls.last_sold_amount::text, ls.last_sold_groups
FROM (
  SELECT m.client_key,
         count(*) AS deals_total,
         count(*) FILTER (WHERE m.sold_at IS NOT NULL) AS deals_sold,
         COALESCE(sum(m.amount) FILTER (WHERE m.sold_at IS NOT NULL), 0) AS sum_sold,
         max(m.sold_at) AS last_sold_at,
         max(dc.last_call_at) AS last_call_at,
         bool_or(m.lost_at IS NOT NULL AND dc.deal_id IS NULL) AS refused_no_call
  FROM mcd m LEFT JOIN deal_calls dc ON dc.deal_id = m.deal_id
  GROUP BY 1
) a
LEFT JOIN opens o USING (client_key)
LEFT JOIN gaps g USING (client_key)
LEFT JOIN lastg lg USING (client_key)
LEFT JOIN lasts ls USING (client_key)
LEFT JOIN ev USING (client_key)
`;

function toRow(r: RawRow, now: number): CustomerRow {
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

  const clientType = r.client_key.startsWith('c') ? 'contact' as const : 'company' as const;
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
    lastGroups: r.last_groups ?? [],
    cycleDays: Math.round(cycleDays * 10) / 10,
    cycleSource: useOwn ? 'own' : 'global',
    signals,
    urgency,
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
  return cached(`customers:mgr:${managerBitrixId}`, 10 * 60, async () => {
    const res = await analyticsDb().query<RawRow>(CUSTOMERS_SQL, [managerBitrixId]);
    const now = Date.now();
    const rows = res.rows.map(r => toRow(r, now));
    rows.sort((a, b) => {
      if ((a.signals.length > 0) !== (b.signals.length > 0)) return a.signals.length > 0 ? -1 : 1;
      if (a.urgency !== b.urgency) return b.urgency - a.urgency;
      return (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
    });
    return rows;
  });
}

// ── Агрегат для РОПа («Моя команда» из брифа) ────────────────────────────────

export interface TeamCustomerStats {
  bitrixId: number;
  clients: number;
  callNow: number;          // клиентов с любым сигналом
  overdueRepeat: number;    // (а) просроченная повторка
  activeNoCall: number;     // (б) активная сделка без звонка
  refusedNoCall: number;    // «были отказы без звонка»
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
      return {
        bitrixId: id,
        clients: rows.length,
        callNow: rows.filter(r => r.signals.length > 0).length,
        overdueRepeat: rows.filter(r => r.signals.includes('overdue_repeat')).length,
        activeNoCall: rows.filter(r => r.signals.includes('active_no_call')).length,
        refusedNoCall: rows.filter(r => r.refusedNoCall).length,
      };
    }));
    out.push(...results);
  }
  return out;
}
