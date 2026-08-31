import { analyticsDb } from '@/lib/db/clients';
import { getMonthPlansByManager } from '@/lib/reports-builder/plans';
import { listWeatherForYear } from '@/lib/weather/weeklyWeather';
import { ENTITY_DEFS, type EntityKey, type EntityMetrics, type WeekBlock, type MonthBlock, type YearWeeklyResult } from '@/features/year-weekly/shared';

export { ENTITY_DEFS };
export type { EntityKey, EntityMetrics, WeekBlock, MonthBlock, YearWeeklyResult };

// Движок спец-отчёта «Данные по годам» (решения владельца 28.08, дословно в
// BACKLOG): понедельный «год к году» по 12 блокам сущностей, зеркало ручного
// файла «Данные по годам.xlsx».
//
// Определения (владелец, 28.08):
//  * суммы продаж/отгрузок, кол-во сделок, ср. чек — по ВСЕМ сделкам;
//  * «Конв. продажа»/«Конв. отгрузка» — ПЕРВИЧНЫЕ (funnels.is_repeat = false):
//    первичные продажи (sold_at в неделе) / первичные сделки (created_at в
//    неделе), как каноническая «CR Сделка → Продажа (перв.)» каталога.
//    «Разойдутся с историей [ручного файла] — и хуй с ним»;
//  * план недели = месячный план (manager_plans) / 4; план продаж =
//    plan_shipments / plan_n — та же формула, что в отчёте «МОСКВА»;
//  * сопоставление лет — та же ISO-неделя (пн–вс, день недели к дню недели):
//    в файле «13-19 января 2025» стоит против «12-18 января 2026» — обе W03.
//
// Сущности резолвятся ПО ИМЕНАМ отделов в дереве sa.departments (правка
// владельца: «Нулевой СПБ = Департамент НЦ. Металл = металлопрокат, ЖБИ = ЖБИ.
// Все прочее внутри НЦ = Нерудка») — менеджер входит в блок, если якорное имя
// есть в цепочке предков его отдела. Переименование отдела в Битриксе сломает
// блок — это осознанно: явного словаря id владелец не давал, а имена стабильны.

// Якорные ИМЕНА отделов дерева продаж (см. поддерево «Отдел продаж»).
const ANCHORS = {
  spb_os: 'Департамент ОС',
  spb_nc: 'Департамент НЦ',
  spb_zhbi: 'Отдел ЖБИ',
  spb_metal: 'Отдел Металлопроката',
  msk_os: 'МСК ОС',
  msk_nc: 'МСК НЦ',
  msk_zhbi: 'МСК ЖБИ',
  krd: 'Филиал Краснодар',
} as const;

interface Agg {
  deals: number; dealsPrim: number;
  salesSum: number; salesCnt: number; salesPrimCnt: number;
  shipSum: number; shipPrimCnt: number;
}
const zeroAgg = (): Agg => ({ deals: 0, dealsPrim: 0, salesSum: 0, salesCnt: 0, salesPrimCnt: 0, shipSum: 0, shipPrimCnt: 0 });





