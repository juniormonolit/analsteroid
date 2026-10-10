import { analyticsDb } from '@/lib/db/clients';
import { getManagerOrgMap } from '@/lib/org/deptCategories';
import { loadManagerInfoMap } from '@/lib/marketing/sources';
import { getWorkingDaysByMonthInRange, getMonthWorkingDays } from '@/lib/plans/dailyPlan';
import { toZonedTime } from 'date-fns-tz';
import {
  DATASET, SHEET_SCOPES, OUT_OF_SHEET_LABEL, familyOf, getSheet, resolveSheetRowLabel,
  type BlockKind, type BlockUnit, type FunnelSplit, type ProductFamily, type SheetRow,
} from '../sheets';

// ── «ССП тест», листы отделов и «Менеджеры» ──────────────────────────────────
// Факт — sa.deals по четырём датам-стадиям (created/sold/delivered/lost), один
// запрос на дату за весь год, агрегат «менеджер × месяц × воронка × товарная
// группа». Дальше всё в памяти: менеджер → лист (deptCategories + особые случаи
// из SHEET_SCOPES), head_group_name → строка листа (sheets.ts), блоки показателей
// — формулы ниже (deriveBlock). Первичные/повторные — funnels.is_repeat, как у
// метрик каталога (funnel_type).

const TZ = 'Europe/Moscow';

interface Agg {
  shipAmt: number; shipCnt: number; salesAmt: number; salesCnt: number;
  lostCnt: number; createdCnt: number; managers: Set<string>;
}
const zeroAgg = (): Agg => ({ shipAmt: 0, shipCnt: 0, salesAmt: 0, salesCnt: 0, lostCnt: 0, createdCnt: 0, managers: new Set() });
const addAgg = (into: Agg, a: Agg) => {
  into.shipAmt += a.shipAmt; into.shipCnt += a.shipCnt; into.salesAmt += a.salesAmt; into.salesCnt += a.salesCnt;
  into.lostCnt += a.lostCnt; into.createdCnt += a.createdCnt; for (const m of a.managers) into.managers.add(m);
};

interface RawRow { mgr: string; month: number; rep: boolean; b2b: boolean; group: string | null; agg: Agg }

interface RawFacts { year: number; rows: RawRow[]; at: number }
let _raw: RawFacts | null = null;
const RAW_TTL_MS = 5 * 60 * 1000;

async function loadRawFacts(year: number): Promise<RawRow[]> {
  if (_raw && _raw.year === year && Date.now() - _raw.at < RAW_TTL_MS) return _raw.rows;
  const db = analyticsDb();
  const from = `${year}-01-01`, to = `${year + 1}-01-01`;
  // b2b — воронки юрлиц (funnel_id 1/3, как client_type=b2b в sqlGen).
  const q = (field: string) => db.query<{ m: string; mgr: string; rep: boolean; b2b: boolean; hg: string | null; cnt: string; amt: string }>(
    `SELECT to_char(date_trunc('month', (d.${field} AT TIME ZONE '${TZ}')), 'MM') AS m,
            d.current_manager_id::text AS mgr, f.is_repeat AS rep, (d.funnel_id IN (1, 3)) AS b2b, d.head_group_name AS hg,
            COUNT(DISTINCT d.deal_id)::text AS cnt, COALESCE(SUM(d.amount), 0)::text AS amt
       FROM sa.deals d JOIN funnels f ON f.id = d.funnel_id
      WHERE d.${field} >= ($1 || 'T00:00:00+03:00')::timestamptz AND d.${field} < ($2 || 'T00:00:00+03:00')::timestamptz
        AND d.current_manager_id IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5`, [from, to]);
  const [created, sold, delivered, lost] = await Promise.all([q('created_at'), q('sold_at'), q('delivered_at'), q('lost_at')]);

  const map = new Map<string, RawRow>();
  const at = (r: { m: string; mgr: string; rep: boolean; b2b: boolean; hg: string | null }): Agg => {
    const key = `${r.mgr}|${r.m}|${r.rep ? 1 : 0}|${r.b2b ? 1 : 0}|${r.hg ?? ''}`;
    let row = map.get(key);
    if (!row) { row = { mgr: r.mgr, month: Number(r.m) - 1, rep: r.rep, b2b: r.b2b, group: r.hg, agg: zeroAgg() }; map.set(key, row); }
    return row.agg;
  };
  for (const r of created.rows) { const a = at(r); a.createdCnt += Number(r.cnt); a.managers.add(r.mgr); }
  for (const r of sold.rows) { const a = at(r); a.salesCnt += Number(r.cnt); a.salesAmt += Number(r.amt); }
  for (const r of delivered.rows) { const a = at(r); a.shipCnt += Number(r.cnt); a.shipAmt += Number(r.amt); }
  for (const r of lost.rows) { const a = at(r); a.lostCnt += Number(r.cnt); }
  const rows = [...map.values()].filter(r => r.month >= 0 && r.month < 12);
  _raw = { year, rows, at: Date.now() };
  return rows;
}

