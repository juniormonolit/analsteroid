// Движок раздела «Презентация» (ТЗ владельца 11.08, BACKLOG «Раздел „Презентация“»).
// Источник формата и набора метрик — согласованный макет разовой версии по Москве
// (WORKLOG 2026-08-11): план/факт-дашборд, динамика по дням, год к году,
// менеджеры по группам, товарные группы в двух системах группировки.
//
// «Группа» (единица слайдов и строк план/факта) — выбранные отделы пикера
// отчётов (bitrix_department_id из sa.departments, выбор родителя покрывает всё
// его поддерево). Пустой выбор = группировка по филиалам (branch из
// sa.org_resolved_hierarchy) — «вся компания» без настройки.
//
// Набор метрик окна (список владельца 11.08): продажи/отгрузки первичные и
// повторные (первичность — funnels.is_repeat, как в отчётах), входящие
// все/первичные (знаменатель первичной CR), ППО — ВТОРАЯ по хронологии отгрузка
// клиента (та же семантика, что спец-фильтр _ppo в lib/metrics/sqlGen.ts).
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getMonthWorkingDays } from '@/lib/plans/dailyPlan';

export interface MetricWindow {
  sales_p: number; sales_r: number;        // суммы продаж, ₽
  sales_n_p: number; sales_n_r: number;    // продажи, шт
  ship_p: number; ship_r: number;          // суммы отгрузок, ₽
  ship_n_p: number;                        // отгрузки перв., шт (числитель CR в отгрузку)
  inbound: number; inbound_p: number;      // входящие все / первичные
  ppo: number;                             // вторые отгрузки клиентов, шт
}

export interface PresentationGroup { key: string; name: string }

export interface ManagerRow extends MetricWindow { managerId: number; name: string }
export interface ProductGroupRow extends MetricWindow { name: string }
export interface DailyPoint { d: string; sales: number; ship: number; n: number }

export interface PresentationData {
  groups: PresentationGroup[];
  /** План/факт: месяц конца периода к дате конца периода (та же формула, что
   *  dailyMoscowReport: план продаж = plan_shipments/plan_n, MTD = месячный ×
   *  прошедшие/всего рабочих дней через lib/plans/dailyPlan). */
  planFact: {
    monthFirstDay: string; asOf: string;
    workingDays: { total: number; passed: number };
    byGroup: Record<string, { planSalesMtd: number; planShipMtd: number; factSales: number; factShip: number }>;
    total: { planSalesMtd: number; planShipMtd: number; factSales: number; factShip: number };
  };
  period: { byGroup: Record<string, MetricWindow>; total: MetricWindow };
  comparison: { total: MetricWindow };
  yoy: { byGroup: Record<string, MetricWindow>; total: MetricWindow;
         prevByGroup: Record<string, MetricWindow>; prevTotal: MetricWindow;
         from: string; to: string; prevFrom: string; prevTo: string };
  daily: { cur: DailyPoint[]; prev: DailyPoint[] };
  managers: Record<string, ManagerRow[]>;
  productGroups: { kc: ProductGroupRow[]; by_max: ProductGroupRow[] };
}

export interface PresentationOptions {
  /** bitrix_department_id выбранных отделов; пусто = все (группировка по филиалам) */
  departmentIds: string[];
  periodFrom: string; periodTo: string;           // YYYY-MM-DD, МСК
  comparisonFrom: string; comparisonTo: string;
}

// Агрегатные колонки одного окна [$1=from, $2=to] по сделкам менеджеров $3.
// Дата события приводится к МСК — как в отчётах.
const METRIC_COLS = `
  coalesce(sum(d.amount) FILTER (WHERE d.sold_at IS NOT NULL AND (d.sold_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND NOT coalesce(f.is_repeat,false)),0)::float8 AS sales_p,
  coalesce(sum(d.amount) FILTER (WHERE d.sold_at IS NOT NULL AND (d.sold_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND coalesce(f.is_repeat,false)),0)::float8 AS sales_r,
  count(*) FILTER (WHERE d.sold_at IS NOT NULL AND (d.sold_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND NOT coalesce(f.is_repeat,false))::int AS sales_n_p,
  count(*) FILTER (WHERE d.sold_at IS NOT NULL AND (d.sold_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND coalesce(f.is_repeat,false))::int AS sales_n_r,
  coalesce(sum(d.amount) FILTER (WHERE d.delivered_at IS NOT NULL AND (d.delivered_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND NOT coalesce(f.is_repeat,false)),0)::float8 AS ship_p,
  coalesce(sum(d.amount) FILTER (WHERE d.delivered_at IS NOT NULL AND (d.delivered_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND coalesce(f.is_repeat,false)),0)::float8 AS ship_r,
  count(*) FILTER (WHERE d.delivered_at IS NOT NULL AND (d.delivered_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND NOT coalesce(f.is_repeat,false))::int AS ship_n_p,
  count(*) FILTER (WHERE (d.created_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date)::int AS inbound,
  count(*) FILTER (WHERE (d.created_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND NOT coalesce(f.is_repeat,false))::int AS inbound_p,
  count(*) FILTER (WHERE d.delivered_at IS NOT NULL AND (d.delivered_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date AND o.rn = 2)::int AS ppo`;

