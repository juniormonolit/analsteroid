import { analyticsDb, systemDb } from '@/lib/db/clients';

// ── Дайджест «Как дела?» — факты ─────────────────────────────────────────────
//
// Один снимок «на час X дня D»: продажи (sold_at) до этого часа по компании,
// филиалам, отделам, менеджерам и товарным группам — против ДНЕВНОГО плана
// (месячный план продаж / рабочих дней) и против «обычного» уровня к тому же
// часу (среднее по последним USUAL_DAYS будним дням). Плюс брони и новые сделки
// как здоровье воронки. Для вечернего выпуска — темп месяца по продажам и
// отгрузкам отдельно: доля плана на сегодня против ТИПИЧНОЙ доли, которую
// компания обычно набирает к этому рабочему дню (по прошлым месяцам).
//
// «Обычно» намеренно считается по последним будням, а не по календарному
// месяцу: так сентябрьский вторник сравнивается с сентябрьскими же днями, и
// сезонность не мешает. Праздники в рабочих днях не учитываются — как и в
// planMetrics (там та же логика Пн–Пт).

const USUAL_DAYS = 10;
const PACE_MONTHS = 6;

export const BRANCH_LABEL: Record<string, string> = {
  'СПб': 'Санкт-Петербург',
  'Москва/МО': 'Москва',
  'Краснодар': 'Краснодар',
};
export const BRANCH_ORDER = ['СПб', 'Москва/МО', 'Краснодар'];

export interface Amt { n: number; amt: number }
export interface UnitFact {
  key: string;
  name: string;
  sales: Amt;
  usual: Amt;
  /** Дневной план продаж, ₽; null — планов у юнита нет. */
  plan: number | null;
  books: Amt;
  usualBooks: Amt;
  created: Amt;
  usualCreated: Amt;
}
export interface DeptFact extends UnitFact { branch: string }
export interface ManagerFact {
  id: string; name: string; branch: string; dept: string;
  sales: Amt; usual: Amt; plan: number | null; active: boolean;
}
export interface GroupFact {
  branch: string; group: string; today: Amt; usual: Amt;
  /** today.amt / usual.amt; Infinity — обычно ноль. */
  ratio: number;
}
export interface PaceLine {
  /** Факт с начала месяца по конец дня D. */
  mtd: number;
  plan: number;
  /** Доля плана, набранная к концу дня D (0..1+). */
  share: number | null;
  /** Типичная доля месяца, набираемая к рабочему дню N (0..1). */
  typicalShare: number | null;
  /** Прогноз месяца: mtd / typicalShare. */
  forecast: number | null;
  /** Среднедневная сумма, нужная до конца месяца, чтобы выйти на план. */
  needPerDay: number | null;
}
export interface PaceCurve {
  /** Накопленный факт по рабочим дням 1..N (₽). */
  fact: number[];
  /** Типичная накопленная доля месяца по рабочим дням 1..всего (0..1). */
  typical: (number | null)[];
}
export interface MonthPace {
  workdayNum: number;
  workdaysInMonth: number;
  company: { sales: PaceLine; shipments: PaceLine; curves: { sales: PaceCurve; shipments: PaceCurve } };
  branches: { key: string; name: string; sales: PaceLine; shipments: PaceLine }[];
}

export interface HowAreWeFacts {
  dateStr: string;
  cutHour: number;
  workdayNum: number;
  workdaysInMonth: number;
  usualDays: number;
  company: UnitFact;
  branches: UnitFact[];
  departments: DeptFact[];
  managers: ManagerFact[];
  groups: GroupFact[];
  month: MonthPace | null;
}