// ── Календарь ────────────────────────────────────────────────────────────────
export interface Calendar {
  year: number; today: string; currentMonth: number; currentMonthWeight: number;
  workingDays: { total: number; passed: number };
  /** Рабочих дней по месяцам: всего в месяце и прошедших (для «/день»). */
  monthWd: { total: number; passed: number }[];
}

/** asOf — дата среза YYYY-MM-DD (по умолчанию сегодня МСК): «как шли по плану на конец сентября». */
export async function loadCalendar(year: number, asOf?: string): Promise<Calendar> {
  const now = asOf ? new Date(`${asOf}T12:00:00Z`) : toZonedTime(new Date(), TZ);
  const today = now.toISOString().slice(0, 10);
  const nowYear = now.getFullYear();
  const currentMonth = year < nowYear ? 11 : year > nowYear ? -1 : now.getMonth();
  const rangeTo = year < nowYear ? `${year}-12-31` : today;
  const monthWd: { total: number; passed: number }[] = Array.from({ length: 12 }, () => ({ total: 20, passed: 0 }));
  if (currentMonth >= 0) {
    const chunks = await getWorkingDaysByMonthInRange(`${year}-01-01`, rangeTo);
    for (const c of chunks) {
      const i = Number(c.month.slice(5, 7)) - 1;
      monthWd[i] = { total: c.workingDaysInMonth, passed: c.workingDaysInRange };
    }
  }
  const cur = currentMonth >= 0 && year === nowYear
    ? await getMonthWorkingDays(`${year}-${String(currentMonth + 1).padStart(2, '0')}-01`, today)
    : { total: 1, passed: 1 };
  const currentMonthWeight = year < nowYear ? 1 : year > nowYear ? 0 : (cur.total > 0 ? Math.min(1, cur.passed / cur.total) : 0);
  if (currentMonth >= 0 && year === nowYear) monthWd[currentMonth] = { total: cur.total, passed: cur.passed };
  return { year, today, currentMonth, currentMonthWeight, workingDays: { total: cur.total, passed: cur.passed }, monthWd };
}

// ── Менеджер → лист ──────────────────────────────────────────────────────────
interface ManagerScope { branch: string; category: string | null }

async function loadManagerScopes(): Promise<Map<string, ManagerScope>> {
  const orgMap = await getManagerOrgMap();
  const out = new Map<string, ManagerScope>();
  for (const [id, info] of orgMap) {
    out.set(id, { branch: info.branch, category: info.category ? `${info.branch}:${info.category}` : null });
  }
  return out;
}

function managerInSheet(scope: ManagerScope | undefined, sheetName: string): boolean {
  const s = SHEET_SCOPES[sheetName];
  if (!s || !s.category || !scope) return false;
  if (s.category.endsWith(':*')) return scope.branch === s.category.slice(0, -2);
  return scope.category === s.category;
}

