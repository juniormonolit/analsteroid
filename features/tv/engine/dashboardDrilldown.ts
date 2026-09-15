// «Сегодня» (/today, /rop) — раскрытие продаж/броней в список сделок (задача #6465,
// Серёга: «сделай так, чтобы брони и продажи можно было в сделки раскрывать»).
//
// Скоуп НЕ пересчитывается заново: список менеджеров узла/конкретный менеджер берётся
// из уже посчитанного TvDashboard (buildDashboard(dailyTarget, scope) — тот же вызов,
// что отдаёт /api/tv/dashboard и /api/rop/dashboard, с тем же Redis-кэшем 20с). Это
// гарантирует ДВЕ вещи одним и тем же кодом, а не двумя параллельными реализациями:
//   1. Список менеджеров узла — ровно то множество, что дало node.salesCount/bookCount
//      (dashboard.ts:build() строит totalsOf() по ТЕМ ЖЕ managerIds, что лежат в
//      allManagerIds) — сумма списка сделок не может разойтись с карточкой.
//   2. Скоуп /rop не переизобретён: dash.root/dash.managers уже прошли scopeRows()
//      внутри buildDashboard — узел/менеджер вне зоны ответственности просто
//      ОТСУТСТВУЕТ в дереве/словаре (пустые узлы отваливаются в build(), менеджеры
//      вне scopeRows() не попадают в managers{}) → findNode/managers[id] возвращают
//      «не найдено», а не чужие данные.
import { analyticsDb } from '@/lib/db/clients';
import { addDaysStr, mskMidnightIso, mskTodayStr } from './feed';
import type { RopScope } from './access';
import { buildDashboard } from './dashboard';
import type { TvDashboard, TvDashNode } from './dashboard';

export type DrilldownKind = 'sales' | 'book';

export interface DrilldownDeal {
  deal_id: number;
  deal_name: string;
  amount: string;
  manager_id: string;
  manager_name: string;
  product_group_display: string;
  product_group_name: string | null;
  head_group_name: string | null;
  funnel_name: string | null;
  stage_name: string | null;
  stage_event_type: string | null;
  created_at: string;
  reserved_at: string | null;
  confirmed_at: string | null;
  sold_at: string | null;
  delivered_at: string | null;
  lost_at: string | null;
  expected_close_date: string | null;
  source_id: string | null;
  source_name: string | null;
  team_id: string | null;
  team_name: string | null;
  branch_name: string | null;
}

export interface DrilldownSelection {
  /** id менеджеров узла/менеджера — уже отфильтрованы по scope (см. заголовок файла). */
  managerIds: string[];
  /** managerId → имя, для manager_name в списке (то же имя, что в таблице /today). */
  names: Map<string, string>;
  /** название узла/менеджера — заголовок панели. */
  label: string;
}

function findNode(node: TvDashNode, id: string): TvDashNode | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

/**
 * Резолвит id менеджеров для узла (`nodeId`) или одного менеджера (`managerId`,
 * приоритет над `nodeId`) — на уже построенном TvDashboard. `null` — узел/менеджер
 * не найден (вне scope или не существует вовсе): вызывающий код обязан отдать
 * пустой список сделок, а не пробовать угадать состав иначе.
 */
export function resolveDrilldownSelection(dash: TvDashboard, nodeId: string | null, managerId: string | null): DrilldownSelection | null {
  if (managerId) {
    const m = dash.managers[managerId];
    if (!m) return null;
    return { managerIds: [managerId], names: new Map([[managerId, m.name]]), label: m.name };
  }
  const id = nodeId ?? dash.root.id;
  const node = findNode(dash.root, id);
  if (!node) return null;
  const names = new Map<string, string>();
  for (const mid of node.allManagerIds) {
    const m = dash.managers[mid];
    if (m) names.set(mid, m.name);
  }
  return { managerIds: node.allManagerIds, names, label: node.name };
}

/** Собрать TvDashboard и сразу резолвнуть выборку — удобный вход для роутов. */
export async function resolveDrilldown(nodeId: string | null, managerId: string | null, scope?: RopScope): Promise<DrilldownSelection | null> {
  const dash = await buildDashboard(undefined, scope);
  return resolveDrilldownSelection(dash, nodeId, managerId);
}

/**
 * Список сделок «продажа»/«бронь» за сегодня по набору менеджеров — РОВНО то же
 * множество сделок, что суммируется в primary_sales_count+repeat_sales_count
 * (kind='sales') / reservations_count (kind='book') каталога метрик (lib/metrics/
 * catalog.ts, миграция метрик): funnel_type-фильтр записан явно тем же способом,
 * что resolveFilterClause('funnel_type', ...) в lib/metrics/sqlGen.ts — сознательно
 * НЕ «funnel_id NOT IN» и не голое отсутствие фильтра, чтобы деал с funnel_id,
 * не покрытым ни одной из двух воронок is_repeat, не попал в список молча —
 * список обязан сходиться с числом в карточке, а не быть «примерно похожим».
 */