// rn=2 — вторая отгрузка клиента за всю историю (ППО). Оконная функция вместо
// коррелированного подзапроса — тот же приём, что _ppo в sqlGen.ts (O(n²)-грабли
// уже наступали, см. PROJECT_OVERVIEW).
const PPO_JOIN = `LEFT JOIN (
    SELECT deal_id, ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY delivered_at) AS rn
      FROM sa.deals WHERE delivered_at IS NOT NULL AND contact_id IS NOT NULL
  ) o ON o.deal_id = d.deal_id`;

const zeroWindow = (): MetricWindow => ({
  sales_p: 0, sales_r: 0, sales_n_p: 0, sales_n_r: 0,
  ship_p: 0, ship_r: 0, ship_n_p: 0, inbound: 0, inbound_p: 0, ppo: 0,
});
const WINDOW_KEYS = Object.keys(zeroWindow()) as (keyof MetricWindow)[];

function addWindow(acc: MetricWindow, w: MetricWindow): void {
  for (const k of WINDOW_KEYS) acc[k] += w[k];
}

interface RosterRow {
  mgr: number; manager_name: string; dept_uuid: string | null;
  branch: string | null; short_login: string | null;
}
interface DeptRow { bitrix_id: string; name: string; parent_bitrix_id: string | null }

/** Год назад той же датой; 29 февраля прижимается к 28-му. */
function yearBack(iso: string): string {
  const y = Number(iso.slice(0, 4)) - 1;
  const md = iso.slice(5) === '02-29' ? '02-28' : iso.slice(5);
  return `${y}-${md}`;
}

