import { analyticsDb } from '@/lib/db/clients';
import { cached, reportTtl } from '@/lib/cache/redis';
import { goodsPositionWhere } from '@/lib/metrics/serviceGroups';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';

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
export type ClientMetricsDimension = 'manager' | 'product-group' | 'period' | 'none';

export interface ClientMetricsRow {
  /** Уникальные клиенты с товарной отгрузкой в периоде. */
  clientsTotal: number;
  /** Из них те, у кого эта отгрузка — первая товарная за всю историю. */
  newClients: number;
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
}

/** id метрик каталога, которые заполняет этот движок (миграция 171). Роут по
 *  этому списку решает, звать ли движок вообще. */
export const CLIENT_METRIC_IDS = [
  'new_clients_count', 'all_clients_delivered', 'repeat_clients_delivered',
  'delivered_deals_count', 'new_clients_amount', 'repeat_clients_amount',
  'complex_clients', 'avg_groups_per_client', 'avg_groups_per_order',
  'avg_products_per_order',
] as const;

/** Значения движка → метрики каталога. Пустая строка среза (клиент есть в отчёте,
 *  но товарных отгрузок в периоде нет) даёт нули, а не null: «не было продаж» —
 *  это ноль, а пустая ячейка читается как «не посчитали». Средние — null, у них
 *  при нуле заказов нет значения. */