// ── календарь ────────────────────────────────────────────────────────────────

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function ymd(t: Date): string { return t.toISOString().slice(0, 10); }
function utc(s: string): Date { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function addDays(s: string, n: number): string { const t = utc(s); t.setUTCDate(t.getUTCDate() + n); return ymd(t); }

/** Понедельник ISO-недели № week года year. */
function isoWeekMonday(year: number, week: number): string {
  // ISO: неделя 1 содержит 4 января. Понедельник W1 = 4 янв − (dow(4янв)−1).
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const w1monday = new Date(jan4);
  w1monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  w1monday.setUTCDate(w1monday.getUTCDate() + (week - 1) * 7);
  return ymd(w1monday);
}
function isoWeekOf(monday: string): { year: number; week: number } {
  const thu = utc(addDays(monday, 3));
  const year = thu.getUTCFullYear();
  const w1 = utc(isoWeekMonday(year, 1));
  const week = Math.round((utc(monday).getTime() - w1.getTime()) / (7 * 86400_000)) + 1;
  return { year, week };
}
function weekLabel(monday: string): string {
  const sunday = addDays(monday, 6);
  const [, m1, d1] = monday.split('-').map(Number);
  const [, m2, d2] = sunday.split('-').map(Number);
  if (m1 === m2) return `${d1}-${d2} ${MONTHS_GEN[m1 - 1]}`;
  return `${d1} ${MONTHS_GEN[m1 - 1]} - ${d2} ${MONTHS_GEN[m2 - 1]}`;
}

// ── сущности → менеджеры ─────────────────────────────────────────────────────

async function resolveEntityManagers(): Promise<Record<EntityKey, Set<string>>> {
  const db = analyticsDb();
  const [depts, mgrs] = await Promise.all([
    db.query<{ id: string; name: string; bx: string | null; parent: string | null }>(
      `SELECT id::text AS id, name, bitrix_department_id::text AS bx, parent_bitrix_department_id::text AS parent
         FROM sa.departments WHERE is_active = true`,
    ),
    db.query<{ mgr: string; dept: string | null }>(
      `SELECT manager_bitrix_user_id::text AS mgr, department_id::text AS dept
         FROM sa.org_resolved_hierarchy
        WHERE is_active = true AND manager_bitrix_user_id IS NOT NULL`,
    ),
  ]);
  const byBx = new Map(depts.rows.filter(d => d.bx).map(d => [d.bx!, d]));
  const byId = new Map(depts.rows.map(d => [d.id, d]));

  // Имена всей цепочки предков отдела (включая сам отдел), с guard от циклов.
  const chainCache = new Map<string, Set<string>>();
  const chainNames = (deptId: string | null): Set<string> => {
    if (!deptId) return new Set();
    const hit = chainCache.get(deptId);
    if (hit) return hit;
    const names = new Set<string>();
    let cur = byId.get(deptId);
    for (let i = 0; cur && i < 15; i++) {
      names.add(cur.name);
      cur = cur.parent ? byBx.get(cur.parent) : undefined;
    }
    chainCache.set(deptId, names);
    return names;
  };

  const sets: Record<string, Set<string>> = {};
  for (const k of Object.keys(ANCHORS)) sets[k] = new Set();
  for (const m of mgrs.rows) {
    const names = chainNames(m.dept);
    for (const [key, anchor] of Object.entries(ANCHORS)) {
      if (names.has(anchor)) sets[key].add(m.mgr);
    }
  }
  const minus = (a: Set<string>, ...subs: Set<string>[]) =>
    new Set([...a].filter(x => !subs.some(s => s.has(x))));
  const union = (...xs: Set<string>[]) => new Set(xs.flatMap(s => [...s]));

  return {
    spb_os: sets.spb_os,
    spb_nc: sets.spb_nc,
    // «Все прочее внутри НЦ = Нерудка» (владелец 28.08)
    spb_nerudka: minus(sets.spb_nc, sets.spb_zhbi, sets.spb_metal),
    spb_zhbi: sets.spb_zhbi,
    spb_metal: sets.spb_metal,
    // Итоги — как в файле: СПБ = Общестрой + Нулевой; МСК = ОС + НЦ (ЖБИ МСК
    // в МСК ИТОГО файла НЕ входит — формула BQ=BW+CI, зеркалим).
    spb_total: union(sets.spb_os, sets.spb_nc),
    msk_total: union(sets.msk_os, sets.msk_nc),
    msk_os: sets.msk_os,
    msk_nc: sets.msk_nc,
    msk_zhbi: sets.msk_zhbi,
    krd: sets.krd,
  };
}

// ── факты ────────────────────────────────────────────────────────────────────

const MSK = 'Europe/Moscow';

async function fetchWeeklyFacts(fromYmd: string, toExclYmd: string): Promise<Map<string, Map<string, Agg>>> {
  // Map<weekMonday, Map<managerId, Agg>>
  const db = analyticsDb();
  const bucket = (field: string) =>
    `to_char(date_trunc('week', (d.${field} AT TIME ZONE '${MSK}')), 'YYYY-MM-DD')`;
  const range = (field: string) =>
    `d.${field} >= ($1 || 'T00:00:00+03:00')::timestamptz AND d.${field} < ($2 || 'T00:00:00+03:00')::timestamptz`;

  const [created, sold, delivered] = await Promise.all([
    db.query<{ wk: string; mgr: string; rep: boolean; cnt: string }>(
      `SELECT ${bucket('created_at')} AS wk, d.current_manager_id::text AS mgr, f.is_repeat AS rep, COUNT(*)::text AS cnt
         FROM sa.deals d JOIN funnels f ON f.id = d.funnel_id
        WHERE ${range('created_at')} AND d.current_manager_id IS NOT NULL
        GROUP BY 1, 2, 3`, [fromYmd, toExclYmd]),
    db.query<{ wk: string; mgr: string; rep: boolean; cnt: string; amt: string }>(
      `SELECT ${bucket('sold_at')} AS wk, d.current_manager_id::text AS mgr, f.is_repeat AS rep,
              COUNT(*)::text AS cnt, COALESCE(SUM(d.amount), 0)::text AS amt
         FROM sa.deals d JOIN funnels f ON f.id = d.funnel_id
        WHERE ${range('sold_at')} AND d.current_manager_id IS NOT NULL
        GROUP BY 1, 2, 3`, [fromYmd, toExclYmd]),
    db.query<{ wk: string; mgr: string; rep: boolean; cnt: string; amt: string }>(
      `SELECT ${bucket('delivered_at')} AS wk, d.current_manager_id::text AS mgr, f.is_repeat AS rep,
              COUNT(*)::text AS cnt, COALESCE(SUM(d.amount), 0)::text AS amt
         FROM sa.deals d JOIN funnels f ON f.id = d.funnel_id
        WHERE ${range('delivered_at')} AND d.current_manager_id IS NOT NULL
        GROUP BY 1, 2, 3`, [fromYmd, toExclYmd]),
  ]);

  const out = new Map<string, Map<string, Agg>>();
  const at = (wk: string, mgr: string): Agg => {
    let m = out.get(wk);
    if (!m) { m = new Map(); out.set(wk, m); }
    let a = m.get(mgr);
    if (!a) { a = zeroAgg(); m.set(mgr, a); }
    return a;
  };
  for (const r of created.rows) {
    const a = at(r.wk, r.mgr);
    a.deals += Number(r.cnt);
    if (!r.rep) a.dealsPrim += Number(r.cnt);
  }
  for (const r of sold.rows) {
    const a = at(r.wk, r.mgr);
    a.salesSum += Number(r.amt);
    a.salesCnt += Number(r.cnt);
    if (!r.rep) a.salesPrimCnt += Number(r.cnt);
  }
  for (const r of delivered.rows) {
    const a = at(r.wk, r.mgr);
    a.shipSum += Number(r.amt);
    if (!r.rep) a.shipPrimCnt += Number(r.cnt);
  }
  return out;
}

function sumForEntity(week: Map<string, Agg> | undefined, managers: Set<string>): Agg {
  const t = zeroAgg();
  if (!week) return t;
  for (const [mgr, a] of week) {
    if (!managers.has(mgr)) continue;
    t.deals += a.deals; t.dealsPrim += a.dealsPrim;
    t.salesSum += a.salesSum; t.salesCnt += a.salesCnt; t.salesPrimCnt += a.salesPrimCnt;
    t.shipSum += a.shipSum; t.shipPrimCnt += a.shipPrimCnt;
  }
  return t;
}

function toMetrics(a: Agg): EntityMetrics {
  return {
    deals: a.deals,
    salesSum: Math.round(a.salesSum),
    shipSum: Math.round(a.shipSum),
    crSale: a.dealsPrim > 0 ? a.salesPrimCnt / a.dealsPrim : null,
    crShip: a.dealsPrim > 0 ? a.shipPrimCnt / a.dealsPrim : null,
    avgCheck: a.salesCnt > 0 ? Math.round(a.salesSum / a.salesCnt) : null,
  };
}

function addAgg(dst: Agg, src: Agg): void {
  dst.deals += src.deals; dst.dealsPrim += src.dealsPrim;
  dst.salesSum += src.salesSum; dst.salesCnt += src.salesCnt; dst.salesPrimCnt += src.salesPrimCnt;
  dst.shipSum += src.shipSum; dst.shipPrimCnt += src.shipPrimCnt;
}

// ── сборка ───────────────────────────────────────────────────────────────────

export async function buildYearWeekly(year: number): Promise<YearWeeklyResult> {
  // Недели года: все ISO-недели с четвергом в этом году, не позже текущей.
  const todayMsk = new Date().toLocaleDateString('sv-SE', { timeZone: MSK });
  const mondays: string[] = [];
  for (let w = 1; w <= 53; w++) {
    const mon = isoWeekMonday(year, w);
    if (isoWeekOf(mon).year !== year) break; // W53 бывает не каждый год
    if (mon > todayMsk) break;
    mondays.push(mon);
  }

  // Та же ISO-неделя прошлого года (день недели к дню недели, как в файле).
  // Если у прошлого года не было W53 — isoWeekMonday вернёт понедельник уже
  // текущего года, и такая пара честно останется пустой.
  const prevMondays = mondays.map(mon => isoWeekMonday(year - 1, isoWeekOf(mon).week));

  // Диапазон фактов: от понедельника ПЕРВОЙ прошлогодней недели (W1 может
  // начинаться в декабре позапрошлого года — 2025-W1 = 30.12.2024) до конца
  // последней недели текущего года.
  const factsFrom = prevMondays[0] ?? `${year - 1}-01-01`;
  const factsToExcl = addDays(mondays[mondays.length - 1] ?? `${year}-01-01`, 7);
  const [managers, facts, weather] = await Promise.all([
    resolveEntityManagers(),
    fetchWeeklyFacts(factsFrom, factsToExcl),
    listWeatherForYear(year),
  ]);

  // Планы: месячные суммы по сущностям (по месяцам года). Кэш по месяцу.
  const months = [...new Set(mondays.map(m => Number(addDays(m, 3).slice(5, 7))))];
  const planByMonth = new Map<number, { sales: Record<EntityKey, number | null>; ship: Record<EntityKey, number | null> }>();
  for (const mo of months) {
    const monthFirst = `${year}-${String(mo).padStart(2, '0')}-01`;
    const byMgr = await getMonthPlansByManager(monthFirst);
    const sales = {} as Record<EntityKey, number | null>;
    const ship = {} as Record<EntityKey, number | null>;
    for (const e of ENTITY_DEFS) {
      let s = 0, sh = 0, found = false;
      for (const mgr of managers[e.key]) {
        const p = byMgr.get(mgr);
        if (p) { s += p.sales; sh += p.shipments; found = true; }
      }
      sales[e.key] = found ? Math.round(s) : null;
      ship[e.key] = found ? Math.round(sh) : null;
    }
    planByMonth.set(mo, { sales, ship });
  }

  const weeks: WeekBlock[] = mondays.map((mon, i) => {
    const prevMon = prevMondays[i];
    const month = Number(addDays(mon, 3).slice(5, 7));
    const plan = planByMonth.get(month);
    const cur = {} as Record<EntityKey, EntityMetrics>;
    const prev = {} as Record<EntityKey, EntityMetrics>;
    const planSales = {} as Record<EntityKey, number | null>;
    const planShip = {} as Record<EntityKey, number | null>;
    for (const e of ENTITY_DEFS) {
      cur[e.key] = toMetrics(sumForEntity(facts.get(mon), managers[e.key]));
      prev[e.key] = toMetrics(sumForEntity(facts.get(prevMon), managers[e.key]));
      // План недели = месяц / 4 (решение владельца 28.08).
      planSales[e.key] = plan?.sales[e.key] != null ? Math.round(plan.sales[e.key]! / 4) : null;
      planShip[e.key] = plan?.ship[e.key] != null ? Math.round(plan.ship[e.key]! / 4) : null;
    }
    return { weekStart: mon, label: weekLabel(mon), prevWeekStart: prevMon, prevLabel: weekLabel(prevMon), month, cur, prev, planSales, planShip };
  });

  // Месячные ИТОГО: суммы сырых агрегатов недель месяца (конверсии/чек — от
  // сумм, не среднее точек); план = сумма недельных планов (зеркало файла:
  // ИТОГО план в нём — сумма строк «План», т.е. месяц/4 × число недель).
  const monthBlocks: MonthBlock[] = [];
  const MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  for (const mo of months) {
    const weeksOfMonth = weeks.filter(w => w.month === mo);
    if (weeksOfMonth.length === 0) continue;
    const cur = {} as Record<EntityKey, EntityMetrics>;
    const prev = {} as Record<EntityKey, EntityMetrics>;
    const planSales = {} as Record<EntityKey, number | null>;
    const planShip = {} as Record<EntityKey, number | null>;
    for (const e of ENTITY_DEFS) {
      const aggCur = zeroAgg(); const aggPrev = zeroAgg();
      for (const w of weeksOfMonth) {
        addAgg(aggCur, sumForEntity(facts.get(w.weekStart), managers[e.key]));
        addAgg(aggPrev, sumForEntity(facts.get(w.prevWeekStart), managers[e.key]));
      }
      cur[e.key] = toMetrics(aggCur);
      prev[e.key] = toMetrics(aggPrev);
      const anyPlan = weeksOfMonth.some(w => w.planSales[e.key] != null);
      planSales[e.key] = anyPlan ? weeksOfMonth.reduce((s, w) => s + (w.planSales[e.key] ?? 0), 0) : null;
      planShip[e.key] = anyPlan ? weeksOfMonth.reduce((s, w) => s + (w.planShip[e.key] ?? 0), 0) : null;
    }
    monthBlocks.push({ month: mo, label: `ИТОГО ${MONTH_NOM[mo - 1]}`, cur, prev, planSales, planShip });
  }

  return { year, entities: ENTITY_DEFS, weeks, months: monthBlocks, weather };
}