export async function buildPresentation(opts: PresentationOptions): Promise<PresentationData> {
  const sa = analyticsDb();

  const [deptsRes, rosterRes] = await Promise.all([
    sa.query<DeptRow>(
      `SELECT bitrix_department_id AS bitrix_id, name, parent_bitrix_department_id AS parent_bitrix_id
         FROM sa.departments WHERE is_active = true`),
    sa.query<RosterRow>(
      `SELECT manager_bitrix_user_id::int AS mgr, manager_name, department_id::text AS dept_uuid,
              branch, short_login
         FROM sa.org_resolved_hierarchy WHERE is_active = true`),
  ]);

  // uuid отдела менеджера → bitrixId отдела (иерархия ходит по bitrix-ид).
  const uuidToBitrix = new Map<string, string>();
  const parentOf = new Map<string, string | null>();
  const deptName = new Map<string, string>();
  {
    const res = await sa.query<{ id: string; bitrix_id: string }>(
      `SELECT id::text AS id, bitrix_department_id AS bitrix_id FROM sa.departments WHERE is_active = true`);
    for (const r of res.rows) uuidToBitrix.set(r.id, r.bitrix_id);
  }
  for (const d of deptsRes.rows) { parentOf.set(d.bitrix_id, d.parent_bitrix_id); deptName.set(d.bitrix_id, d.name); }

  // Группы слайдов. Выбор отделов: пикер выделяет всё поддерево, поэтому
  // корни групп — выбранные узлы, чей родитель НЕ выбран (иначе каждый
  // подотдел стал бы отдельным слайдом-дубликатом родителя).
  const selected = new Set(opts.departmentIds);
  const byBranch = selected.size === 0;
  let groups: PresentationGroup[];
  const groupOfManager = new Map<number, string>();

  if (byBranch) {
    const branches = [...new Set(rosterRes.rows.map(r => r.branch).filter((b): b is string => !!b))].sort();
    groups = branches.map(b => ({ key: b, name: b }));
    for (const r of rosterRes.rows) if (r.branch) groupOfManager.set(r.mgr, r.branch);
  } else {
    const roots = [...selected].filter(id => {
      let p = parentOf.get(id) ?? null;
      while (p) { if (selected.has(p)) return false; p = parentOf.get(p) ?? null; }
      return true;
    });
    groups = roots.map(id => ({ key: id, name: deptName.get(id) ?? `Отдел ${id}` }));
    const rootSet = new Set(roots);
    for (const r of rosterRes.rows) {
      if (!r.dept_uuid) continue;
      let cur: string | null = uuidToBitrix.get(r.dept_uuid) ?? null;
      while (cur) { // вверх по иерархии до первого корня группы
        if (rootSet.has(cur)) { groupOfManager.set(r.mgr, cur); break; }
        cur = parentOf.get(cur) ?? null;
      }
    }
  }

  const managerIds = [...groupOfManager.keys()];
  const nameOf = new Map(rosterRes.rows.map(r => [r.mgr, r.manager_name]));
  if (managerIds.length === 0) {
    return {
      groups, planFact: { monthFirstDay: '', asOf: opts.periodTo, workingDays: { total: 0, passed: 0 }, byGroup: {}, total: { planSalesMtd: 0, planShipMtd: 0, factSales: 0, factShip: 0 } },
      period: { byGroup: {}, total: zeroWindow() }, comparison: { total: zeroWindow() },
      yoy: { byGroup: {}, total: zeroWindow(), prevByGroup: {}, prevTotal: zeroWindow(), from: '', to: '', prevFrom: '', prevTo: '' },
      daily: { cur: [], prev: [] }, managers: {}, productGroups: { kc: [], by_max: [] },
    };
  }

  // Окна: период, сравнение, год-к-году = месяц-до-даты ПО КОНЦУ периода
  // (пример владельца: период 12–19.07 → 1–19.07 этого и прошлого года).
  const yoyFrom = `${opts.periodTo.slice(0, 7)}-01`;
  const yoyTo = opts.periodTo;
  const windows = {
    period: [opts.periodFrom, opts.periodTo],
    comparison: [opts.comparisonFrom, opts.comparisonTo],
    yoy: [yoyFrom, yoyTo],
    yoyPrev: [yearBack(yoyFrom), yearBack(yoyTo)],
  } as const;

  const winQuery = (f: string, t: string) => sa.query<MetricWindow & { mgr: number }>(
    `SELECT d.current_manager_id::int AS mgr, ${METRIC_COLS}
       FROM sa.deals d LEFT JOIN sa.funnels f ON f.id = d.funnel_id ${PPO_JOIN}
      WHERE d.current_manager_id = ANY($3::int[]) GROUP BY 1`,
    [f, t, managerIds]);

  // Товарные группы — две системы, как в отчётах (byProductGroups.ts):
  // kc = product_group_id → sa.product_groups.name, by_max = head_group_name.
  const pgQuery = (mode: 'kc' | 'by_max') => sa.query<MetricWindow & { name: string }>(
    `SELECT ${mode === 'kc' ? `COALESCE(pg.name,'Без группы')` : `COALESCE(d.head_group_name,'Без группы')`} AS name, ${METRIC_COLS}
       FROM sa.deals d LEFT JOIN sa.funnels f ON f.id = d.funnel_id ${PPO_JOIN}
       ${mode === 'kc' ? 'LEFT JOIN sa.product_groups pg ON pg.id = d.product_group_id' : ''}
      WHERE d.current_manager_id = ANY($3::int[])
        AND ((d.sold_at IS NOT NULL AND (d.sold_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date)
          OR (d.delivered_at IS NOT NULL AND (d.delivered_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date)
          OR ((d.created_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date))
      GROUP BY 1`,
    [opts.periodFrom, opts.periodTo, managerIds]);

  // Динамика по дням — продажи/отгрузки/шт за оба диапазона (для графика).
  const dailyQuery = (f: string, t: string) => sa.query<{ d: string; sales: number; ship: number; n: number }>(
    `SELECT dt::text AS d, coalesce(sum(sales),0)::float8 AS sales, coalesce(sum(ship),0)::float8 AS ship, coalesce(sum(n),0)::int AS n FROM (
       SELECT (sold_at AT TIME ZONE 'Europe/Moscow')::date AS dt, amount AS sales, 0::numeric AS ship, 1 AS n
         FROM sa.deals WHERE current_manager_id = ANY($3::int[]) AND sold_at IS NOT NULL
          AND (sold_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date
       UNION ALL
       SELECT (delivered_at AT TIME ZONE 'Europe/Moscow')::date, 0, amount, 0
         FROM sa.deals WHERE current_manager_id = ANY($3::int[]) AND delivered_at IS NOT NULL
          AND (delivered_at AT TIME ZONE 'Europe/Moscow')::date BETWEEN $1::date AND $2::date
     ) t GROUP BY 1 ORDER BY 1`,
    [f, t, managerIds]);

  const monthFirstDay = yoyFrom;
  const [wPeriod, wComparison, wYoy, wYoyPrev, pgKc, pgMax, dCur, dPrev, plansRes, workingDays] = await Promise.all([
    winQuery(...windows.period), winQuery(...windows.comparison),
    winQuery(...windows.yoy), winQuery(...windows.yoyPrev),
    pgQuery('kc'), pgQuery('by_max'),
    dailyQuery(opts.periodFrom, opts.periodTo), dailyQuery(opts.comparisonFrom, opts.comparisonTo),
    systemDb().query<{ manager_login: string; plan_shipments: string; plan_n: string | null }>(
      `SELECT manager_login, plan_shipments, plan_n FROM manager_plans WHERE month = $1::date`, [monthFirstDay]),
    getMonthWorkingDays(monthFirstDay, opts.periodTo),
  ]);

  // Разложение окна по группам + итог.
  const splitByGroup = (rows: (MetricWindow & { mgr: number })[]) => {
    const byGroup: Record<string, MetricWindow> = {};
    for (const g of groups) byGroup[g.key] = zeroWindow();
    const total = zeroWindow();
    for (const r of rows) {
      const g = groupOfManager.get(r.mgr);
      if (!g) continue;
      addWindow(byGroup[g], r); addWindow(total, r);
    }
    return { byGroup, total };
  };
  const period = splitByGroup(wPeriod.rows);
  const comparison = splitByGroup(wComparison.rows);
  const yoyCur = splitByGroup(wYoy.rows);
  const yoyPrev = splitByGroup(wYoyPrev.rows);

  // План/факт: план менеджера — manager_plans по short_login (кросс-БД джойн в
  // коде, как getMonthPlans в dailyMoscowReport.ts), план продаж = ship/plan_n,
  // MTD = месячный × passed/total.
  const mgrByLogin = new Map<string, number>();
  for (const r of rosterRes.rows) if (r.short_login && groupOfManager.has(r.mgr)) mgrByLogin.set(r.short_login, r.mgr);
  const mtdFactor = workingDays.total > 0 ? workingDays.passed / workingDays.total : 0;
  const planFactByGroup: PresentationData['planFact']['byGroup'] = {};
  for (const g of groups) {
    planFactByGroup[g.key] = {
      planSalesMtd: 0, planShipMtd: 0,
      factSales: yoyCur.byGroup[g.key].sales_p + yoyCur.byGroup[g.key].sales_r,
      factShip: yoyCur.byGroup[g.key].ship_p + yoyCur.byGroup[g.key].ship_r,
    };
  }
  const planTotal = { planSalesMtd: 0, planShipMtd: 0,
    factSales: yoyCur.total.sales_p + yoyCur.total.sales_r,
    factShip: yoyCur.total.ship_p + yoyCur.total.ship_r };
  for (const p of plansRes.rows) {
    const mgr = mgrByLogin.get(p.manager_login);
    if (mgr === undefined) continue; // семантика INNER JOIN — план без менеджера в выборке не считаем
    const g = groupOfManager.get(mgr)!;
    const ship = parseFloat(p.plan_shipments) || 0;
    const n = parseFloat(p.plan_n ?? '') || 0;
    const sales = n > 0 ? ship / n : ship;
    planFactByGroup[g].planSalesMtd += sales * mtdFactor;
    planFactByGroup[g].planShipMtd += ship * mtdFactor;
    planTotal.planSalesMtd += sales * mtdFactor;
    planTotal.planShipMtd += ship * mtdFactor;
  }

  // Менеджеры по группам за период — все строки, топ-N решает клиент.
  const managers: Record<string, ManagerRow[]> = {};
  for (const g of groups) managers[g.key] = [];
  for (const r of wPeriod.rows) {
    const g = groupOfManager.get(r.mgr);
    if (!g) continue;
    if (r.sales_p + r.sales_r === 0 && r.ship_p + r.ship_r === 0 && r.inbound === 0) continue;
    const { mgr, ...w } = r;
    managers[g].push({ managerId: mgr, name: nameOf.get(mgr) ?? `#${mgr}`, ...w });
  }
  for (const g of groups) managers[g.key].sort((a, b) => (b.sales_p + b.sales_r) - (a.sales_p + a.sales_r));

  const cleanPg = (rows: (MetricWindow & { name: string })[]): ProductGroupRow[] =>
    rows.map(r => ({ ...r }))
        .sort((a, b) => (b.sales_p + b.sales_r) - (a.sales_p + a.sales_r));

  return {
    groups,
    planFact: { monthFirstDay, asOf: opts.periodTo, workingDays, byGroup: planFactByGroup, total: planTotal },
    period, comparison: { total: comparison.total },
    yoy: { byGroup: yoyCur.byGroup, total: yoyCur.total,
           prevByGroup: yoyPrev.byGroup, prevTotal: yoyPrev.total,
           from: yoyFrom, to: yoyTo, prevFrom: windows.yoyPrev[0], prevTo: windows.yoyPrev[1] },
    daily: { cur: dCur.rows, prev: dPrev.rows },
    managers,
    productGroups: { kc: cleanPg(pgKc.rows), by_max: cleanPg(pgMax.rows) },
  };
}