export function clientMetricsToRecord(row: ClientMetricsRow | undefined): Record<string, number | null> {
  if (!row) {
    return {
      new_clients_count: 0, all_clients_delivered: 0, repeat_clients_delivered: 0,
      delivered_deals_count: 0, new_clients_amount: 0, repeat_clients_amount: 0,
      complex_clients: 0, avg_groups_per_client: null, avg_groups_per_order: null,
      avg_products_per_order: null,
    };
  }
  return {
    new_clients_count: row.newClients,
    all_clients_delivered: row.clientsTotal,
    // Повторные — остаток: клиент периода либо новый, либо покупал раньше.
    // Так эти две метрики не пересекаются и в сумме дают всех клиентов.
    repeat_clients_delivered: row.clientsTotal - row.newClients,
    delivered_deals_count: row.orders,
    new_clients_amount: row.newAmount,
    repeat_clients_amount: row.repeatAmount,
    complex_clients: row.complexClients,
    avg_groups_per_client: row.groupsPerClient,
    avg_groups_per_order: row.groupsPerOrder,
    avg_products_per_order: row.productsPerOrder,
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

  let managerIds = (opts.managerIds ?? []).filter(id => /^\d+$/.test(id));
  const deptIds = opts.departmentIds ?? [];
  let deptEmpty = false;
  if (!managerIds.length && deptIds.length) {
    // Оргструктура — из sa, НЕ из YC system (задача 2065, тот же фикс, что в
    // byManagers.ts/byProductGroups.ts: YC-копия протухла).
    const res = await analyticsDb().query<{ bitrix_user_id: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS bitrix_user_id
         FROM sa.org_resolved_hierarchy orh
        WHERE orh.department_id IN (
          SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1)
        ) AND orh.is_active = true`,
      [deptIds],
    );
    managerIds = res.rows.map(r => r.bitrix_user_id).filter(id => /^\d+$/.test(id));
    // Отдел без единого менеджера — честный ноль, а не молча снятый фильтр.
    deptEmpty = managerIds.length === 0;
  }
  const df = buildDealFilterWhere(opts.dealFilters);

  const where: string[] = [
    `d.delivered_at >= $1`,
    `d.delivered_at < $2`,
    `d.contact_id IS NOT NULL`,
    `d.funnel_id NOT IN ${EXCLUDED_FUNNELS}`,
  ];
  if (opts.dimension === 'manager') where.push('d.current_manager_id IS NOT NULL');
  if (deptEmpty) where.push('1=0');
  else if (managerIds.length) where.push(`d.current_manager_id IN (${managerIds.join(',')})`);
  const pills = pillWhere(dealScope, clientType);
  if (pills) where.push(pills);
  const offh = [
    createdTimeWhere('d', opts.createdTimeFilter ?? 'all'),
    firstTouchWhere('d', opts.firstTouchFilter ?? 'all'),
    df.sql,
  ].filter(Boolean).join(' AND ');
  if (offh) where.push(offh);

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
            FROM jsonb_array_elements(d.products) p WHERE ${goods}) AS items_cnt
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
src AS (
  SELECT dg.dim_id, dg.contact_id, dg.amount, dg.groups_cnt, dg.items_cnt,
         (f.first_at >= $1::timestamptz AND f.first_at < $2::timestamptz) AS is_new,
         COALESCE(c.groups_cnt, 0) AS client_groups
    FROM deal_goods dg
    LEFT JOIN first_goods   f ON f.contact_id = dg.contact_id
    LEFT JOIN client_groups c ON c.contact_id = dg.contact_id
),
-- Две ступени агрегации, и это принципиально. Заказы/суммы/средние по заказу
-- считаются ПО СДЕЛКАМ, а клиенты/комплексность/группы на клиента — сначала
-- сворачиваются ПО КЛИЕНТУ (клиент с десятью заказами весит столько же, сколько
-- клиент с одним), и только потом усредняются.
pc_dim  AS (SELECT dim_id, contact_id, bool_or(is_new) AS is_new, max(client_groups) AS cg FROM src GROUP BY 1, 2),
pc_all  AS (SELECT contact_id, bool_or(is_new) AS is_new, max(client_groups) AS cg FROM src GROUP BY 1),
deal_dim AS (
  SELECT dim_id, count(*) AS orders,
         COALESCE(SUM(amount) FILTER (WHERE is_new), 0)     AS new_amount,
         COALESCE(SUM(amount) FILTER (WHERE NOT is_new), 0) AS repeat_amount,
         AVG(groups_cnt) AS groups_per_order, AVG(items_cnt) AS products_per_order
    FROM src GROUP BY 1),
deal_all AS (
  SELECT count(*) AS orders,
         COALESCE(SUM(amount) FILTER (WHERE is_new), 0)     AS new_amount,
         COALESCE(SUM(amount) FILTER (WHERE NOT is_new), 0) AS repeat_amount,
         AVG(groups_cnt) AS groups_per_order, AVG(items_cnt) AS products_per_order
    FROM src),
client_dim AS (
  SELECT dim_id, count(*) AS clients_total,
         count(*) FILTER (WHERE is_new)  AS new_clients,
         count(*) FILTER (WHERE cg >= 2) AS complex_clients,
         AVG(cg) AS groups_per_client
    FROM pc_dim GROUP BY 1),
client_all AS (
  SELECT count(*) AS clients_total,
         count(*) FILTER (WHERE is_new)  AS new_clients,
         count(*) FILTER (WHERE cg >= 2) AS complex_clients,
         AVG(cg) AS groups_per_client
    FROM pc_all)
SELECT d.dim_id, c.clients_total, c.new_clients, d.orders, d.new_amount, d.repeat_amount,
       c.complex_clients, c.groups_per_client, d.groups_per_order, d.products_per_order
  FROM deal_dim d JOIN client_dim c ON c.dim_id IS NOT DISTINCT FROM d.dim_id
UNION ALL
SELECT '${CLIENTS_GRAND_TOTAL_KEY}', c.clients_total, c.new_clients, d.orders, d.new_amount,
       d.repeat_amount, c.complex_clients, c.groups_per_client, d.groups_per_order, d.products_per_order
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
      orders: num(r.orders),
      newAmount: num(r.new_amount),
      repeatAmount: num(r.repeat_amount),
      complexClients: num(r.complex_clients),
      groupsPerClient: numOrNull(r.groups_per_client),
      groupsPerOrder: numOrNull(r.groups_per_order),
      productsPerOrder: numOrNull(r.products_per_order),
    });
  }
  return out;
}