function familyAllowed(family: ProductFamily, sheetName: string): boolean {
  const s = SHEET_SCOPES[sheetName];
  if (!s) return false;
  if (s.family && family !== s.family) return false;
  if (s.excludeFamilies?.includes(family)) return false;
  return true;
}

// ── Блоки показателей ────────────────────────────────────────────────────────
type Measure = (a: Agg, wd: { total: number; passed: number }, isCurrent: boolean) => number | null;
const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);
const perDay = (n: number, wd: { total: number; passed: number }, isCurrent: boolean) =>
  ratio(n, isCurrent ? wd.passed : wd.total);

/** Формулы факта по ключу блока. null — факт не считается (лиды, заходы на сайт). */
const MEASURES: Record<string, Measure | null> = {
  ship_sum: a => a.shipAmt,
  sales_sum: a => a.salesAmt,
  avg_check: a => ratio(a.salesAmt + a.shipAmt, a.salesCnt + a.shipCnt),
  ship_cnt: a => a.shipCnt,
  sales_cnt: a => a.salesCnt,
  sales_per_day: (a, wd, c) => perDay(a.salesCnt, wd, c),
  lost_cnt: a => a.lostCnt,
  deals_cnt: a => a.createdCnt,
  deals_per_day: (a, wd, c) => perDay(a.createdCnt, wd, c),
  mops: a => a.managers.size,
  leads: null,
  leads_per_day: null,
  site_visits: null,
  cv_deal_sale: a => ratio(a.salesCnt, a.createdCnt),
  cv_sale_ship: a => ratio(a.shipCnt, a.salesCnt),
  cv_deal_ship: a => ratio(a.shipCnt, a.createdCnt),
  cv_ship_closed: a => ratio(a.shipCnt, a.shipCnt + a.lostCnt),
  churn_pct: a => ratio(a.salesCnt - a.shipCnt, a.salesCnt),
};

/** Блоки, где строки по товарным группам факта не имеют (считается только ИТОГО). */
const TOTAL_ONLY = new Set(['mops']);

export interface PlanFactLine {
  label: string;
  planMonths: number[] | null;
  planYear: number | null;
  factMonths: (number | null)[];
  factYtd: number | null;
  planToDate: number | null;
  /** Строка есть только в факте (товарная группа вне листа). */
  extra?: boolean;
}

export interface SheetBlockResult {
  key: string; label: string; kind: BlockKind; unit: BlockUnit; hasSplit: boolean; factAvailable: boolean;
  splits: Partial<Record<FunnelSplit, { total: PlanFactLine; rows: PlanFactLine[] }>>;
}

export interface SheetResult extends Calendar {
  sheet: string;
  note: string | null;
  factAvailable: boolean;
  blocks: SheetBlockResult[];
  importedAt: string;
  sourceFile: string;
}

function planToDate(plan: number[] | null, kind: BlockKind, cal: Calendar): number | null {
  if (!plan) return null;
  if (cal.currentMonth < 0) return kind === 'sum' ? 0 : null;
  let s = 0, w = 0;
  for (let i = 0; i <= cal.currentMonth && i < 12; i++) {
    const weight = i === cal.currentMonth ? cal.currentMonthWeight : 1;
    s += plan[i] * weight; w += weight;
  }
  if (kind === 'sum') return s;
  return w > 0 ? s / w : null; // ratio — средневзвешенное планов прошедших месяцев
}