/** Колонка даты события — та же, что date_field у primary/repeat_sales_count (sold_at)
 *  и reservations_count (reserved_at) в каталоге метрик (lib/metrics/catalog.ts). */
export function dateColumnFor(kind: DrilldownKind): 'sold_at' | 'reserved_at' {
  return kind === 'sales' ? 'sold_at' : 'reserved_at';
}

/**
 * SQL-условие, отделяющее ровно те сделки, что попадают в primary_sales_count+
 * repeat_sales_count (kind='sales') — funnel_type IN {primary, repeat}, выражено тем
 * же способом, что resolveFilterClause('funnel_type', ...) в lib/metrics/sqlGen.ts —
 * или в reservations_count (kind='book'), у которой в каталоге фильтров нет вовсе,
 * поэтому пустая строка. Вынесено отдельной функцией, чтобы юнит-тест (scripts/
 * assert-dashboard-drilldown.ts) мог проверить сам текст условия без похода в БД.
 */
export function funnelConditionFor(kind: DrilldownKind): string {
  return kind === 'sales'
    ? `AND (d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false) OR d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true))`
    : '';
}

export async function fetchDrilldownDeals(kind: DrilldownKind, selection: DrilldownSelection): Promise<{ deals: DrilldownDeal[]; total_count: number; total_amount: number }> {
  const idsNum = [...new Set(selection.managerIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (idsNum.length === 0) return { deals: [], total_count: 0, total_amount: 0 };

  const today = mskTodayStr();
  const fromIso = mskMidnightIso(today);
  const toExclIso = mskMidnightIso(addDaysStr(today, 1));
  const dateCol = dateColumnFor(kind);
  const funnelCond = funnelConditionFor(kind);
  const managerWhere = `d.current_manager_id IN (${idsNum.join(',')})`;

  const sql = `
    SELECT
      d.deal_id, d.deal_name, d.amount, d.current_manager_id::text AS manager_id,
      d.created_at, d.reserved_at, d.confirmed_at, d.sold_at, d.delivered_at, d.lost_at,
      d.source_id,
      s.name AS stage_name, s.event_type AS stage_event_type,
      pg.name AS product_group_name, d.head_group_name,
      f.name AS funnel_name
    FROM deals d
    LEFT JOIN stages s ON s.id = d.stage_id
    LEFT JOIN product_groups pg ON pg.id = d.product_group_id
    LEFT JOIN funnels f ON f.id = d.funnel_id
    WHERE d.${dateCol} >= $1 AND d.${dateCol} < $2
      AND ${managerWhere}
      ${funnelCond}
    ORDER BY d.${dateCol} DESC
    LIMIT 500
  `;
  const countSql = `
    SELECT COUNT(*)::int AS total_count, COALESCE(SUM(d.amount), 0)::numeric AS total_amount
    FROM deals d
    WHERE d.${dateCol} >= $1 AND d.${dateCol} < $2
      AND ${managerWhere}
      ${funnelCond}
  `;
  const [res, countRes] = await Promise.all([
    analyticsDb().query<{
      deal_id: number; deal_name: string; amount: string; manager_id: string;
      created_at: string; reserved_at: string | null; confirmed_at: string | null;
      sold_at: string | null; delivered_at: string | null; lost_at: string | null;
      source_id: string | null; stage_name: string | null; stage_event_type: string | null;
      product_group_name: string | null; head_group_name: string | null; funnel_name: string | null;
    }>(sql, [fromIso, toExclIso]),
    analyticsDb().query<{ total_count: number; total_amount: string }>(countSql, [fromIso, toExclIso]),
  ]);

  const deals: DrilldownDeal[] = res.rows.map(r => ({
    deal_id: r.deal_id,
    deal_name: r.deal_name,
    amount: r.amount,
    manager_id: r.manager_id,
    manager_name: selection.names.get(r.manager_id) ?? `#${r.manager_id}`,
    product_group_display: r.product_group_name ?? r.head_group_name ?? 'Без группы',
    product_group_name: r.product_group_name ?? null,
    head_group_name: r.head_group_name ?? null,
    funnel_name: r.funnel_name,
    stage_name: r.stage_name,
    stage_event_type: r.stage_event_type,
    created_at: r.created_at,
    reserved_at: r.reserved_at,
    confirmed_at: r.confirmed_at,
    sold_at: r.sold_at,
    delivered_at: r.delivered_at,
    lost_at: r.lost_at,
    expected_close_date: null,
    source_id: r.source_id,
    source_name: null,
    team_id: null,
    team_name: null,
    branch_name: null,
  }));

  return {
    deals,
    total_count: countRes.rows[0]?.total_count ?? 0,
    total_amount: Number(countRes.rows[0]?.total_amount ?? 0),
  };
}
