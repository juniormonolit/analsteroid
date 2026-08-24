import { analyticsDb } from '@/lib/db/clients';
import { goodsPositionWhere } from '@/lib/metrics/serviceGroups';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import { getCachedClientNames } from '@/lib/bitrix/clientNames';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, CreatedTimeFilter, FirstTouchFilter, ProductGroupMode } from '@/lib/metrics/types';
import { CLIENT_DRILL_RULES, CLIENT_DRILL_METRIC_IDS } from './clientDrilldownShared';
import { addDays, startOfDay } from 'date-fns';

export { CLIENT_DRILL_METRIC_IDS };

// ── Дрилл-даун клиентских метрик: заказчики со свёрнутыми сделками ───────────
// (задача владельца 17.08: «нажимая на сумму ЛТВ 90 дней — показывать заказчиков
// и только сделки, которые дают эту сумму»).
//
// Обычный дрилл (/api/reports/deals) для метрик раздела «Клиенты» бесполезен: у
// них нет date_field/фильтров каталога (external, движок clientMetrics), и плоский
// список показывал бы просто все сделки периода. Здесь население (клиент, сделка)
// восстанавливается ТЕМИ ЖЕ правилами, которыми метрика считает своё число:
// сумма раскрытых сделок обязана сходиться со значением в ячейке.
//
// ДВЕ ПОПУЛЯЦИИ — как в clientMetrics.ts:
//   base   — товарные отгрузки ПЕРИОДА (new/repeat/all клиенты, суммы, комплексные,
//            купившие группу); атрибуция строки — по сделке (менеджер сделки,
//            главная группа сделки, бакет отгрузки);
//   cohort — клиенты, чья ПЕРВАЯ товарная отгрузка в периоде (LTV-окна, выручка
//            первых заказов); атрибуция строки — по ПЕРВОЙ сделке клиента (когорта
//            принадлежит тому, кто клиента привёл), сделки берутся из ВСЕЙ истории
//            в границах окна метрики.
//
// Медианные/интервальные метрики (median_*, avg_*, доли, active_90d, followup) сюда
// НЕ входят: их население — интервалы/снимки, а не «клиент+сделки, дающие сумму».
// Для них дрилл остаётся прежним плоским списком.

const EXCLUDED_FUNNELS = '(4, 7)';
const MSK = 'Europe/Moscow';

// Правила населения — в clientDrilldownShared.ts (общий с UI модуль без
// серверных импортов, см. его шапку).

export interface ClientDrillDeal {
  dealId: number;
  dealName: string | null;
  amount: number;
  deliveredAt: string | null;
  managerId: string | null;
  groupName: string | null;
}

export interface ClientDrillCustomer {
  contactId: string;
  name: string;
  dealsCount: number;
  amount: number;
  deals: ClientDrillDeal[];
}

export interface ClientDrillResult {
  customers: ClientDrillCustomer[];
  totalCustomers: number;
  totalDeals: number;
  totalAmount: number;
  /** Показаны не все заказчики (потолок 500 — защита от «всё время», инцидент 17.08). */
  truncated: boolean;
}

export interface ClientDrillOptions {
  metricId: string;
  period: DateRange;
  /** Разрез строки, по которой кликнули. 'total' — строка «Итого» / весь срез. */
  dimension: 'manager' | 'product-group' | 'period' | 'total';
  /** Значение разреза: id менеджера / значение группы / не нужно для period+total
   *  (бакет уже сужен периодом, как и во всём остальном дрилле). */
  dimValue?: string;
  /** Несколько менеджеров (пользовательская группа строк). */
  dimValues?: string[];
  productGroupMode?: ProductGroupMode;
  dealScope?: DealScope;
  clientType?: ClientType;
  departmentIds?: string[];
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  dealFilters?: DealFilter[];
}

const CUSTOMERS_LIMIT = 500;

function pillWhere(dealScope: DealScope, clientType: ClientType): string {
  const parts: string[] = [];
  if (dealScope === 'primary') parts.push(`d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)`);
  else if (dealScope === 'repeat') parts.push(`d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)`);
  if (clientType === 'b2c') parts.push(`d.funnel_id IN (0, 2)`);
  else if (clientType === 'b2b') parts.push(`d.funnel_id IN (1, 3)`);
  return parts.join(' AND ');
}

