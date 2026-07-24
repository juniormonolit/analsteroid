import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { resolveFilterClause } from '@/lib/metrics/sqlGen';
import { resolveSourceIds, sourceIdsWhere, resolveBranchManagerIds, managerIdsWhere, loadManagerInfoMap, loadSourceMap, type SourceDimension } from '@/lib/marketing/sources';
import { STAGE_SNAPSHOT_GROUPS, DEALS_IN_WORK_METRIC_IDS } from '@/features/reports/engine/stageSnapshot';
import type { Metric } from '@/lib/metrics/types';
import { addDays, startOfDay } from 'date-fns';

// Снимок «Стадии (сейчас)» (задача 2059) — metricId → stage_id этой группы.
// Драйв-даун этих метрик игнорирует период (см. stageSnapshot.ts: снимок текущего
// stage_id, а не «сделки, созданные/проданные в периоде»).
const STAGE_NOW_STAGE_IDS = new Map(
  Object.values(STAGE_SNAPSHOT_GROUPS).map(g => [g.metricId, g.stageIds]),
);

// Resolve a calculated metric's formula to the set of "collected" metrics whose deals should
// appear in the drill-down list — every metric that actually contributes real, distinct deals
// to what the user clicked on.
//
// Rule (derived purely from the formula text — no catalog/DB change needed):
//   - RATIO formulas (`numerator / denominator [* 100]`): the denominator is a comparison base
//     (plan target, wider population…), never itself a "these deals" list — only the NUMERATOR's
//     deals belong in the drill-down. Covers plain CR/%/avg metrics (denominator dropped).
//   - The numerator (or, when there's no division at all, the WHOLE formula — e.g.
//     `all_sales_amount = [primary_sales_amount] + [repeat_sales_amount]`) may itself be a sum of
//     ≥2 disjoint metric refs (`[a] + [b] + …`, parens allowed). Every such leg contributes
//     non-overlapping deals, so ALL legs must be resolved and UNION'd (OR'd) in the SQL — taking
//     only the first (the old "first dependency = numerator" heuristic) silently drops the rest.
//     That was bug #2340 (`all_sales_amount`) and #2346 (`plan_execution_pct`,
//     `cr_sale_to_shipment` — composite numerator INSIDE a ratio, same root cause).
//   - A leg can itself be `calculated` with the same additive/ratio shape (e.g. a numerator that
//     is itself `[a]+[b]`) — resolved RECURSIVELY until every leg bottoms out at a `collected`
//     metric, so nested composites are fully expanded, not just one level.
//   - Anything that doesn't match this additive/ratio shape (other operators, or nothing usable
//     extracted) falls back to the legacy "walk `dependencies` in catalog order, take the first
//     metric that resolves" — unchanged behavior for metrics this rule doesn't apply to
//     (e.g. `external` plan-vs-actual metrics with no deal-level numerator at all).

// Index of the first top-level `/` (i.e. outside any parens) — the ratio's numerator/denominator
// split point. -1 if the formula has no top-level division (pure-sum formulas like
// `all_sales_amount`).
function topLevelDivideIndex(formula: string): number {
  let depth = 0;
  for (let i = 0; i < formula.length; i++) {
    const c = formula[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '/' && depth === 0) return i;
  }
  return -1;
}

// True if `segment` consists ONLY of `[metric_id]` refs combined with `+` and parens — no other
// operators (division, multiplication, subtraction, literals). This is the safety guard: only
// shapes this narrow are treated as "sum of legs", so anything more exotic falls back untouched.
function isAdditiveRefsOnly(segment: string): boolean {
  const stripped = segment.replace(/\[[\w.-]+\]/g, '');
  return /\[[\w.-]+\]/.test(segment) && /^[\s()+]*$/.test(stripped);
}

function extractRefs(segment: string): string[] {
  return [...segment.matchAll(/\[([\w.-]+)\]/g)].map(m => m[1]);
}

