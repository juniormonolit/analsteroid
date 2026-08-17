import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { goodsPositionWhere } from '@/lib/metrics/serviceGroups';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import { periodDateStrFromInstant, type DateRange } from '@/lib/period';
import type { DealScope, ClientType, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';
import { nextBucket, bucketStartOf } from '@/features/reports/lib/periodBuckets';

// ── Раздел «Клиенты» (задача владельца 10.08.2026) ───────────────────────────
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ДВИЖОК, А НЕ МЕТРИКИ КОНСТРУКТОРА. Две причины, обе жёсткие.
//
// 1. COUNT(DISTINCT contact_id) НЕЛЬЗЯ СКЛАДЫВАТЬ. Обычные collected-метрики
//    считаются в разрезе (измерение × воронка) — funnel_id нужен, чтобы пилюли
//    «Первичные/Повторные/Б2Б/Б2С» фильтровались постфактум, без перезапроса, —
//    а потом строки по воронкам СУММИРУЮТСЯ. Для суммы и count(*) это верно, для
//    DISTINCT — нет: клиент, купивший в двух воронках, посчитается дважды.
//    Замер на живых данных (июль 2026): честно 2 078 клиентов, суммой по
//    воронкам 2 256 (+8,6 %), а в строке отдельного менеджера #1930 — 32 против
//    44 (+37 %). Ровно поэтому старые метрики этой семьи (`all_clients_delivered`,
//    `repeat_clients_delivered`, `complex_clients`, ТЗ #1725) помечены «служебная,
//    скрыта» и живут только внутри формул, где числитель и знаменатель завышены
//    одинаково и доля выживает. Здесь пилюли применяются В SQL, до агрегации,
//    поэтому DISTINCT честный и метрику можно показывать саму по себе.
//
// 2. Товарные группы лежат в `products` (jsonb), а конструктор умеет только
//    «одна агрегатная функция по одному полю сделки». Среднее число групп на
//    заказ/клиента и «комплексность» через него невыразимы — метрики
//    `avg_groups_per_client`, `avg_groups_per_order`, `avg_products_per_order`
//    были объявлены в каталоге ещё по ТЗ #1725, но движка не получили и всё это
//    время отдавали пустые колонки.
//
// ПРАВИЛО СЕРВИСНЫХ ГРУПП (владелец, 10.08.2026). Перевозка, аренда спецтехники,
// «для логистов», служебная, «ошибка» — не покупка категории (список и обоснование:
// lib/metrics/serviceGroups.ts). Отсюда:
//   * «сделка по газобетону + доставка» — это ОДНА товарная группа, а не две;
//   * сделка, где кроме сервисных позиций ничего нет (582 отгрузки на проде), —
//     вообще не заказ: не делает клиента новым и не попадает в знаменатели;
//   * считаем ПО ПОЗИЦИЯМ, а не по `deals.head_group_name`: главная группа — одна
//     на сделку и выбирается по наибольшей сумме, из-за чего 473 отгрузки с
//     реальным товаром подписаны «Перевозка» (доставка вышла дороже товара).

/** Ключ строки «Итого» в возвращаемой карте — тот же приём, что в callsMetrics.ts:
 *  общий итог считается ТЕМ ЖЕ запросом (GROUPING SETS), а не суммой строк, потому
 *  что DISTINCT-метрики по строкам не складываются. */
export const CLIENTS_GRAND_TOTAL_KEY = '__grand_total__';

/** Измерение строки отчёта.
 *
 *  'product-group' привязывает сделку к ОДНОЙ главной группе (product_group_id
 *  или head_group_name — как в byProductGroups.ts), а не ко всем группам её
 *  позиций. Иначе сделка попала бы в несколько строк сразу и суммы/заказы
 *  задвоились бы. Клиент при этом честно считается в каждой группе, где он
 *  покупал, — это то же поведение, что и у менеджеров, и «Итого» по-прежнему
 *  берётся из общего итога движка, а не суммой строк. */
export type ClientMetricsDimension = 'manager' | 'product-group' | 'period' | 'client' | 'none';

export interface ClientMetricsRow {
  /** Уникальные клиенты с товарной отгрузкой в периоде. */
  clientsTotal: number;
  /** Из них те, у кого эта отгрузка — первая товарная за всю историю. */
  newClients: number;
  /** Клиенты периода, у которых в периоде есть НЕпервая (в их истории) отгрузка.
      Может пересекаться с newClients: новый клиент, купивший в периоде дважды, —
      и новый, и повторный. Это сознательно: «повторные = все − новые» на периоде
      «всё время» давало ноль (первая покупка каждого — внутри периода). */
  repeatClients: number;
  /** Клиенты, чья ВТОРАЯ товарная отгрузка (первая повторная) попала в период. */
  firstRepeatClients: number;
  /** Товарные отгрузки периода (заказы). */
  orders: number;
  /** Сумма первых товарных отгрузок клиентов. */
  newAmount: number;
  /** Сумма всех прочих товарных отгрузок (вторая и далее по истории клиента). */
  repeatAmount: number;
  /** Клиенты с отгрузкой в периоде, у которых за историю ≥2 разных товарных группы. */
  complexClients: number;
  /** Среднее число разных товарных групп на клиента (по всей истории его отгрузок). */
  groupsPerClient: number | null;
  /** Среднее число разных товарных групп в одном заказе периода. */
  groupsPerOrder: number | null;
  /** Среднее число товарных позиций в одном заказе периода. */
  productsPerOrder: number | null;
  /** Медиана дней от created_at до delivered_at по заказам периода. */
  medianCycleDays: number | null;
  /** Медиана месяцев жизни клиента (первая заявка → последняя отгрузка). */
  medianLifetimeMonths: number | null;
  /** Клиентские метрики (в сущности «Клиент» — значение клиента, в остальных —
   *  медиана по клиентам строки). */
  daysSinceLast: number | null;
  orderFreqDays: number | null;
  clientLtv: number | null;
  clientCats: number | null;
  churnRiskPct: number | null;
}

/** id метрик каталога, которые заполняет этот движок (миграции 171 и 172). Роут
 *  по этому списку решает, звать ли движок вообще. */
export const CLIENT_METRIC_IDS = [
  'new_clients_count', 'all_clients_delivered', 'repeat_clients_delivered',
  'delivered_deals_count', 'new_clients_amount', 'repeat_clients_amount',
  'complex_clients', 'avg_groups_per_client', 'avg_groups_per_order',
  'avg_products_per_order',
  // Вторая пачка (миграция 172) — медианные времена между заказами.
  'median_time_to_2nd', 'median_time_between_orders',
  'median_time_to_2nd_diff_cat', 'median_time_between_orders_diff_cat',
  // Третья пачка (миграция 173) — обзвон после отгрузки.
  'followup_clients_due', 'followup_clients_called',
  // Четвёртая пачка (миграция 174): времена — базовым запросом, LTV — когортным.
  'median_cycle_time_days', 'median_client_lifetime_months',
  // Пятая пачка: первая повторная — базовым, активные 90 дн — своим запросом.
  'first_repeat_clients', 'active_clients_90d',
  'cohort_repeat_clients', 'cohort_first_revenue',
  'cohort_repeat_revenue_30', 'cohort_repeat_revenue_60', 'cohort_repeat_revenue_90',
  'cohort_repeat_revenue_180', 'cohort_repeat_revenue_360', 'cohort_ltv_total_revenue',
] as const;

/** Метрики второй пачки считаются отдельным запросом (своя популяция — интервалы,
 *  а не сделки), поэтому у роута есть способ спросить только их. */
export const CLIENT_TIME_METRIC_IDS = [
  'median_time_to_2nd', 'median_time_between_orders',
  'median_time_to_2nd_diff_cat', 'median_time_between_orders_diff_cat',
] as const;

/** Значения движка → метрики каталога. Пустая строка среза (клиент есть в отчёте,
 *  но товарных отгрузок в периоде нет) даёт нули, а не null: «не было продаж» —
 *  это ноль, а пустая ячейка читается как «не посчитали». Средние — null, у них
 *  при нуле заказов нет значения. */
export function clientMetricsToRecord(row: ClientMetricsRow | undefined): Record<string, number | null> {
  if (!row) {
    return {
      new_clients_count: 0, all_clients_delivered: 0, repeat_clients_delivered: 0,
      first_repeat_clients: 0,
      delivered_deals_count: 0, new_clients_amount: 0, repeat_clients_amount: 0,
      complex_clients: 0, avg_groups_per_client: null, avg_groups_per_order: null,
      avg_products_per_order: null, median_cycle_time_days: null, median_client_lifetime_months: null,
      client_days_since_last: null, client_order_frequency_days: null, client_ltv: null,
      client_categories_count: null, client_churn_risk_pct: null,
    };
  }
  return {
    new_clients_count: row.newClients,
    all_clients_delivered: row.clientsTotal,
    // Повторные — НЕ остаток «все − новые» (тот на «всём времени» давал ноль:
    // первая покупка каждого клиента лежит внутри периода). Клиент повторный,
    // если в периоде есть его непервая отгрузка; с новыми может пересекаться.
    repeat_clients_delivered: row.repeatClients,
    first_repeat_clients: row.firstRepeatClients,
    delivered_deals_count: row.orders,
    new_clients_amount: row.newAmount,
    repeat_clients_amount: row.repeatAmount,
    complex_clients: row.complexClients,
    avg_groups_per_client: row.groupsPerClient,
    avg_groups_per_order: row.groupsPerOrder,
    avg_products_per_order: row.productsPerOrder,
    median_cycle_time_days: row.medianCycleDays,
    median_client_lifetime_months: row.medianLifetimeMonths,
    client_days_since_last: row.daysSinceLast,
    client_order_frequency_days: row.orderFreqDays,
    client_ltv: row.clientLtv,
    client_categories_count: row.clientCats,
    client_churn_risk_pct: row.churnRiskPct,
  };
}

export interface ClientMetricsOptions {
  period: DateRange;
  dimension: ClientMetricsDimension;
  /** Для dimension='period' — шаг бакета (день/неделя/месяц/квартал/год). */
  periodUnit?: string;
  dealScope?: DealScope;
  clientType?: ClientType;
  /** Ограничение по менеджерам (отдел + тип аккаунта уже разрешены вызывающим). */
  managerIds?: string[];
  /** Фильтр отделов — для разрезов, где строки не менеджеры и список id вывести
   *  неоткуда (товарные группы). Резолвится в менеджеров тем же запросом, что в
   *  byProductGroups.ts. */
  departmentIds?: string[];
  /** Шкала товарных групп для dimension='product-group'. */
  productGroupMode?: 'kc' | 'by_max';
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  dealFilters?: DealFilter[];
}

const MSK = 'Europe/Moscow';

// Воронки 4/7 исключены — так же, как в старой семье метрик этого раздела
// (описания `all_clients_delivered` и др.): это служебные воронки, не продажи.
const EXCLUDED_FUNNELS = '(4, 7)';

/** Условие пилюль «Первичные/Повторные» и «Б2Б/Б2С» — в SQL, а не постфактум
 *  (см. причину 1 в шапке файла). */
function pillWhere(dealScope: DealScope, clientType: ClientType): string {
  const parts: string[] = [];
  if (dealScope === 'primary') parts.push(`d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)`);
  else if (dealScope === 'repeat') parts.push(`d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)`);
  if (clientType === 'b2c') parts.push(`d.funnel_id IN (0, 2)`);
  else if (clientType === 'b2b') parts.push(`d.funnel_id IN (1, 3)`);
  return parts.join(' AND ');
}

function dimExprOf(opts: ClientMetricsOptions): string {
  if (opts.dimension === 'manager') return 'd.current_manager_id::text';
  // Сущность «Клиент» (задача 10.08): строка отчёта — сам клиент.
  if (opts.dimension === 'client') return 'd.contact_id::text';
  if (opts.dimension === 'product-group') {
    // Те же выражения, что в byProductGroups.ts, — иначе строки не совпадут с
    // остальными колонками того же отчёта.
    return (opts.productGroupMode ?? 'kc') === 'by_max'
      ? `COALESCE(d.head_group_name, 'Без группы')`
      : `COALESCE(d.product_group_id::text, '__none__')`;
  }
  if (opts.dimension === 'period') {
    const unit = ['day', 'week', 'month', 'quarter', 'year'].includes(opts.periodUnit ?? '')
      ? opts.periodUnit : 'month';
    return `to_char(date_trunc('${unit}', (d.delivered_at AT TIME ZONE '${MSK}')), 'YYYY-MM-DD')`;
  }
  return `'${CLIENTS_GRAND_TOTAL_KEY}'`;
}

/** Менеджеры, которыми ограничен срез. Если строки — не менеджеры (товарные
 *  группы, периоды), список вывести неоткуда, и фильтр отделов резолвится здесь
 *  тем же запросом, что в byProductGroups.ts. Оргструктура — из sa, НЕ из YC
 *  system (задача 2065: YC-копия протухла). */
async function resolveScope(opts: ClientMetricsOptions): Promise<{ managerIds: string[]; deptEmpty: boolean }> {
  const managerIds = (opts.managerIds ?? []).filter(id => /^\d+$/.test(id));
  const deptIds = opts.departmentIds ?? [];
  if (managerIds.length || !deptIds.length) return { managerIds, deptEmpty: false };
  const res = await analyticsDb().query<{ bitrix_user_id: string }>(
    `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
       FROM sa.org_resolved_hierarchy orh
      WHERE orh.department_id IN (
        SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
      ) AND orh.is_active = true`,
    [deptIds],
  );
  const ids = res.rows.map(r => r.bitrix_user_id).filter(id => /^\d+$/.test(id));
  // Отдел без единого менеджера — честный ноль, а не молча снятый фильтр.
  return { managerIds: ids, deptEmpty: ids.length === 0 };
}

/** Общий кусок WHERE: сделки периода, прошедшие фильтры отчёта. Вынесен, потому
 *  что нужен обоим запросам движка (метрики по сделкам и медианные времена). */
function periodWhere(opts: ClientMetricsOptions, managerIds: string[], deptEmpty: boolean, dfSql: string): string {
  const where: string[] = [
    `d.delivered_at >= $1`,
    `d.delivered_at < $2`,
    `d.contact_id IS NOT NULL`,
    `d.funnel_id NOT IN ${EXCLUDED_FUNNELS}`,
  ];
  if (opts.dimension === 'manager') where.push('d.current_manager_id IS NOT NULL');
  if (deptEmpty) where.push('1=0');
  else if (managerIds.length) where.push(`d.current_manager_id IN (${managerIds.join(',')})`);
  const pills = pillWhere(opts.dealScope ?? 'all', opts.clientType ?? 'all');
  if (pills) where.push(pills);
  const offh = [
    createdTimeWhere('d', opts.createdTimeFilter ?? 'all'),
    firstTouchWhere('d', opts.firstTouchFilter ?? 'all'),
    dfSql,
  ].filter(Boolean).join(' AND ');
  if (offh) where.push(offh);
  return where.join('\n     AND ');
}

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Значения метрик раздела «Клиенты» по строкам среза + общий итог под ключом
 * CLIENTS_GRAND_TOTAL_KEY. Итог считается ТЕМ ЖЕ запросом (GROUPING SETS), а не
 * суммированием строк: клиент, купивший у двух менеджеров, — один клиент в итоге
 * и по одному в каждой строке, и это не ошибка, а разные вопросы.
 */
export async function fetchClientMetrics(
  opts: ClientMetricsOptions,
): Promise<Map<string, ClientMetricsRow>> {
  const dealScope = opts.dealScope ?? 'all';
  const clientType = opts.clientType ?? 'all';
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();

  const { managerIds, deptEmpty } = await resolveScope(opts);
  const df = buildDealFilterWhere(opts.dealFilters);
  const where = periodWhere(opts, managerIds, deptEmpty, df.sql).split('\n     AND ');

  const goods = goodsPositionWhere('p');
  const dimExpr = dimExprOf(opts);

  // Одна «широкая» выборка сделок периода + два справочника по истории клиента
  // (первая товарная отгрузка и число разных групп за всю историю). Справочники
  // считаются ПО ВСЕЙ истории и не зависят от периода — иначе «первая покупка»
  // означала бы «первая внутри периода», и в июле новым оказался бы клиент,
  // купивший в мае.
  const sql = `
WITH deal_goods AS (
  SELECT d.deal_id,
         ${dimExpr} AS dim_id,
         d.contact_id,
         d.amount,
         (SELECT count(DISTINCT (p->>'head_group_id'))
            FROM jsonb_array_elements(d.products) p WHERE ${goods}) AS groups_cnt,
         (SELECT count(*)
            FROM jsonb_array_elements(d.products) p WHERE ${goods}) AS items_cnt,
         -- «Время от заявки до отгрузки» (4-я пачка): дни между created_at и
         -- delivered_at ЭТОЙ сделки — метрика уровня сделки, медиана в deal_dim.
         EXTRACT(EPOCH FROM (d.delivered_at - d.created_at)) / 86400.0 AS cycle_days
    FROM deals d
   WHERE ${where.join('\n     AND ')}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
),
-- История клиента считается ТОЛЬКО для клиентов, попавших в период (см.
-- period_clients ниже). Без этого ограничения оба справочника разворачивают
-- jsonb по всем 233 тыс. сделок истории, и запрос занимает 6,6 с вместо 0,23 —
-- при том что клиентов периода обычно пара тысяч из двадцати. Смысл не
-- меняется: значения нужны ровно по этим клиентам.
period_clients AS (SELECT DISTINCT contact_id FROM deal_goods),
first_goods AS (
  SELECT d.contact_id, min(d.delivered_at) AS first_at
    FROM sa.deals d
   WHERE d.delivered_at IS NOT NULL
     AND d.contact_id IN (SELECT contact_id FROM period_clients)
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
   GROUP BY 1
),
client_groups AS (
  SELECT d.contact_id, count(DISTINCT (p->>'head_group_id')) AS groups_cnt
    FROM sa.deals d, jsonb_array_elements(d.products) p
   WHERE d.delivered_at IS NOT NULL
     AND d.contact_id IN (SELECT contact_id FROM period_clients)
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND ${goods}
   GROUP BY 1
),
ranked AS (
  -- Порядковый номер отгрузки в истории клиента: rn=2 — «первая повторная».
  -- «Повторно купившие» (5-я пачка): клиент, чья ВТОРАЯ товарная отгрузка
  -- попала в период (не путать с repeat_clients_delivered — там любая повторная).
  SELECT d.deal_id,
         row_number() OVER (PARTITION BY d.contact_id ORDER BY d.delivered_at, d.deal_id) AS rn
    FROM sa.deals d
   WHERE d.delivered_at IS NOT NULL
     AND d.contact_id IN (SELECT contact_id FROM period_clients)
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
),
client_bounds AS (
  -- История клиента одним проходом: «Время жизни» (первая created_at любой
  -- сделки → последняя товарная отгрузка) + опоры клиентских метрик сущности
  -- «Клиент» (первая/последняя отгрузка, счётчик отгрузок, LTV за всю историю).
  SELECT d.contact_id,
         min(d.created_at) AS first_created,
         max(d.delivered_at) FILTER (WHERE d.delivered_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})) AS last_deliv,
         min(d.delivered_at) FILTER (WHERE d.delivered_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})) AS first_deliv,
         count(*) FILTER (WHERE d.delivered_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})) AS n_ships,
         COALESCE(sum(d.amount) FILTER (WHERE d.delivered_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})), 0) AS ltv_sum
    FROM sa.deals d
   WHERE d.contact_id IN (SELECT contact_id FROM period_clients)
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
   GROUP BY 1
),
src AS (
  SELECT dg.dim_id, dg.contact_id, dg.amount, dg.groups_cnt, dg.items_cnt, dg.cycle_days,
         (f.first_at >= $1::timestamptz AND f.first_at < $2::timestamptz) AS is_new,
         COALESCE(c.groups_cnt, 0) AS client_groups,
         -- месяцы по 30.44 дн — как в исходном определении median_client_lifetime_months
         EXTRACT(EPOCH FROM (cb.last_deliv - cb.first_created)) / 86400.0 / 30.44 AS lifetime_months,
         (rk.rn = 2) AS is_first_repeat,
         -- «Повторная покупка» на уровне СДЕЛКИ: отгрузка не первая в истории
         -- клиента. Баг-репорт владельца 11.08 («Менеджеры — Repeat Rate: по всем
         -- менеджерам за всё время нули»): прежнее «повторные = все клиенты − новые»
         -- на периоде «всё время» давало гарантированный ноль — первая покупка
         -- КАЖДОГО клиента лежит внутри такого периода, все клиенты «новые».
         COALESCE(rk.rn >= 2, false) AS is_repeat_deal,
         -- Клиентские метрики сущности «Клиент» (миграция 175):
         EXTRACT(EPOCH FROM (now() - cb.last_deliv)) / 86400.0 AS days_since_last,
         CASE WHEN cb.n_ships >= 2
              THEN EXTRACT(EPOCH FROM (cb.last_deliv - cb.first_deliv)) / 86400.0 / (cb.n_ships - 1)
              ELSE NULL END AS order_freq_days,
         cb.ltv_sum AS client_ltv
    FROM deal_goods dg
    LEFT JOIN first_goods   f  ON f.contact_id  = dg.contact_id
    LEFT JOIN client_groups c  ON c.contact_id  = dg.contact_id
    LEFT JOIN client_bounds cb ON cb.contact_id = dg.contact_id
    LEFT JOIN ranked        rk ON rk.deal_id    = dg.deal_id
),
-- Две ступени агрегации, и это принципиально. Заказы/суммы/средние по заказу
-- считаются ПО СДЕЛКАМ, а клиенты/комплексность/группы на клиента — сначала
-- сворачиваются ПО КЛИЕНТУ (клиент с десятью заказами весит столько же, сколько
-- клиент с одним), и только потом усредняются.
pc_dim  AS (SELECT dim_id, contact_id, bool_or(is_new) AS is_new, bool_or(is_repeat_deal) AS is_repeat, bool_or(is_first_repeat) AS is_first_repeat, max(client_groups) AS cg, max(lifetime_months) AS lifetime, max(days_since_last) AS dsl, max(order_freq_days) AS freq, max(client_ltv) AS ltv FROM src GROUP BY 1, 2),
pc_all  AS (SELECT contact_id, bool_or(is_new) AS is_new, bool_or(is_repeat_deal) AS is_repeat, bool_or(is_first_repeat) AS is_first_repeat, max(client_groups) AS cg, max(lifetime_months) AS lifetime, max(days_since_last) AS dsl, max(order_freq_days) AS freq, max(client_ltv) AS ltv FROM src GROUP BY 1),
deal_dim AS (
  -- Суммы «новые/повторные» — по СДЕЛКЕ (первая покупка клиента / повторная), а не
  -- по новизне клиента: прежний FILTER (WHERE is_new) на «всём времени» относил
  -- ВСЮ выручку к новым (повторные — ноль), та же болезнь, что у счётчика выше.
  SELECT dim_id, count(*) AS orders,
         COALESCE(SUM(amount) FILTER (WHERE NOT is_repeat_deal), 0) AS new_amount,
         COALESCE(SUM(amount) FILTER (WHERE is_repeat_deal), 0)     AS repeat_amount,
         AVG(groups_cnt) AS groups_per_order, AVG(items_cnt) AS products_per_order,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY cycle_days) AS median_cycle
    FROM src GROUP BY 1),
deal_all AS (
  SELECT count(*) AS orders,
         COALESCE(SUM(amount) FILTER (WHERE NOT is_repeat_deal), 0) AS new_amount,
         COALESCE(SUM(amount) FILTER (WHERE is_repeat_deal), 0)     AS repeat_amount,
         AVG(groups_cnt) AS groups_per_order, AVG(items_cnt) AS products_per_order,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY cycle_days) AS median_cycle
    FROM src),
client_dim AS (
  SELECT dim_id, count(*) AS clients_total,
         count(*) FILTER (WHERE is_new)  AS new_clients,
         count(*) FILTER (WHERE is_repeat) AS repeat_clients,
         count(*) FILTER (WHERE is_first_repeat) AS first_repeat_clients,
         count(*) FILTER (WHERE cg >= 2) AS complex_clients,
         AVG(cg) AS groups_per_client,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY lifetime) AS median_lifetime,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY dsl)  AS med_dsl,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY freq) AS med_freq,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ltv)  AS med_ltv,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY cg)   AS med_cats,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (CASE WHEN freq > 0 THEN dsl / freq * 100 END)) AS med_risk
    FROM pc_dim GROUP BY 1),
client_all AS (
  SELECT count(*) AS clients_total,
         count(*) FILTER (WHERE is_new)  AS new_clients,
         count(*) FILTER (WHERE is_repeat) AS repeat_clients,
         count(*) FILTER (WHERE is_first_repeat) AS first_repeat_clients,
         count(*) FILTER (WHERE cg >= 2) AS complex_clients,
         AVG(cg) AS groups_per_client,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY lifetime) AS median_lifetime,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY dsl)  AS med_dsl,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY freq) AS med_freq,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ltv)  AS med_ltv,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY cg)   AS med_cats,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (CASE WHEN freq > 0 THEN dsl / freq * 100 END)) AS med_risk
    FROM pc_all)
SELECT d.dim_id, c.clients_total, c.new_clients, c.repeat_clients, c.first_repeat_clients, d.orders, d.new_amount, d.repeat_amount,
       c.complex_clients, c.groups_per_client, d.groups_per_order, d.products_per_order,
       d.median_cycle, c.median_lifetime,
       c.med_dsl, c.med_freq, c.med_ltv, c.med_cats, c.med_risk
  FROM deal_dim d JOIN client_dim c ON c.dim_id IS NOT DISTINCT FROM d.dim_id
UNION ALL
SELECT '${CLIENTS_GRAND_TOTAL_KEY}', c.clients_total, c.new_clients, c.repeat_clients, c.first_repeat_clients, d.orders, d.new_amount,
       d.repeat_amount, c.complex_clients, c.groups_per_client, d.groups_per_order, d.products_per_order,
       d.median_cycle, c.median_lifetime,
       c.med_dsl, c.med_freq, c.med_ltv, c.med_cats, c.med_risk
  FROM deal_all d CROSS JOIN client_all c
`;

  const key = [
    fromIso, toExclIso, opts.dimension, opts.periodUnit ?? '-', opts.productGroupMode ?? '-',
    dealScope, clientType,
    deptEmpty ? 'none' : (managerIds.length ? managerIds.join(',') : 'all'),
    `${opts.createdTimeFilter ?? 'all'}:${opts.firstTouchFilter ?? 'all'}|df:${df.key}`,
  ].join('|');

  const rows = await cached(`rpt:clients:${key}`, reportTtl(toExclIso), async () => {
    const res = await analyticsDb().query<Record<string, unknown>>(sql, [fromIso, toExclIso]);
    return res.rows;
  });

  const out = new Map<string, ClientMetricsRow>();
  for (const r of rows) {
    out.set(String(r.dim_id), {
      clientsTotal: num(r.clients_total),
      newClients: num(r.new_clients),
      repeatClients: num(r.repeat_clients),
      firstRepeatClients: num(r.first_repeat_clients),
      orders: num(r.orders),
      newAmount: num(r.new_amount),
      repeatAmount: num(r.repeat_amount),
      complexClients: num(r.complex_clients),
      groupsPerClient: numOrNull(r.groups_per_client),
      groupsPerOrder: numOrNull(r.groups_per_order),
      productsPerOrder: numOrNull(r.products_per_order),
      medianCycleDays: numOrNull(r.median_cycle),
      medianLifetimeMonths: numOrNull(r.median_lifetime),
      daysSinceLast: numOrNull(r.med_dsl),
      orderFreqDays: numOrNull(r.med_freq),
      clientLtv: numOrNull(r.med_ltv),
      clientCats: numOrNull(r.med_cats),
      churnRiskPct: numOrNull(r.med_risk),
    });
  }
  return out;
}

// ── Вторая пачка: медианные времена между заказами (задача владельца 10.08) ──
//
// ЧТО ТАКОЕ «ЗАКАЗ». Владелец: «не учитывать интервал 1 день между заказами, то
// есть считать такие заказы как 1 заказ». Поэтому отгрузки, идущие не дальше
// суток друг от друга, склеиваются в ОДИН заказ, и время заказа — время первой
// отгрузки склейки. Склейка цепная (0:00, +20ч, +20ч — это один заказ длиной
// 40 часов, а не три): классическая задача «островов», решается через флаг
// разрыва + бегущую сумму. Важно, что это именно склейка, а не выбрасывание
// коротких интервалов: при отгрузках 1-го, 1-го и 11-го числа ответ 10 дней,
// а не 9,5.
//
// ЧТО ТАКОЕ «ДРУГАЯ ТОВАРНАЯ ГРУППА». Заказ считается «новой категорией», если
// он принёс клиенту группу, которой в его прошлых заказах не было. Определяется
// без рекурсии: для пары (клиент, группа) берём НОМЕР ПЕРВОГО заказа, где она
// встретилась; заказ «новый по категории», если он и есть этот первый для
// какой-то своей группы. Сервисные группы, как и везде в разделе, не считаются.
// «Время до второго заказа другой группы» — это первый интервал такой цепочки,
// «время между заказами разных групп» — все её интервалы.
//
// ПРИВЯЗКА К ПЕРИОДУ И СТРОКЕ. Интервал относится к тому периоду/менеджеру/
// товарной группе, где стоит ЗАКРЫВАЮЩИЙ его заказ (поздний из пары) — только
// такая привязка делает метрику периодной: «сколько ждали те, кто вернулся в
// июле». История при этом читается целиком, иначе первый заказ клиента,
// сделанный до периода, потерялся бы и интервал не с чем было бы считать.
//
// МЕДИАНА, А НЕ СРЕДНЕЕ — хвост длинных возвратов задирает среднее. Медиана не
// складывается, поэтому «Итого» считается percentile'ем по ВСЕЙ совокупности
// интервалов тем же запросом (GROUPING SETS), а не усреднением строк.

export interface ClientTimeMetricsRow {
  /** Медиана дней между 1-м и 2-м заказом. */
  toSecond: number | null;
  /** Медиана дней между всеми соседними заказами. */
  betweenAll: number | null;
  /** Медиана дней до первого заказа с новой для клиента товарной группой. */
  toSecondDiffCat: number | null;
  /** Медиана дней между заказами, приносящими новые группы. */
  betweenAllDiffCat: number | null;
}

export function clientTimeMetricsToRecord(row: ClientTimeMetricsRow | undefined): Record<string, number | null> {
  return {
    median_time_to_2nd: row?.toSecond ?? null,
    median_time_between_orders: row?.betweenAll ?? null,
    median_time_to_2nd_diff_cat: row?.toSecondDiffCat ?? null,
    median_time_between_orders_diff_cat: row?.betweenAllDiffCat ?? null,
  };
}

export async function fetchClientTimeMetrics(
  opts: ClientMetricsOptions,
): Promise<Map<string, ClientTimeMetricsRow>> {
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();
  const { managerIds, deptEmpty } = await resolveScope(opts);
  const df = buildDealFilterWhere(opts.dealFilters);
  const goods = goodsPositionWhere('p');
  const dimExpr = dimExprOf(opts);
  const where = periodWhere(opts, managerIds, deptEmpty, df.sql);

  const sql = `
WITH period_deals AS (
  SELECT d.deal_id, d.contact_id
    FROM deals d
   WHERE ${where}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
),
hist AS (
  SELECT d.deal_id, d.contact_id, d.delivered_at
    FROM sa.deals d
   WHERE d.delivered_at IS NOT NULL
     AND d.contact_id IN (SELECT contact_id FROM period_deals)
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
),
flagged AS (
  SELECT h.*,
         CASE WHEN lag(h.delivered_at) OVER w IS NULL
                OR h.delivered_at - lag(h.delivered_at) OVER w > interval '1 day'
              THEN 1 ELSE 0 END AS starts_order
    FROM hist h
  WINDOW w AS (PARTITION BY h.contact_id ORDER BY h.delivered_at)
),
numbered AS (
  SELECT f.*,
         sum(f.starts_order) OVER (PARTITION BY f.contact_id ORDER BY f.delivered_at
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ord_no
    FROM flagged f
),
orders AS (
  SELECT contact_id, ord_no, min(delivered_at) AS at,
         (array_agg(deal_id ORDER BY delivered_at))[1] AS lead_deal_id
    FROM numbered GROUP BY 1, 2
),
order_dim AS (
  SELECT o.contact_id, o.ord_no, o.at, ${dimExpr} AS dim_id,
         (o.lead_deal_id IN (SELECT deal_id FROM period_deals)) AS lead_in_report
    FROM orders o JOIN sa.deals d ON d.deal_id = o.lead_deal_id
),
seq AS (
  SELECT od.*, lag(od.at) OVER (PARTITION BY od.contact_id ORDER BY od.ord_no) AS prev_at,
         row_number() OVER (PARTITION BY od.contact_id ORDER BY od.ord_no) AS rn
    FROM order_dim od
),
all_intervals AS (
  SELECT dim_id, rn, EXTRACT(EPOCH FROM (at - prev_at)) / 86400.0 AS days
    FROM seq
   WHERE prev_at IS NOT NULL AND at >= $1 AND at < $2 AND lead_in_report
),
order_groups AS (
  SELECT n.contact_id, n.ord_no, (p->>'head_group_id') AS grp
    FROM numbered n
    JOIN sa.deals d ON d.deal_id = n.deal_id,
         jsonb_array_elements(d.products) p
   WHERE ${goods}
   GROUP BY 1, 2, 3
),
first_group_order AS (
  SELECT contact_id, grp, min(ord_no) AS first_ord FROM order_groups GROUP BY 1, 2
),
new_cat_orders AS (
  SELECT DISTINCT og.contact_id, og.ord_no
    FROM order_groups og
    JOIN first_group_order f
      ON f.contact_id = og.contact_id AND f.grp = og.grp AND f.first_ord = og.ord_no
),
cat_seq AS (
  SELECT od.dim_id, od.at, od.lead_in_report,
         lag(od.at) OVER (PARTITION BY od.contact_id ORDER BY od.ord_no) AS prev_at,
         row_number() OVER (PARTITION BY od.contact_id ORDER BY od.ord_no) AS rn
    FROM order_dim od
    JOIN new_cat_orders nc ON nc.contact_id = od.contact_id AND nc.ord_no = od.ord_no
),
cat_intervals AS (
  SELECT dim_id, rn, EXTRACT(EPOCH FROM (at - prev_at)) / 86400.0 AS days
    FROM cat_seq
   WHERE prev_at IS NOT NULL AND at >= $1 AND at < $2 AND lead_in_report
),
agg_all AS (
  -- COALESCE, а не NULL из GROUPING SETS: Postgres не умеет FULL JOIN по
  -- IS NOT DISTINCT FROM («only supported with merge-joinable conditions»),
  -- поэтому итоговая строка получает явный ключ и джойнится обычным равенством.
  SELECT COALESCE(dim_id, '${CLIENTS_GRAND_TOTAL_KEY}') AS dim_id,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY days) FILTER (WHERE rn = 2) AS to_second,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY days)                       AS between_all
    FROM all_intervals GROUP BY GROUPING SETS ((dim_id), ())
),
agg_cat AS (
  SELECT COALESCE(dim_id, '${CLIENTS_GRAND_TOTAL_KEY}') AS dim_id,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY days) FILTER (WHERE rn = 2) AS to_second_cat,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY days)                       AS between_all_cat
    FROM cat_intervals GROUP BY GROUPING SETS ((dim_id), ())
)
SELECT COALESCE(a.dim_id, c.dim_id) AS dim_id,
       a.to_second, a.between_all, c.to_second_cat, c.between_all_cat
  FROM agg_all a FULL JOIN agg_cat c ON c.dim_id = a.dim_id
`;

  const key = [
    'time', fromIso, toExclIso, opts.dimension, opts.periodUnit ?? '-', opts.productGroupMode ?? '-',
    opts.dealScope ?? 'all', opts.clientType ?? 'all',
    deptEmpty ? 'none' : (managerIds.length ? managerIds.join(',') : 'all'),
    `${opts.createdTimeFilter ?? 'all'}:${opts.firstTouchFilter ?? 'all'}|df:${df.key}`,
  ].join('|');

  const rows = await cached(`rpt:clients:${key}`, reportTtl(toExclIso), async () => {
    const res = await analyticsDb().query<Record<string, unknown>>(sql, [fromIso, toExclIso]);
    return res.rows;
  });

  const out = new Map<string, ClientTimeMetricsRow>();
  for (const r of rows) {
    out.set(String(r.dim_id), {
      toSecond: numOrNull(r.to_second),
      betweenAll: numOrNull(r.between_all),
      toSecondDiffCat: numOrNull(r.to_second_cat),
      betweenAllDiffCat: numOrNull(r.between_all_cat),
    });
  }
  return out;
}

// ── Третья пачка: обзвон после отгрузки (задача владельца 10.08) ─────────────
//
// Гипотеза владельца: клиенту нужно позвонить вскоре после отгрузки. Метрики
// отвечают на два вопроса — скольким ДОЛЖНЫ были позвонить и скольким позвонили.
//
// ОКНО — ДВЕ НЕДЕЛИ ОТ ОТГРУЗКИ, фиксированное (владелец 10.08 отказался от
// настраиваемого интервала: «просто посчитаем сколько должны были получить
// звонок в течение 2х недель»). Одна константа ниже — менять здесь.
//
// ТРИ РЕШЕНИЯ, КОТОРЫЕ ПРИШЛОСЬ ПРИНЯТЬ (все продублированы в описаниях метрик,
// миграция 173):
//
// 1. «После ПОСЛЕДНЕЙ отгрузки»: обязанность возникает, только если до конца
//    окна клиент не отгрузился снова. Вернулся сам — звонить незачем, а держать
//    такого в знаменателе значит занижать контактируемость на ровном месте.
// 2. Обязанность относится к периоду, в котором окно ЗАКОНЧИЛОСЬ. Только тогда
//    ответ окончателен: две недели прошли, звонок либо был, либо нет. По дате
//    отгрузки привязывать нельзя — у отгрузки 25 июля окно целиком в августе.
// 3. «Позвонили» = исходящий состоявшийся звонок (`direction='outbound'`,
//    `result='completed'`) по любой сделке этого клиента внутри окна. Недозвон
//    обязанность не закрывает. Клиент звонка определяется через сделку
//    (`va.calls.deal_id` → `sa.deals.contact_id`): собственная колонка
//    `contact_id` в звонках заполнена лишь у 26 % записей.

/** Окно обзвона после отгрузки, дни. Владелец 10.08: две недели. */
export const FOLLOWUP_WINDOW_DAYS = 14;

export const CLIENT_FOLLOWUP_METRIC_IDS = [
  'followup_clients_due', 'followup_clients_called',
] as const;

export interface ClientFollowupRow {
  /** Клиенты, у которых окно обзвона закрылось в периоде. */
  due: number;
  /** Из них те, кому в окне реально дозвонились исходящим. */
  called: number;
}

export function clientFollowupToRecord(row: ClientFollowupRow | undefined): Record<string, number | null> {
  return {
    followup_clients_due: row?.due ?? 0,
    followup_clients_called: row?.called ?? 0,
  };
}

export async function fetchClientFollowupMetrics(
  opts: ClientMetricsOptions,
): Promise<Map<string, ClientFollowupRow>> {
  const days = FOLLOWUP_WINDOW_DAYS;
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();
  const { managerIds, deptEmpty } = await resolveScope(opts);
  const df = buildDealFilterWhere(opts.dealFilters);
  const goods = goodsPositionWhere('p');
  const dimExpr = dimExprOf(opts);

  // Фильтры отчёта применяются к ОТГРУЗКЕ, породившей обязанность (её менеджер,
  // её товарная группа), но без ограничения по дате: в период должен попасть
  // конец окна, а не сама отгрузка.
  const scope: string[] = [];
  if (opts.dimension === 'manager') scope.push('d.current_manager_id IS NOT NULL');
  if (deptEmpty) scope.push('1=0');
  else if (managerIds.length) scope.push(`d.current_manager_id IN (${managerIds.join(',')})`);
  const pills = pillWhere(opts.dealScope ?? 'all', opts.clientType ?? 'all');
  if (pills) scope.push(pills);
  const offh = [
    createdTimeWhere('d', opts.createdTimeFilter ?? 'all'),
    firstTouchWhere('d', opts.firstTouchFilter ?? 'all'),
    df.sql,
  ].filter(Boolean).join(' AND ');
  if (offh) scope.push(offh);
  const inScope = scope.length ? scope.join(' AND ') : 'TRUE';

  // Для разреза «по периодам» бакет считается по КОНЦУ окна, а не по дате
  // отгрузки: обязанность живёт в том периоде, где её можно предъявить.
  const dimSql = opts.dimension === 'period'
    ? dimExpr.replace('d.delivered_at', `(d.delivered_at + interval '${days} days')`)
    : dimExpr;

  const sql = `
WITH dl AS (
  -- Границы по дате отгрузки — главное, что держит запрос быстрым. Обязанность
  -- попадает в период, только если окно закончилось внутри него, значит отгрузка
  -- лежит в [$1 − ${days} дн, $2). Тот же диапазон закрывает и проверку «не
  -- вернулся ли клиент»: следующая отгрузка не позже конца окна, то есть тоже < $2.
  SELECT d.contact_id, d.delivered_at, ${dimSql} AS dim_id, (${inScope}) AS in_scope
    FROM sa.deals d
   WHERE d.delivered_at >= $1::timestamptz - interval '${days} days'
     AND d.delivered_at <  $2::timestamptz
     AND d.contact_id IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
),
nxt AS (
  -- lead() вместо NOT EXISTS по той же таблице: проверка «клиент вернулся сам»
  -- становится одним проходом окна вместо самосоединения.
  SELECT dl.*, lead(delivered_at) OVER (PARTITION BY contact_id ORDER BY delivered_at) AS next_at
    FROM dl
),
due AS (
  SELECT contact_id, dim_id, delivered_at AS win_from,
         delivered_at + interval '${days} days' AS win_to
    FROM nxt
   WHERE in_scope
     AND delivered_at + interval '${days} days' >= $1
     AND delivered_at + interval '${days} days' <  $2
     AND (next_at IS NULL OR next_at > delivered_at + interval '${days} days')
),
calls_in AS (
  -- Звонки одним проходом по узкому окну дат (есть индекс idx_calls_called_at),
  -- а не коррелированным подзапросом на каждого клиента: va.calls — миллион строк.
  SELECT DISTINCT cd.contact_id, c.called_at
    FROM va.calls c
    JOIN sa.deals cd ON cd.deal_id = c.deal_id
   WHERE c.direction = 'outbound' AND c.result = 'completed'
     AND c.called_at >= $1::timestamptz - interval '${days} days'
     AND c.called_at <  $2::timestamptz
     AND cd.contact_id IS NOT NULL
),
marked AS (
  SELECT due.dim_id, due.contact_id,
         bool_or(ci.called_at IS NOT NULL) AS called
    FROM due
    LEFT JOIN calls_in ci
      ON ci.contact_id = due.contact_id
     AND ci.called_at >= due.win_from AND ci.called_at <= due.win_to
   GROUP BY 1, 2
)
SELECT dim_id, count(*) AS due_cnt, count(*) FILTER (WHERE called) AS called_cnt
  FROM marked GROUP BY 1
UNION ALL
SELECT '${CLIENTS_GRAND_TOTAL_KEY}', count(*), count(*) FILTER (WHERE called)
  FROM (SELECT contact_id, bool_or(called) AS called FROM marked GROUP BY 1) _a
`;

  const key = [
    'followup', fromIso, toExclIso, days, opts.dimension,
    opts.periodUnit ?? '-', opts.productGroupMode ?? '-',
    opts.dealScope ?? 'all', opts.clientType ?? 'all',
    deptEmpty ? 'none' : (managerIds.length ? managerIds.join(',') : 'all'),
    `${opts.createdTimeFilter ?? 'all'}:${opts.firstTouchFilter ?? 'all'}|df:${df.key}`,
  ].join('|');

  const rows = await cached(`rpt:clients:${key}`, reportTtl(toExclIso), async () => {
    const res = await analyticsDb().query<Record<string, unknown>>(sql, [fromIso, toExclIso]);
    return res.rows;
  });

  const out = new Map<string, ClientFollowupRow>();
  for (const r of rows) {
    out.set(String(r.dim_id), { due: num(r.due_cnt), called: num(r.called_cnt) });
  }
  return out;
}

// ── Четвёртая пачка: когортный LTV (задача владельца 10.08) ──────────────────
//
// КОГОРТА (решение владельца): клиенты, чья ПЕРВАЯ товарная отгрузка попала в
// период. Клиент навсегда принадлежит одной когорте, поэтому LTV разных месяцев
// можно сравнивать между собой. «Клиентов в когорте» отдельной метрикой не
// нужно — это ровно уже живая `new_clients_count` (та же популяция).
//
// ПОПУЛЯЦИЯ ВСЕХ СУММ — ПОВТОРНЫЕ КЛИЕНТЫ КОГОРТЫ (2+ товарные отгрузки за всю
// историю), решение владельца: и суммы, и знаменатели средних — только по ним.
// Окна 30/60/… дней отсчитываются от первой отгрузки клиента, суммы
// накопительные и ВКЛЮЧАЮТ первый заказ (пример владельца: первая отгрузка
// 100 тыс., всего миллион → коэффициент 10 = всё/первая).
//
// НЕЗРЕЛЫЕ ОКНА (решение владельца) — null, пока окно не прожито ВСЕЙ когортой:
// LTV 360 у свежей когорты выглядел бы катастрофой рядом с прошлогодней, и это
// читается как падение бизнеса, а не как «ещё не время». Судим по КОНЦУ строки
// (для разреза по периодам — конец бакета): последний клиент когорты прожил
// окно, когда конец бакета + X дней уже позади. «За всё время» показывается
// всегда — оно по определению накопительное.
//
// АТРИБУЦИЯ строки — менеджер/группа/бакет ПЕРВОЙ отгрузки клиента: когорта
// принадлежит тому, кто клиента привёл, дальнейшие покупки могут уходить другим
// менеджерам, но LTV меряет ценность привлечения.

export const LTV_WINDOWS_DAYS = [30, 60, 90, 180, 360] as const;

export const CLIENT_COHORT_METRIC_IDS = [
  'cohort_repeat_clients', 'cohort_first_revenue',
  'cohort_repeat_revenue_30', 'cohort_repeat_revenue_60', 'cohort_repeat_revenue_90',
  'cohort_repeat_revenue_180', 'cohort_repeat_revenue_360', 'cohort_ltv_total_revenue',
] as const;

export interface ClientCohortRow {
  /** Клиенты когорты с 2+ товарными отгрузками за всю историю. */
  repeatClients: number;
  /** Сумма первых отгрузок этих клиентов. */
  firstRevenue: number;
  /** Накопительные суммы отгрузок в окнах от первой (включая её); null = окно не прожито. */
  ltv: Record<(typeof LTV_WINDOWS_DAYS)[number], number | null>;
  /** Сумма всех отгрузок этих клиентов за всю историю. */
  ltvTotal: number;
}

export function clientCohortToRecord(row: ClientCohortRow | undefined): Record<string, number | null> {
  return {
    cohort_repeat_clients: row?.repeatClients ?? 0,
    cohort_first_revenue: row?.firstRevenue ?? 0,
    cohort_repeat_revenue_30: row?.ltv[30] ?? null,
    cohort_repeat_revenue_60: row?.ltv[60] ?? null,
    cohort_repeat_revenue_90: row?.ltv[90] ?? null,
    cohort_repeat_revenue_180: row?.ltv[180] ?? null,
    cohort_repeat_revenue_360: row?.ltv[360] ?? null,
    cohort_ltv_total_revenue: row?.ltvTotal ?? 0,
  };
}

export async function fetchClientCohortMetrics(
  opts: ClientMetricsOptions,
): Promise<Map<string, ClientCohortRow>> {
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();
  const { managerIds, deptEmpty } = await resolveScope(opts);
  const df = buildDealFilterWhere(opts.dealFilters);
  const goods = goodsPositionWhere('p');
  const dimExpr = dimExprOf(opts); // для 'period' использует d.delivered_at = дате первой отгрузки ✓

  // Фильтры отчёта применяются к ПЕРВОЙ сделке клиента — она определяет
  // принадлежность когорты (см. «атрибуция» в шапке блока).
  const scope: string[] = [];
  if (opts.dimension === 'manager') scope.push('d.current_manager_id IS NOT NULL');
  if (deptEmpty) scope.push('1=0');
  else if (managerIds.length) scope.push(`d.current_manager_id IN (${managerIds.join(',')})`);
  const pills = pillWhere(opts.dealScope ?? 'all', opts.clientType ?? 'all');
  if (pills) scope.push(pills);
  const offh = [
    createdTimeWhere('d', opts.createdTimeFilter ?? 'all'),
    firstTouchWhere('d', opts.firstTouchFilter ?? 'all'),
    df.sql,
  ].filter(Boolean).join(' AND ');
  if (offh) scope.push(offh);
  const inScope = scope.length ? scope.join(' AND ') : 'TRUE';

  const winSums = LTV_WINDOWS_DAYS
    .map(w => `SUM(amount) FILTER (WHERE delivered_at < first_at + interval '${w} days') AS ltv_${w}`)
    .join(',\n         ');

  const sql = `
WITH firsts AS (
  SELECT d.contact_id, min(d.delivered_at) AS first_at
    FROM sa.deals d
   WHERE d.delivered_at IS NOT NULL AND d.contact_id IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
   GROUP BY 1
  HAVING min(d.delivered_at) >= $1 AND min(d.delivered_at) < $2
),
-- Сделка первой отгрузки задаёт строку отчёта; при нескольких сделках в один
-- момент берётся младший deal_id — детерминированно.
first_deal AS (
  SELECT DISTINCT ON (d.contact_id)
         d.contact_id, f.first_at, ${dimExpr} AS dim_id, (${inScope}) AS in_scope
    FROM firsts f
    JOIN sa.deals d ON d.contact_id = f.contact_id AND d.delivered_at = f.first_at
   WHERE d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
   ORDER BY d.contact_id, d.deal_id
),
ships AS (
  SELECT fd.contact_id, fd.dim_id, fd.first_at, d.delivered_at, d.amount
    FROM first_deal fd
    JOIN sa.deals d ON d.contact_id = fd.contact_id
   WHERE fd.in_scope
     AND d.delivered_at IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
),
per_client AS (
  SELECT contact_id, dim_id,
         count(*) AS n_ships,
         COALESCE(SUM(amount) FILTER (WHERE delivered_at = first_at), 0) AS first_rev,
         ${winSums},
         SUM(amount) AS ltv_total
    FROM ships GROUP BY 1, 2
),
rep AS (SELECT * FROM per_client WHERE n_ships >= 2)
SELECT dim_id, count(*) AS repeat_clients, COALESCE(SUM(first_rev), 0) AS first_revenue,
       ${LTV_WINDOWS_DAYS.map(w => `COALESCE(SUM(ltv_${w}), 0) AS ltv_${w}`).join(', ')},
       COALESCE(SUM(ltv_total), 0) AS ltv_total
  FROM rep GROUP BY 1
UNION ALL
SELECT '${CLIENTS_GRAND_TOTAL_KEY}', count(*), COALESCE(SUM(first_rev), 0),
       ${LTV_WINDOWS_DAYS.map(w => `COALESCE(SUM(ltv_${w}), 0)`).join(', ')},
       COALESCE(SUM(ltv_total), 0)
  FROM rep
`;

  const key = [
    'cohort', fromIso, toExclIso, opts.dimension, opts.periodUnit ?? '-', opts.productGroupMode ?? '-',
    opts.dealScope ?? 'all', opts.clientType ?? 'all',
    deptEmpty ? 'none' : (managerIds.length ? managerIds.join(',') : 'all'),
    `${opts.createdTimeFilter ?? 'all'}:${opts.firstTouchFilter ?? 'all'}|df:${df.key}`,
  ].join('|');

  const rows = await cached(`rpt:clients:${key}`, reportTtl(toExclIso), async () => {
    const res = await analyticsDb().query<Record<string, unknown>>(sql, [fromIso, toExclIso]);
    return res.rows;
  });

  // Зрелость окна: конец строки + X дней уже позади «сейчас». Для разреза по
  // периодам конец — у каждого бакета свой; для остальных — конец периода отчёта.
  const now = Date.now();
  const unit = (['day', 'week', 'month', 'quarter', 'year'].includes(opts.periodUnit ?? '')
    ? opts.periodUnit : 'month') as Parameters<typeof nextBucket>[1];
  const rowEndMs = (dimId: string): number => {
    if (opts.dimension === 'period' && /^\d{4}-\d{2}-\d{2}$/.test(dimId)) {
      return new Date(`${nextBucket(dimId, unit)}T00:00:00+03:00`).getTime();
    }
    return new Date(toExclIso).getTime();
  };

  const out = new Map<string, ClientCohortRow>();
  for (const r of rows) {
    const dimId = String(r.dim_id);
    const end = rowEndMs(dimId);
    const ltv = {} as ClientCohortRow['ltv'];
    for (const w of LTV_WINDOWS_DAYS) {
      ltv[w] = end + w * 86_400_000 <= now ? num(r[`ltv_${w}`]) : null;
    }
    out.set(dimId, {
      repeatClients: num(r.repeat_clients),
      firstRevenue: num(r.first_revenue),
      ltv,
      ltvTotal: num(r.ltv_total),
    });
  }
  return out;
}

// ── Пятая пачка: «Активные компании» — отгрузка за последние 90 дней ─────────
//
// Окно СКОЛЬЗИТ от конца строки: для обычных разрезов — 90 дней до конца периода
// отчёта, для разреза по периодам — 90 дней до конца КАЖДОГО бакета. Это
// снапшотная метрика («сколько живой базы на эту дату»), поэтому суммировать её
// по строкам нельзя — «Итого» считается своим окном от конца периода.

export const ACTIVE_WINDOW_DAYS = 90;
export const CLIENT_ACTIVE_METRIC_IDS = ['active_clients_90d'] as const;

export function clientActiveToRecord(active: number | undefined): Record<string, number | null> {
  return { active_clients_90d: active ?? 0 };
}

export async function fetchActiveClients(
  opts: ClientMetricsOptions,
): Promise<Map<string, number>> {
  const days = ACTIVE_WINDOW_DAYS;
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();
  const { managerIds, deptEmpty } = await resolveScope(opts);
  const df = buildDealFilterWhere(opts.dealFilters);
  const goods = goodsPositionWhere('p');

  const scope: string[] = [
    `d.contact_id IS NOT NULL`,
    `d.funnel_id NOT IN ${EXCLUDED_FUNNELS}`,
    `EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})`,
  ];
  if (opts.dimension === 'manager') scope.push('d.current_manager_id IS NOT NULL');
  if (deptEmpty) scope.push('1=0');
  else if (managerIds.length) scope.push(`d.current_manager_id IN (${managerIds.join(',')})`);
  const pills = pillWhere(opts.dealScope ?? 'all', opts.clientType ?? 'all');
  if (pills) scope.push(pills);
  const offh = [
    createdTimeWhere('d', opts.createdTimeFilter ?? 'all'),
    firstTouchWhere('d', opts.firstTouchFilter ?? 'all'),
    df.sql,
  ].filter(Boolean).join(' AND ');
  if (offh) scope.push(offh);
  const where = scope.join('\n     AND ');

  let sql: string;
  let params: unknown[];
  if (opts.dimension === 'period') {
    // Свой конец окна у каждого бакета — бакеты и их правые границы считаются в
    // JS (та же арифметика periodBuckets, что строит строки отчёта) и передаются
    // массивами: одна выборка отгрузок покрывает все окна.
    const unit = (['day', 'week', 'month', 'quarter', 'year'].includes(opts.periodUnit ?? '')
      ? opts.periodUnit : 'month') as Parameters<typeof nextBucket>[1];
    const fromYmd = periodDateStrFromInstant(opts.period.from, 'from');
    const toYmd = periodDateStrFromInstant(opts.period.to, 'to');
    const keys: string[] = [];
    const ends: string[] = [];
    const last = bucketStartOf(toYmd, unit);
    for (let b = bucketStartOf(fromYmd, unit); b <= last && keys.length < 1000; b = nextBucket(b, unit)) {
      keys.push(b);
      ends.push(`${nextBucket(b, unit)}T00:00:00+03:00`);
    }
    sql = `
WITH b AS (SELECT * FROM unnest($1::text[], $2::timestamptz[]) AS t(key, win_end))
SELECT b.key AS dim_id, count(DISTINCT d.contact_id) AS active
  FROM b
  JOIN sa.deals d
    ON d.delivered_at >= b.win_end - interval '${days} days'
   AND d.delivered_at <  b.win_end
 WHERE ${where}
 GROUP BY 1
UNION ALL
SELECT '${CLIENTS_GRAND_TOTAL_KEY}', count(DISTINCT d.contact_id)
  FROM sa.deals d
 WHERE d.delivered_at >= $3::timestamptz - interval '${days} days'
   AND d.delivered_at <  $3::timestamptz
   AND ${where}
`;
    params = [keys, ends, toExclIso];
  } else {
    const dimExpr = dimExprOf(opts);
    sql = `
SELECT ${dimExpr} AS dim_id, count(DISTINCT d.contact_id) AS active
  FROM sa.deals d
 WHERE d.delivered_at >= $1::timestamptz - interval '${days} days'
   AND d.delivered_at <  $1::timestamptz
   AND ${where}
 GROUP BY 1
UNION ALL
SELECT '${CLIENTS_GRAND_TOTAL_KEY}', count(DISTINCT d.contact_id)
  FROM sa.deals d
 WHERE d.delivered_at >= $1::timestamptz - interval '${days} days'
   AND d.delivered_at <  $1::timestamptz
   AND ${where}
`;
    params = [toExclIso];
  }

  const key = [
    'active', fromIso, toExclIso, days, opts.dimension, opts.periodUnit ?? '-',
    opts.productGroupMode ?? '-', opts.dealScope ?? 'all', opts.clientType ?? 'all',
    deptEmpty ? 'none' : (managerIds.length ? managerIds.join(',') : 'all'),
    `${opts.createdTimeFilter ?? 'all'}:${opts.firstTouchFilter ?? 'all'}|df:${df.key}`,
  ].join('|');

  const rows = await cached(`rpt:clients:${key}`, reportTtl(toExclIso), async () => {
    const res = await analyticsDb().query<Record<string, unknown>>(sql, params);
    return res.rows;
  });

  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r.dim_id), num(r.active));
  return out;
}