interface OrgRow { short_login: string | null; mid: string; manager_name: string; department_name: string | null; branch: string | null; is_active: boolean }
interface DayRow { day: string; mid: string; grp: string | null; n: number; amt: string | null }

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d);
}
function isoWeekday(s: string): number { const w = new Date(`${s}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; }
export function isWeekday(s: string): boolean { return isoWeekday(s) <= 5; }

/** Будни месяца (Пн–Пт) — как рабочие дни в планах. */
export function monthWorkdays(dateStr: string): string[] {
  const [y, m] = dateStr.split('-').map(Number);
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (new Date(`${s}T00:00:00Z`).getUTCMonth() !== m - 1) break;
    if (isWeekday(s)) out.push(s);
  }
  return out;
}

/** Последние N будней строго до dateStr. */
function previousWeekdays(dateStr: string, n: number): string[] {
  const out: string[] = [];
  let cur = dateStr;
  while (out.length < n) { cur = addDays(cur, -1); if (isWeekday(cur)) out.push(cur); }
  return out.reverse();
}

const zero = (): Amt => ({ n: 0, amt: 0 });
function add(a: Amt, r: DayRow) { a.n += r.n; a.amt += Number(r.amt ?? 0); }
function avg(a: Amt, days: number): Amt { return { n: a.n / days, amt: a.amt / days }; }

async function fetchDayRows(col: 'sold_at' | 'reserved_at' | 'created_at', days: string[], cutHour: number): Promise<DayRow[]> {
  // Один запрос на колонку: все нужные дни, обрезка по МСК-часу. День — строкой,
  // чтобы драйвер не превращал date в полуночный Date серверной зоны.
  const r = await analyticsDb().query<DayRow>(
    `SELECT to_char(${col} AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
            current_manager_id::text AS mid, head_group_name AS grp,
            count(*)::int AS n, sum(amount)::text AS amt
       FROM sa.deals
      WHERE ${col} >= ($1::date)::timestamp AT TIME ZONE 'Europe/Moscow'
        AND ${col} <  (($2::date + 1))::timestamp AT TIME ZONE 'Europe/Moscow'
        AND (${col} AT TIME ZONE 'Europe/Moscow')::time < make_time($3::int, 0, 0)
        AND current_manager_id IS NOT NULL
      GROUP BY 1, 2, 3`,
    [days[0], days[days.length - 1], cutHour],
  );
  return r.rows;
}

async function fetchOrg(): Promise<OrgRow[]> {
  const r = await analyticsDb().query<OrgRow>(
    `SELECT short_login, manager_bitrix_user_id::text AS mid, manager_name, department_name, branch, is_active
       FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id IS NOT NULL`,
  );
  return r.rows;
}

/** Планы месяца по логину: продажи = отгрузки / коэффициент plan_n (как planMetrics). */
async function fetchMonthPlans(month: string): Promise<Map<string, { sales: number; shipments: number }>> {
  const r = await systemDb().query<{ manager_login: string; plan_shipments: string; plan_n: string }>(
    `SELECT manager_login, plan_shipments, plan_n FROM manager_plans WHERE to_char(month, 'YYYY-MM') = $1`, [month],
  );
  const out = new Map<string, { sales: number; shipments: number }>();
  for (const row of r.rows) {
    const ship = parseFloat(row.plan_shipments); const k = parseFloat(row.plan_n);
    if (!Number.isFinite(ship) || !Number.isFinite(k) || k <= 0) continue;
    out.set(row.manager_login, { sales: ship / k, shipments: ship });
  }
  return out;
}

export async function computeHowAreWeFacts(dateStr: string, cutHour: number): Promise<HowAreWeFacts> {
  const month = dateStr.slice(0, 7);
  const workdays = monthWorkdays(dateStr);
  const workdaysInMonth = workdays.length;
  const workdayNum = workdays.filter(d => d <= dateStr).length;
  const usualDays = previousWeekdays(dateStr, USUAL_DAYS);
  const allDays = [...usualDays, dateStr];

  const [org, plans, sales, books, created] = await Promise.all([
    fetchOrg(), fetchMonthPlans(month),
    fetchDayRows('sold_at', allDays, cutHour),
    fetchDayRows('reserved_at', allDays, cutHour),
    fetchDayRows('created_at', allDays, cutHour),
  ]);
  const orgById = new Map(org.map(o => [o.mid, o]));
  const usualSet = new Set(usualDays);

  // Дневные планы по юнитам.
  const dayPlanByMid = new Map<string, number>();
  for (const o of org) {
    const p = o.short_login ? plans.get(o.short_login) : undefined;
    if (p) dayPlanByMid.set(o.mid, p.sales / workdaysInMonth);
  }
  const sumPlan = (pred: (o: OrgRow) => boolean): number | null => {
    let s = 0; let any = false;
    for (const [mid, p] of dayPlanByMid) { const o = orgById.get(mid)!; if (pred(o)) { s += p; any = true; } }
    return any ? s : null;
  };

  const mkUnit = (key: string, name: string, pred: (o: OrgRow) => boolean): UnitFact => {
    const u: UnitFact = { key, name, sales: zero(), usual: zero(), plan: sumPlan(pred), books: zero(), usualBooks: zero(), created: zero(), usualCreated: zero() };
    const feed = (rows: DayRow[], today: Amt, hist: Amt) => {
      for (const r of rows) {
        const o = orgById.get(r.mid); if (!o || !pred(o)) continue;
        if (r.day === dateStr) add(today, r); else if (usualSet.has(r.day)) add(hist, r);
      }
    };
    feed(sales, u.sales, u.usual); feed(books, u.books, u.usualBooks); feed(created, u.created, u.usualCreated);
    u.usual = avg(u.usual, usualDays.length); u.usualBooks = avg(u.usualBooks, usualDays.length); u.usualCreated = avg(u.usualCreated, usualDays.length);
    return u;
  };

  const company = mkUnit('company', 'Компания', () => true);
  const branches = BRANCH_ORDER.map(b => mkUnit(b, BRANCH_LABEL[b] ?? b, o => o.branch === b));

  const deptKeys = new Map<string, { branch: string; name: string }>();
  for (const o of org) if (o.branch && o.department_name) deptKeys.set(`${o.branch}|${o.department_name}`, { branch: o.branch, name: o.department_name });
  const departments: DeptFact[] = [...deptKeys.entries()]
    .map(([k, v]) => ({ ...mkUnit(k, v.name, o => o.branch === v.branch && o.department_name === v.name), branch: v.branch }))
    .filter(d => d.plan != null || d.sales.n > 0 || d.usual.n > 0);

  // Менеджеры.
  const mSales = new Map<string, Amt>(); const mUsual = new Map<string, Amt>();
  for (const r of sales) {
    const t = r.day === dateStr ? mSales : usualSet.has(r.day) ? mUsual : null; if (!t) continue;
    const a = t.get(r.mid) ?? zero(); add(a, r); t.set(r.mid, a);
  }
  const managers: ManagerFact[] = org
    .filter(o => o.branch && (mSales.has(o.mid) || mUsual.has(o.mid) || dayPlanByMid.has(o.mid)))
    .map(o => ({
      id: o.mid, name: o.manager_name, branch: o.branch!, dept: o.department_name ?? '',
      sales: mSales.get(o.mid) ?? zero(), usual: avg(mUsual.get(o.mid) ?? zero(), usualDays.length),
      plan: dayPlanByMid.get(o.mid) ?? null, active: o.is_active,
    }));

  // Товарные группы по филиалам.
  const gToday = new Map<string, Amt>(); const gUsual = new Map<string, Amt>();
  for (const r of sales) {
    const o = orgById.get(r.mid); if (!o?.branch || !r.grp) continue;
    const t = r.day === dateStr ? gToday : usualSet.has(r.day) ? gUsual : null; if (!t) continue;
    const k = `${o.branch}|${r.grp}`; const a = t.get(k) ?? zero(); add(a, r); t.set(k, a);
  }
  const groups: GroupFact[] = [...new Set([...gToday.keys(), ...gUsual.keys()])].map(k => {
    const [branch, group] = k.split('|');
    const today = gToday.get(k) ?? zero(); const usual = avg(gUsual.get(k) ?? zero(), usualDays.length);
    return { branch, group, today, usual, ratio: usual.amt > 0 ? today.amt / usual.amt : (today.amt > 0 ? Infinity : 1) };
  });

  const monthPace = cutHour >= 18 ? await computeMonthPace(dateStr, org, plans, workdayNum, workdaysInMonth) : null;

  return { dateStr, cutHour, workdayNum, workdaysInMonth, usualDays: usualDays.length, company, branches, departments, managers, groups, month: monthPace };
}

// ── Темп месяца ──────────────────────────────────────────────────────────────

interface MonthDayRow { month: string; day: string; branch: string | null; amt: string }

async function fetchMonthDaily(col: 'sold_at' | 'delivered_at', fromMonth: string, toDate: string): Promise<MonthDayRow[]> {
  const r = await analyticsDb().query<MonthDayRow>(
    `SELECT to_char(d.${col} AT TIME ZONE 'Europe/Moscow', 'YYYY-MM') AS month,
            to_char(d.${col} AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
            o.branch, sum(d.amount)::text AS amt
       FROM sa.deals d
       LEFT JOIN sa.org_resolved_hierarchy o ON o.manager_bitrix_user_id = d.current_manager_id
      WHERE d.${col} >= ($1 || '-01')::date::timestamp AT TIME ZONE 'Europe/Moscow'
        AND d.${col} <  (($2::date + 1))::timestamp AT TIME ZONE 'Europe/Moscow'
      GROUP BY 1, 2, 3`,
    [fromMonth, toDate],
  );
  return r.rows;
}

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Типичная доля месяца, набранная к рабочему дню N: среднее по прошлым месяцам
 *  (сумма по будням 1..N включительно / сумма месяца). Выходные сделки относятся
 *  к ближайшему следующему рабочему дню — иначе они бы выпадали из доли. */
function typicalShare(rows: MonthDayRow[], months: string[], workdayNum: number, pred: (branch: string | null) => boolean): number | null {
  const shares: number[] = [];
  for (const m of months) {
    const wd = monthWorkdays(`${m}-01`);
    let cum = 0; let total = 0;
    for (const r of rows) {
      if (r.month !== m || !pred(r.branch)) continue;
      const a = Number(r.amt); total += a;
      const idx = wd.findIndex(d => d >= r.day); // -1 → после последнего буднего = хвост месяца
      const n = idx === -1 ? wd.length : idx + 1;
      if (n <= workdayNum) cum += a;
    }
    if (total > 0) shares.push(cum / total);
  }
  if (!shares.length) return null;
  return shares.reduce((s, v) => s + v, 0) / shares.length;
}

function paceLine(mtd: number, plan: number, typical: number | null, workdayNum: number, workdaysInMonth: number): PaceLine {
  const left = workdaysInMonth - workdayNum;
  return {
    mtd, plan,
    share: plan > 0 ? mtd / plan : null,
    typicalShare: typical,
    forecast: typical && typical > 0 ? mtd / typical : null,
    needPerDay: plan > 0 && left > 0 ? Math.max(0, plan - mtd) / left : null,
  };
}

async function computeMonthPace(
  dateStr: string, org: OrgRow[], plans: Map<string, { sales: number; shipments: number }>,
  workdayNum: number, workdaysInMonth: number,
): Promise<MonthPace> {
  const month = dateStr.slice(0, 7);
  const fromMonth = shiftMonth(month, -PACE_MONTHS);
  const pastMonths = Array.from({ length: PACE_MONTHS }, (_, i) => shiftMonth(month, -PACE_MONTHS + i));
  const [sold, shipped] = await Promise.all([fetchMonthDaily('sold_at', fromMonth, dateStr), fetchMonthDaily('delivered_at', fromMonth, dateStr)]);

  const planSum = (pred: (o: OrgRow) => boolean) => {
    let s = 0, sh = 0;
    for (const o of org) { const p = o.short_login ? plans.get(o.short_login) : undefined; if (p && pred(o)) { s += p.sales; sh += p.shipments; } }
    return { sales: s, shipments: sh };
  };
  const mtd = (rows: MonthDayRow[], pred: (b: string | null) => boolean) =>
    rows.filter(r => r.month === month && pred(r.branch)).reduce((s, r) => s + Number(r.amt), 0);

  const build = (predO: (o: OrgRow) => boolean, predB: (b: string | null) => boolean) => {
    const p = planSum(predO);
    return {
      sales: paceLine(mtd(sold, predB), p.sales, typicalShare(sold, pastMonths, workdayNum, predB), workdayNum, workdaysInMonth),
      shipments: paceLine(mtd(shipped, predB), p.shipments, typicalShare(shipped, pastMonths, workdayNum, predB), workdayNum, workdaysInMonth),
    };
  };
  // Кривые для картинки: факт нарастающим по рабочим дням месяца и типичная доля
  // к каждому рабочему дню (по тем же прошлым месяцам).
  const curve = (rows: MonthDayRow[]): PaceCurve => {
    const wd = monthWorkdays(dateStr);
    const perDay = new Array<number>(wd.length).fill(0);
    for (const r of rows) {
      if (r.month !== month) continue;
      const idx = wd.findIndex(d => d >= r.day);
      perDay[idx === -1 ? wd.length - 1 : idx] += Number(r.amt);
    }
    const fact: number[] = []; let acc = 0;
    for (let i = 0; i < workdayNum; i++) { acc += perDay[i]; fact.push(acc); }
    const typical = wd.map((_, i) => typicalShare(rows, pastMonths, i + 1, () => true));
    return { fact, typical };
  };
  return {
    workdayNum, workdaysInMonth,
    company: { ...build(() => true, () => true), curves: { sales: curve(sold), shipments: curve(shipped) } },
    branches: BRANCH_ORDER.map(b => ({ key: b, name: BRANCH_LABEL[b] ?? b, ...build(o => o.branch === b, br => br === b) })),
  };
}