function buildLine(
  label: string, plan: SheetRow | null, split: FunnelSplit, kind: BlockKind,
  measure: Measure | null, byMonth: Agg[] | null, cal: Calendar, extra = false,
): PlanFactLine {
  const planMonths = plan ? (split === 'all' ? plan.months : split === 'primary' ? (plan.primary ?? null) : (plan.repeat ?? null)) : null;
  const factMonths: (number | null)[] = new Array(12).fill(null);
  let factYtd: number | null = null;
  if (measure && byMonth) {
    const ytd = zeroAgg();
    const wdYtd = { total: 0, passed: 0 };
    for (let i = 0; i <= cal.currentMonth && i < 12; i++) {
      const isCur = i === cal.currentMonth;
      factMonths[i] = measure(byMonth[i], cal.monthWd[i], isCur);
      addAgg(ytd, byMonth[i]);
      wdYtd.passed += cal.monthWd[i].passed;
    }
    // Для «/день» за YTD делим на прошедшие рабочие дни года.
    factYtd = cal.currentMonth >= 0 ? measure(ytd, { total: wdYtd.passed, passed: wdYtd.passed }, true) : null;
  }
  return {
    label, planMonths, planYear: plan ? (split === 'all' ? plan.year : (planMonths ? planMonths.reduce((a, b) => a + b, 0) : null)) : null,
    factMonths, factYtd, planToDate: planToDate(planMonths, kind, cal), ...(extra ? { extra: true } : {}),
  };
}

export async function buildSheetResult(sheetName: string, year: number, asOf?: string): Promise<SheetResult | null> {
  const sheet = getSheet(sheetName);
  if (!sheet) return null;
  const scope = SHEET_SCOPES[sheetName] ?? { category: null };
  const factAvailable = !!scope.category;

  const [cal, raw, scopes] = await Promise.all([loadCalendar(year, asOf), loadRawFacts(year), factAvailable ? loadManagerScopes() : Promise.resolve(new Map<string, ManagerScope>())]);

  // Агрегат листа: split → строка → месяц → Agg. Строки — метки листа (из первого блока)
  // плюс служебная «вне листа».
  const sheetLabels = sheet.blocks[0]?.rows.map(r => r.label) ?? [];
  const splits: FunnelSplit[] = ['all', 'primary', 'repeat'];
  const byRow = new Map<string, Agg[][]>(); // label → [splitIdx][month]
  const rowAgg = (label: string): Agg[][] => {
    let v = byRow.get(label);
    if (!v) { v = splits.map(() => Array.from({ length: 12 }, zeroAgg)); byRow.set(label, v); }
    return v;
  };
  const TOTAL = '__total__';
  if (factAvailable) {
    for (const r of raw) {
      if (!managerInSheet(scopes.get(r.mgr), sheetName)) continue;
      if (scope.b2bOnly && !r.b2b) continue;
      if (!familyAllowed(familyOf(r.group), sheetName)) continue;
      const label = resolveSheetRowLabel(r.group, sheetLabels) ?? OUT_OF_SHEET_LABEL;
      const targets = [rowAgg(label), rowAgg(TOTAL)];
      for (const t of targets) {
        addAgg(t[0][r.month], r.agg);
        addAgg(t[r.rep ? 2 : 1][r.month], r.agg);
      }
    }
  }

  const blocks: SheetBlockResult[] = sheet.blocks.map(b => {
    const measure = MEASURES[b.key] ?? null;
    const blockFact = factAvailable && !!measure;
    const result: SheetBlockResult = { key: b.key, label: b.label, kind: b.kind, unit: b.unit, hasSplit: b.hasSplit, factAvailable: blockFact, splits: {} };
    const useSplits: FunnelSplit[] = b.hasSplit ? splits : ['all'];
    for (const split of useSplits) {
      const si = splits.indexOf(split);
      // deals_cnt «(первичных)»: в режиме «все» — только первичные, как в метке блока.
      const effSi = b.key === 'deals_cnt' && split === 'all' ? 1 : si;
      const total = buildLine('ИТОГО', b.total, split, b.kind, blockFact ? measure : null, byRow.get(TOTAL)?.[effSi] ?? null, cal);
      const rows = b.rows.map(r => buildLine(r.label, r, split, b.kind, blockFact && !TOTAL_ONLY.has(b.key) ? measure : null, byRow.get(r.label)?.[effSi] ?? null, cal));
      const extraAgg = byRow.get(OUT_OF_SHEET_LABEL);
      if (blockFact && !TOTAL_ONLY.has(b.key) && extraAgg) {
        const line = buildLine(OUT_OF_SHEET_LABEL, null, split, b.kind, measure, extraAgg[effSi], cal, true);
        if (line.factMonths.some(v => v !== null && v !== 0)) rows.push(line);
      }
      result.splits[split] = { total, rows };
    }
    return result;
  });

  return { ...cal, sheet: sheetName, note: scope.note ?? null, factAvailable, blocks, importedAt: DATASET.importedAt, sourceFile: DATASET.sourceFile };
}