// ── Долевые метрики и «купившие клиенты группы» (задача владельца 10.08) ─────
//
// «Доля клиентов по количеству/сумме» — доля строки от ИТОГА отчёта (пример
// владельца: у Володи 5 компаний из 10 → 50 %). Формулой каталога это не
// выражается — формулы не видят итог, — поэтому доли досчитываются в роуте
// после обогащения строк (clientShareOf ниже). В «Итого» всегда 100 %.

export const CLIENT_SHARE_METRIC_IDS = ['client_share_count_pct', 'client_share_amount_pct'] as const;

/** Доли строки от итога: клиентов — по count, суммы — по (новые + повторные). */
export function clientShareOf(
  row: Record<string, number | null>,
  totals: Record<string, number | null>,
): Record<string, number | null> {
  const cnt = row.all_clients_delivered;
  const cntTotal = totals.all_clients_delivered;
  const amt = (row.new_clients_amount ?? 0) + (row.repeat_clients_amount ?? 0);
  const amtTotal = (totals.new_clients_amount ?? 0) + (totals.repeat_clients_amount ?? 0);
  return {
    client_share_count_pct: cnt != null && cntTotal ? (cnt / cntTotal) * 100 : null,
    client_share_amount_pct: amtTotal ? (amt / amtTotal) * 100 : null,
  };
}