function resolveDrilldownLegs(id: string, all: Metric[], depth = 0): Metric[] {
  if (depth > 5) return [];
  const m = all.find(x => x.id === id);
  if (!m) return [];
  if (m.metricType === 'collected') return [m];
  if (m.metricType === 'calculated' && m.formula) {
    const divIdx = topLevelDivideIndex(m.formula);
    const numerator = divIdx === -1 ? m.formula : m.formula.slice(0, divIdx);
    if (isAdditiveRefsOnly(numerator)) {
      const legs = extractRefs(numerator).flatMap(refId => resolveDrilldownLegs(refId, all, depth + 1));
      if (legs.length) return legs;
    }
    // Fallback: legacy "first dependency that resolves" walk — for formulas that don't match the
    // additive/ratio shape above (unaffected by this rule).
    for (const dep of m.dependencies) {
      const r = resolveDrilldownLegs(dep, all, depth + 1);
      if (r.length) return r;
    }
  }
  return [];
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const managerId      = sp.get('managerId');
  const productGroup   = sp.get('productGroup');    // group name (by_max) or id (kc)
  const pgMode         = sp.get('productGroupMode') ?? 'by_max';
  const from           = sp.get('from');
  const to             = sp.get('to');
  const scope          = sp.get('scope') ?? 'primary';
  const metricFilter   = sp.get('metricFilter') ?? '';
  const sourceDim      = sp.get('sourceDim') as SourceDimension | null; // marketing dimension
  const sourceVal      = sp.get('sourceVal');                           // its value
  const teamId         = sp.get('teamId');          // drilldown подытога отдела
  const all            = sp.get('all') === '1';     // drilldown строки «Итого» — весь срез
  const departmentIds  = (sp.get('departmentIds') ?? '').split(',').filter(Boolean);
  const accountType    = sp.get('accountType');     // managers | logists (фильтр отчёта)

  if ((!managerId && !productGroup && !sourceDim && !teamId && !all) || !from || !to) {
    return NextResponse.json({ error: 'managerId, productGroup, sourceDim+sourceVal, teamId or all=1, plus from/to required' }, { status: 400 });
  }

  const fromDate = new Date(from);
  const toExcl   = addDays(startOfDay(new Date(to)), 1);

  // ── Scope filter ──────────────────────────────────────────────────────────
  const funnelFilter =
    scope === 'all'     ? '' :
    scope === 'primary' ? `AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = false)`
                        : `AND d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = true)`;

  // ── Client-type filter (b2c = funnels 0,2; b2b = 1,3 — same as sqlGen) ────
  const clientType = sp.get('clientType') ?? 'all';
  const clientFilter =
    clientType === 'b2c' ? 'AND d.funnel_id IN (0, 2)' :
    clientType === 'b2b' ? 'AND d.funnel_id IN (1, 3)' : '';

  // ── Metric filter (generic, from the metrics catalog) ────────────────────
  // Default window: a deal is in scope if ANY of its stage dates falls in the period.
  let metricDateFilter = `(
    d.created_at >= $1 AND d.created_at < $2
    OR d.sold_at >= $1 AND d.sold_at < $2
    OR d.delivered_at >= $1 AND d.delivered_at < $2
    OR d.reserved_at >= $1 AND d.reserved_at < $2
    OR d.confirmed_at >= $1 AND d.confirmed_at < $2
    OR d.lost_at >= $1 AND d.lost_at < $2
  )`;
  let extraJoin = '';

  if (metricFilter && STAGE_NOW_STAGE_IDS.has(metricFilter)) {
    // Снимок «Стадии (сейчас)» — период игнорируется целиком, фильтр — ТЕКУЩИЙ
    // d.stage_id этой группы (список ids — наши же константы, не пользовательский
    // ввод, инлайним напрямую вместо позиционного параметра, чтобы не сдвигать
    // нумерацию $1/$2 ниже). ПРИМЕЧАНИЕ: $1/$2 всё равно ОБЯЗАНЫ где-то встретиться
    // в тексте запроса — иначе Postgres кидает 42P18 «could not determine data type
    // of parameter $1» (параметр без единого упоминания в SQL не типизируется).
    // `$1::timestamptz IS NOT NULL` — заведомо истинно (from/to всегда валидные ISO-
    // строки), просто даёт параметру тип и не меняет результат.
    const ids = STAGE_NOW_STAGE_IDS.get(metricFilter)!;
    metricDateFilter = `d.stage_id IN (${ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',')}) AND $1::timestamptz IS NOT NULL AND $2::timestamptz IS NOT NULL`;
  } else if (metricFilter && DEALS_IN_WORK_METRIC_IDS.includes(metricFilter)) {
    // «Сделок в работе» (перв./повт./все) — период игнорируется, фильтр — семантика
    // sa.stages.stage_type = 'WORK' (см. stageSnapshot.ts); перв./повт./все уже
    // разруливает funnelFilter (scope=primary/repeat/all) выше. Тот же приём с $1/$2
    // (см. комментарий в ветке STAGE_NOW_STAGE_IDS выше).
    extraJoin = `JOIN stages _s_work ON _s_work.id = d.stage_id`;
    metricDateFilter = `_s_work.stage_type = 'WORK' AND $1::timestamptz IS NOT NULL AND $2::timestamptz IS NOT NULL`;
  } else if (metricFilter) {
    const legs = resolveDrilldownLegs(metricFilter, await loadMetrics());
    const metric = legs[0] ?? null;
    if (metric?.dateField) {
      if (metric.source === 'deal_events') {
        // Event-sourced metric (e.g. called_deals_count): deal has a matching event in period
        const evtConds = metric.filters.map(f => resolveFilterClause(f, 'de')).filter(Boolean);
        extraJoin = `JOIN (
          SELECT DISTINCT de.deal_id FROM deal_events de
          WHERE de.${metric.dateField} >= $1 AND de.${metric.dateField} < $2
            ${evtConds.length ? 'AND ' + evtConds.join(' AND ') : ''}
        ) _evt ON _evt.deal_id = d.deal_id`;
        metricDateFilter = '1=1';
      } else {
        // Deals-sourced: same date window + filters the metric itself uses in sqlGen.
        // Multiple legs (composite numerators/sums, see resolveDrilldownLegs) are UNION'd (OR) so
        // every disjoint slice's deals show up, not just the first leg's.
        // IMPORTANT (incident #2351, root cause of the #2348 rollback): this string is spliced
        // into `WHERE ${metricDateFilter} ${dimensionFilter} ...` (see below) with `dimensionFilter`
        // itself starting with `AND ...`. Since SQL binds AND tighter than OR, an UNwrapped
        // "(leg1) OR (leg2)" reads as "(leg1) OR ((leg2) AND managerId=... AND ...)" — the first
        // leg matches with NO dimension/funnel/client filters at all. MUST stay wrapped in one
        // outer set of parens so the whole multi-leg OR binds as a single unit before AND.
        metricDateFilter = '(' + legs
          .map(leg => {
            const conds = [
              `d.${leg.dateField} >= $1 AND d.${leg.dateField} < $2`,
              ...leg.filters.map(f => resolveFilterClause(f, 'd')).filter(Boolean),
            ];
            return `(${conds.join(' AND ')})`;
          })
          .join(' OR ') + ')';
      }
    }
  }

  // ── Dimension filter ──────────────────────────────────────────────────────
  // managerId и productGroup независимы и КОМПОЗИРУЮТСЯ (дрилл «группа × менеджер»
  // из мини-отчёта шлёт оба).
  const params: unknown[] = [fromDate.toISOString(), toExcl.toISOString()];
  let dimensionFilter = '';

  if (managerId) {
    params.push(managerId);
    dimensionFilter = `AND d.current_manager_id = $${params.length}`;
  }
  if (productGroup !== null) {
    if (pgMode === 'kc') {
      if (productGroup === '__none__') {
        dimensionFilter += ` AND d.product_group_id IS NULL`;
      } else {
        params.push(productGroup);
        dimensionFilter += ` AND d.product_group_id::text = $${params.length}`;
      }
    } else {
      // by_max
      if (productGroup === 'Без группы' || productGroup === '__none__') {
        dimensionFilter += ` AND d.head_group_name IS NULL`;
      } else {
        params.push(productGroup);
        dimensionFilter += ` AND d.head_group_name = $${params.length}`;
      }
    }
  }

  // Подытог отдела: сделки менеджеров этого отдела (department_id из org_resolved_hierarchy)
  if (teamId) {
    const res = await analyticsDb().query<{ id: string }>(
      `SELECT manager_bitrix_user_id::text AS id
         FROM sa.org_resolved_hierarchy
        WHERE department_id = $1 AND is_active = true`,
      [teamId],
    );
    dimensionFilter += ` AND ${managerIdsWhere(res.rows.map(r => r.id).filter(id => /^\d+$/.test(id)))}`;
  }

  // Фильтры отчёта по отделам и типу аккаунтов (manager*/logist*) сужают цифры в
  // самом отчёте, поэтому обязаны сужать и список сделок — для ЛЮБОЙ цели дрилл-дауна
  // (раньше применялись только при all=1, из-за чего дрилл по товарной группе
  // показывал сделки всех отделов и не сходился с цифрой).
  if (departmentIds.length || (accountType && accountType !== 'all')) {
    // Оргструктура (org_resolved_hierarchy/departments) переехала в sa (задача Серёги
    // 13.07) → читаем из analyticsDb; employees остаётся в system → systemDb.
    let allowed: Set<string> | null = null;
    if (departmentIds.length) {
      const res = await analyticsDb().query<{ id: string }>(
        `SELECT DISTINCT manager_bitrix_user_id::text AS id
           FROM sa.org_resolved_hierarchy
          WHERE department_id IN (SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1))
            AND is_active = true`,
        [departmentIds],
      );
      allowed = new Set(res.rows.map(r => r.id));
    }
    if (accountType && accountType !== 'all') {
      const prefix = accountType === 'logists' ? 'logist' : 'manager';
      const res = await systemDb().query<{ id: string; login: string | null }>(
        `SELECT bitrix_user_id::text AS id, bitrix_login AS login FROM employees WHERE is_active = true`,
      );
      const byPrefix = new Set(res.rows.filter(r => (r.login ?? '').toLowerCase().startsWith(prefix)).map(r => r.id));
      allowed = allowed ? new Set([...allowed].filter(id => byPrefix.has(id))) : byPrefix;
    }
    if (allowed) {
      dimensionFilter += ` AND ${managerIdsWhere([...allowed].filter(id => /^\d+$/.test(id)))}`;
    }
  }

  // Marketing dimension filter. «Филиал» — менеджерское измерение (по менеджеру сделки);
  // остальные — список source_id из system.marketing_sources.
  // Composes with managerId (drilldown «источник → менеджеры → сделки»).
  if (sourceDim && sourceVal !== null) {
    if (sourceDim === 'branch') {
      dimensionFilter += ` AND ${managerIdsWhere(await resolveBranchManagerIds(sourceVal))}`;
    } else {
      dimensionFilter += ` AND ${sourceIdsWhere(await resolveSourceIds(sourceDim, sourceVal))}`;
    }
  }

  const db = analyticsDb();

  const sql = `
    SELECT
      d.deal_id,
      d.deal_name,
      d.amount,
      d.created_at,
      d.reserved_at,
      d.confirmed_at,
      d.sold_at,
      d.delivered_at,
      d.lost_at,
      NULL::timestamptz AS expected_close_date,  -- нет в sa.deals; форму ответа сохраняем
      d.source_id,
      d.current_manager_id::text AS manager_id,
      s.name  AS stage_name,
      pg.name AS product_group_name,
      d.head_group_name,
      f.name  AS funnel_name
    FROM deals d
    ${extraJoin}
    LEFT JOIN stages s          ON s.id  = d.stage_id
    LEFT JOIN product_groups pg ON pg.id = d.product_group_id
    LEFT JOIN funnels f         ON f.id  = d.funnel_id
    WHERE ${metricDateFilter}
      ${dimensionFilter}
      ${funnelFilter}
      ${clientFilter}
    ORDER BY COALESCE(d.sold_at, d.delivered_at, d.created_at) DESC
    LIMIT 1000
  `;

  const res = await db.query(sql, params);

  // Обогащение из system DB (кэшированные справочники): менеджер + название источника
  const [mgrInfo, srcMap] = await Promise.all([loadManagerInfoMap(), loadSourceMap()]);

  const deals = (res.rows as {
    manager_id: string;
    source_id: string | null;
    head_group_name: string | null;
    product_group_name: string | null;
  }[]).map(r => ({
    ...r,
    manager_name: mgrInfo.get(r.manager_id)?.name ?? (r.manager_id ? `#${r.manager_id}` : null),
    source_name: r.source_id ? (srcMap.get(r.source_id)?.name ?? r.source_id) : null,
    product_group_display: pgMode === 'by_max'
      ? (r.head_group_name    ?? 'Без группы')
      : (r.product_group_name ?? 'Без группы'),
  }));

  return NextResponse.json({ deals });
}