// ── Лист «Менеджеры» ─────────────────────────────────────────────────────────
export interface ManagerLine extends PlanFactLine {
  key: string; bitrixId: string | null; scope: string | null; inOrg: boolean;
}
export interface ManagersBlockResult {
  key: 'ship_sum' | 'sales_sum'; label: string;
  splits: Partial<Record<FunnelSplit, { total: PlanFactLine; rows: ManagerLine[] }>>;
}
export interface ManagersResult extends Calendar {
  blocks: ManagersBlockResult[];
  importedAt: string; sourceFile: string;
}

export const SCOPE_LABELS: Record<string, string> = {
  zero_cycle: 'СПБ НЦ', stroy: 'СПБ ОС', msk: 'МСК', krd: 'КРД', new: 'Новые',
};

export async function buildManagersResult(year: number, asOf?: string): Promise<ManagersResult> {
  const [cal, raw, info] = await Promise.all([loadCalendar(year, asOf), loadRawFacts(year), loadManagerInfoMap()]);
  const splits: FunnelSplit[] = ['all', 'primary', 'repeat'];
  // менеджер → [split][month]
  const byMgr = new Map<string, Agg[][]>();
  for (const r of raw) {
    let v = byMgr.get(r.mgr);
    if (!v) { v = splits.map(() => Array.from({ length: 12 }, zeroAgg)); byMgr.set(r.mgr, v); }
    addAgg(v[0][r.month], r.agg);
    addAgg(v[r.rep ? 2 : 1][r.month], r.agg);
  }
  const blocks: ManagersBlockResult[] = DATASET.managers.blocks.map(b => {
    const measure = MEASURES[b.key]!;
    const out: ManagersBlockResult = { key: b.key, label: b.label, splits: {} };
    for (const split of splits) {
      const si = splits.indexOf(split);
      const rows: ManagerLine[] = b.managers
        .filter(m => m.bitrixId || m.name || m.months.some(v => v !== 0))
        .map(m => {
          const plan: SheetRow = { label: m.key, year: m.year, months: m.months, primary: m.primary, repeat: m.repeat };
          const org = m.bitrixId ? info.get(m.bitrixId) : undefined;
          const line = buildLine(org?.name ?? m.name ?? m.key, plan, split, 'sum', measure, m.bitrixId ? (byMgr.get(m.bitrixId)?.[si] ?? Array.from({ length: 12 }, zeroAgg)) : null, cal);
          return { ...line, key: m.key, bitrixId: m.bitrixId, scope: m.scope, inOrg: !!org };
        });
      // ИТОГО — сумма строк (план из листа может содержать #VALUE!, поэтому не доверяем ячейке).
      const totalPlan = new Array(12).fill(0) as number[];
      const totalAgg = Array.from({ length: 12 }, zeroAgg);
      for (const r of rows) {
        r.planMonths?.forEach((v, i) => { totalPlan[i] += v; });
        if (r.bitrixId) byMgr.get(r.bitrixId)?.[si].forEach((a, i) => addAgg(totalAgg[i], a));
      }
      const total = buildLine('ИТОГО', { label: 'ИТОГО', year: totalPlan.reduce((a, c) => a + c, 0), months: totalPlan, primary: totalPlan, repeat: totalPlan }, 'all', 'sum', measure, totalAgg, cal);
      out.splits[split] = { total, rows };
    }
    return out;
  });
  return { ...cal, blocks, importedAt: DATASET.importedAt, sourceFile: DATASET.sourceFile };
}