/** Условие «сделка принадлежит строке отчёта» для алиаса d. */
function dimWhere(opts: ClientDrillOptions): string {
  if (opts.dimension === 'manager') {
    const ids = (opts.dimValues ?? (opts.dimValue ? [opts.dimValue] : [])).filter(v => /^\d+$/.test(v));
    return ids.length ? `d.current_manager_id IN (${ids.join(',')})` : '1=0';
  }
  if (opts.dimension === 'product-group') {
    const v = (opts.dimValue ?? '').replace(/'/g, "''");
    return (opts.productGroupMode ?? 'kc') === 'by_max'
      ? `COALESCE(d.head_group_name, 'Без группы') = '${v}'`
      : `COALESCE(d.product_group_id::text, '__none__') = '${v}'`;
  }
  // period: окно уже сужено до бакета вызывающим (как во всём дрилле); total: весь срез.
  return 'TRUE';
}

/** Общие фильтры отчёта (отделы/пилюли/нерабочее время/фильтр сделок) для алиаса d. */
async function reportScopeWhere(opts: ClientDrillOptions): Promise<string> {
  const parts: string[] = [];
  const pills = pillWhere(opts.dealScope ?? 'all', opts.clientType ?? 'all');
  if (pills) parts.push(pills);
  const df = buildDealFilterWhere(opts.dealFilters);
  const offh = [
    createdTimeWhere('d', opts.createdTimeFilter ?? 'all'),
    firstTouchWhere('d', opts.firstTouchFilter ?? 'all'),
    df.sql,
  ].filter(Boolean).join(' AND ');
  if (offh) parts.push(offh);
  if ((opts.departmentIds ?? []).length && opts.dimension !== 'manager') {
    const res = await analyticsDb().query<{ id: string }>(
      `SELECT DISTINCT manager_bitrix_user_id::text AS id
         FROM sa.org_resolved_hierarchy
        WHERE department_id IN (SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1))
          AND is_active = true`,
      [opts.departmentIds],
    );
    const ids = res.rows.map(r => r.id).filter(id => /^\d+$/.test(id));
    parts.push(ids.length ? `d.current_manager_id IN (${ids.join(',')})` : '1=0');
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

export async function fetchClientMetricDeals(opts: ClientDrillOptions): Promise<ClientDrillResult | null> {
  const rule = CLIENT_DRILL_RULES[opts.metricId];
  if (!rule) return null;

  const fromIso = opts.period.from.toISOString();
  const toExclIso = addDays(startOfDay(opts.period.to), 1).toISOString();
  const goods = goodsPositionWhere('p');
  const scope = await reportScopeWhere(opts);
  const dim = dimWhere(opts);

  let sql: string;
  if (rule.kind === 'base') {
    // Товарные отгрузки периода строки; порядковый номер — по ВСЕЙ истории клиента
    // (тот же ranked, что в clientMetrics). Комплексность — счётчик разных групп
    // за историю (как client_groups там же).
    const rnFilter = rule.rnCond ? `AND r.rn ${rule.rnCond}` : '';
    const complexJoin = rule.complexOnly ? `
  JOIN (
    SELECT contact_id FROM (
      SELECT d.contact_id, count(DISTINCT p->>'head_group_name') AS cg
        FROM sa.deals d, jsonb_array_elements(d.products) p
       WHERE d.delivered_at IS NOT NULL AND d.contact_id IS NOT NULL
         AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS} AND ${goods}
       GROUP BY 1
    ) cx WHERE cg >= 2
  ) cxf ON cxf.contact_id = pd.contact_id` : '';
    sql = `
WITH period_deals AS (
  SELECT d.deal_id, d.contact_id, d.deal_name, d.amount, d.delivered_at,
         d.current_manager_id::text AS manager_id, d.head_group_name
    FROM sa.deals d
   WHERE d.delivered_at >= $1 AND d.delivered_at < $2
     AND d.contact_id IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
     AND ${scope} AND ${dim}
),
ranked AS (
  SELECT d.deal_id, row_number() OVER (PARTITION BY d.contact_id ORDER BY d.delivered_at, d.deal_id) AS rn
    FROM sa.deals d
   WHERE d.delivered_at IS NOT NULL
     AND d.contact_id IN (SELECT DISTINCT contact_id FROM period_deals)
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
)
SELECT pd.*
  FROM period_deals pd
  JOIN ranked r ON r.deal_id = pd.deal_id ${rnFilter}${complexJoin}
 ORDER BY pd.contact_id, pd.delivered_at`;
  } else {
    // Когорта: первая товарная отгрузка клиента в периоде, 2+ отгрузки за историю
    // (популяция всех когортных сумм — см. шапку блока LTV в clientMetrics.ts).
    // Атрибуция строки — по ПЕРВОЙ сделке; окно метрики режет сделки истории.
    const windowCond = rule.windowDays
      ? `AND s.delivered_at < f.first_at + interval '${rule.windowDays} days'
         AND f.first_at + interval '${rule.windowDays} days' <= now()`
      : '';
    const firstCond = rule.firstOnly ? `AND s.delivered_at = f.first_at` : '';
    // «% вернувшихся N дн» (#4996): повторным считается клиент, у которого 2+
    // отгрузки УЛОЖИЛИСЬ в окно — иначе в дрилле показались бы клиенты,
    // вернувшиеся позже окна, и список был бы шире числа в ячейке.
    const repeatHaving = rule.returnedOnly && rule.windowDays
      ? `count(*) FILTER (WHERE delivered_at < first_at + interval '${rule.windowDays} days') >= 2`
      : `count(*) >= 2`;
    // cohort_clients — ВСЯ когорта, включая купивших один раз.
    const repeatJoin = rule.allClients
      ? ''
      : `JOIN repeat_clients rc ON rc.contact_id = s.contact_id`;
    sql = `
WITH firsts AS (
  SELECT d.contact_id, min(d.delivered_at) AS first_at
    FROM sa.deals d
   WHERE d.delivered_at IS NOT NULL AND d.contact_id IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
   GROUP BY 1
  HAVING min(d.delivered_at) >= $1 AND min(d.delivered_at) < $2
),
first_deal AS (
  SELECT DISTINCT ON (d.contact_id) d.contact_id, f.first_at
    FROM firsts f
    JOIN sa.deals d ON d.contact_id = f.contact_id AND d.delivered_at = f.first_at
   WHERE d.funnel_id NOT IN ${EXCLUDED_FUNNELS} AND ${scope} AND ${dim}
   ORDER BY d.contact_id, d.deal_id
),
ships AS (
  SELECT d.deal_id, d.contact_id, d.deal_name, d.amount, d.delivered_at,
         d.current_manager_id::text AS manager_id, d.head_group_name, f.first_at
    FROM first_deal f
    JOIN sa.deals d ON d.contact_id = f.contact_id
   WHERE d.delivered_at IS NOT NULL
     AND d.funnel_id NOT IN ${EXCLUDED_FUNNELS}
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.products) p WHERE ${goods})
),
repeat_clients AS (
  SELECT contact_id FROM ships GROUP BY 1 HAVING ${repeatHaving}
)
SELECT s.deal_id, s.contact_id, s.deal_name, s.amount, s.delivered_at,
       s.manager_id, s.head_group_name
  FROM ships s
  ${repeatJoin}
  JOIN first_deal f ON f.contact_id = s.contact_id
 WHERE TRUE ${windowCond} ${firstCond}
 ORDER BY s.contact_id, s.delivered_at`;
  }

  const res = await analyticsDb().query<{
    deal_id: number; contact_id: string; deal_name: string | null; amount: string | null;
    delivered_at: string | null; manager_id: string | null; head_group_name: string | null;
  }>(sql, [fromIso, toExclIso]);

  // Сборка заказчиков: сортировка по сумме вниз, потолок CUSTOMERS_LIMIT (защита
  // от «всего времени» — инцидент 17.08; итоги считаются ДО обрезки, честные).
  const byClient = new Map<string, ClientDrillCustomer>();
  let totalDeals = 0;
  let totalAmount = 0;
  for (const r of res.rows) {
    const id = String(r.contact_id);
    let c = byClient.get(id);
    if (!c) { c = { contactId: id, name: '', dealsCount: 0, amount: 0, deals: [] }; byClient.set(id, c); }
    const amount = Number(r.amount ?? 0);
    c.dealsCount += 1;
    c.amount += amount;
    totalDeals += 1;
    totalAmount += amount;
    c.deals.push({
      dealId: Number(r.deal_id),
      dealName: r.deal_name,
      amount,
      deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
      managerId: r.manager_id,
      groupName: r.head_group_name,
    });
  }

  const sorted = [...byClient.values()].sort((a, b) => b.amount - a.amount || b.dealsCount - a.dealsCount);
  const shown = sorted.slice(0, CUSTOMERS_LIMIT);
  const names = await getCachedClientNames(shown.map(c => `c${c.contactId}`));
  for (const c of shown) c.name = names.get(`c${c.contactId}`) ?? `Контакт #${c.contactId}`;

  return {
    customers: shown,
    totalCustomers: sorted.length,
    totalDeals,
    totalAmount,
    truncated: sorted.length > shown.length,
  };
}