// «Количество купивших клиентов» — уникальные клиенты, у которых группа
// «так или иначе встречалась» в товарной отгрузке периода. Отличие от строки
// отчёта по группам: та привязывает сделку к ОДНОЙ главной группе, а здесь
// клиент засчитывается КАЖДОЙ группе из позиций сделки — «купил утеплитель с
// доборами» пополняет и утеплитель, и доборы. Работает на шкале by_max
// (в позициях products есть только head_group_id); на kc — по главной группе.

export const CLIENT_BUYERS_METRIC_IDS = ['group_buyers_count'] as const;

export async function fetchGroupBuyers(
  opts: ClientMetricsOptions,
): Promise<Map<string, number>> {
  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();
  const { managerIds, deptEmpty } = await resolveScope(opts);
  const df = buildDealFilterWhere(opts.dealFilters);
  const goods = goodsPositionWhere('p');

  const scope: string[] = [
    `d.delivered_at >= $1`, `d.delivered_at < $2`,
    `d.contact_id IS NOT NULL`,
    `d.funnel_id NOT IN ${EXCLUDED_FUNNELS}`,
  ];
  if (deptEmpty) scope.push('1=0');
  else if (managerIds.length) scope.push(`d.current_manager_id IN (${managerIds.join(',')})`);
  const pills = pillWhere(opts.dealScope ?? 'all', opts.clientType ?? 'all');
  if (pills) scope.push(pills);
  const offh = [
    createdTimeWhere('d', opts.createdTimeFilter ?? 'all'),
    firstTouchWhere('d', opts.firstTouchFilter ?? 'all'),
    df.sql,
  ].filter(Boolean).join(' AND ');
  if (offh) scope.push(offh);
  const where = scope.join('\n     AND ');

  const byMax = (opts.productGroupMode ?? 'kc') === 'by_max';
  const sql = byMax
    ? `
SELECT COALESCE(p->>'head_group_name', 'Без группы') AS dim_id,
       count(DISTINCT d.contact_id) AS buyers
  FROM sa.deals d, jsonb_array_elements(d.products) p
 WHERE ${where}
   AND ${goods}
 GROUP BY 1
UNION ALL
SELECT '${CLIENTS_GRAND_TOTAL_KEY}', count(DISTINCT d.contact_id)
  FROM sa.deals d
 WHERE ${where}
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})`
    : `
SELECT COALESCE(d.product_group_id::text, '__none__') AS dim_id,
       count(DISTINCT d.contact_id) AS buyers
  FROM sa.deals d
 WHERE ${where}
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
 GROUP BY 1
UNION ALL
SELECT '${CLIENTS_GRAND_TOTAL_KEY}', count(DISTINCT d.contact_id)
  FROM sa.deals d
 WHERE ${where}
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})`;

  const key = [
    'buyers', fromIso, toExclIso, byMax ? 'by_max' : 'kc',
    opts.dealScope ?? 'all', opts.clientType ?? 'all',
    deptEmpty ? 'none' : (managerIds.length ? managerIds.join(',') : 'all'),
    `${opts.createdTimeFilter ?? 'all'}:${opts.firstTouchFilter ?? 'all'}|df:${df.key}`,
  ].join('|');

  const rows = await cached(`rpt:clients:${key}`, reportTtl(toExclIso), async () => {
    const res = await analyticsDb().query<Record<string, unknown>>(sql, [fromIso, toExclIso]);
    return res.rows;
  });

  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r.dim_id), num(r.buyers));
  return out;
}
