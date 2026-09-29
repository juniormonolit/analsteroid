// Агрегация метрик «Реализации» (М1–М9, М11; М4 — отдельно по интервалам;
// М5 — просрочки на сегодня). Чистые функции без БД — тестируются
// scripts/assert-realizations.ts. Формулы — предложение Софьи (задача #7971).
import { regionOf, type Region } from './region';

export type Grp = 'shipped' | 'cancelled' | 'in_work';

export interface ReqRow {
  id: string;
  number: string;
  doc_date: string | null;
  status: string;
  grp: Grp;
  buyer: string | null;
  manager: string | null;
  logist_id: string | null;
  logist: string | null;
  shipment_date: string;          // YYYY-MM-DD
  creation_date_1c: string | null;
  sales_nv: number | null;
  sales_vat: number | null;
  d_sale: number | null;
  purchases_n: number | null;
  broken: boolean;
  purch_nv: number | null;
  d_cost: number | null;
  first_ship: string | null;
  first_new: string | null;
  first_take: string | null;
  had_fix: boolean;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

/** Нормализация строки pg (numeric приходит строкой, timestamptz — Date). */
export function toReqRow(r: Record<string, unknown>): ReqRow {
  return {
    id: String(r.id), number: String(r.number ?? ''), doc_date: iso(r.doc_date), status: String(r.status ?? ''),
    grp: (r.grp as Grp) ?? 'in_work', buyer: (r.buyer as string) ?? null, manager: (r.manager as string) ?? null,
    logist_id: (r.logist_id as string) ?? null, logist: (r.logist as string) ?? null,
    shipment_date: String(r.shipment_date), creation_date_1c: iso(r.creation_date_1c),
    sales_nv: num(r.sales_nv), sales_vat: num(r.sales_vat), d_sale: num(r.d_sale),
    purchases_n: num(r.purchases_n), broken: r.broken === true, purch_nv: num(r.purch_nv), d_cost: num(r.d_cost),
    first_ship: iso(r.first_ship), first_new: iso(r.first_new), first_take: iso(r.first_take), had_fix: r.had_fix === true,
  };
}

/** Маржа заявки считается, только если она отгружена, есть приобретения и нет задвоенных. */
export function inMarginBase(r: ReqRow): boolean {
  return r.grp === 'shipped' && (r.purchases_n ?? 0) > 0 && !r.broken;
}
export function requestMargin(r: Pick<ReqRow, 'purchases_n' | 'broken' | 'sales_nv' | 'purch_nv'>): number | null {
  if ((r.purchases_n ?? 0) === 0 || r.broken) return null;
  return (r.sales_nv ?? 0) - (r.purch_nv ?? 0);
}

/** Дата события по МСК (YYYY-MM-DD). */
export function mskDate(isoTs: string): string {
  const d = new Date(new Date(isoTs).getTime() + 3 * 3600_000);
  return d.toISOString().slice(0, 10);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
}
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const pct = (a: number, b: number): number | null => (b ? (100 * a) / b : null);

export interface SummaryRow {
  key: string;            // logist_id | регион | '__total'
  label: string;
  region: Region | null;
  total: number; shipped: number; cancelled: number; inWork: number;
  cancelPct: number | null;
  shipWithHist: number; onTimePct: number | null;     // М2
  cycleDaysMed: number | null;                        // М3
  reactHoursMed: number | null;                       // М4 (реакция)
  fixPct: number | null;                              // М6
  shippedNoPurchase: number;                          // М7
  salesNv: number; avgCheckNv: number | null;         // М8
  marginBaseN: number; exclBroken: number;            // М9
  mSalesNv: number; mPurchNv: number; marginNv: number | null; marginPct: number | null;
  dSale: number; dCost: number; dCostToSalePct: number | null; // М11
  overdue: number; overdue30: number; oldestOverdue: string | null; // М5
}

export interface OverdueRow { logist_id: string | null; shipment_date: string }

function aggregate(key: string, label: string, region: Region | null, rows: ReqRow[], overdue: OverdueRow[], today: string): SummaryRow {
  const shipped = rows.filter(r => r.grp === 'shipped');
  const withHist = shipped.filter(r => r.first_ship);
  const onTime = withHist.filter(r => mskDate(r.first_ship!) <= r.shipment_date).length;
  const cycles = withHist
    .map(r => { const start = r.first_new ?? r.creation_date_1c; return start ? (Date.parse(r.first_ship!) - Date.parse(start)) / 86_400_000 : null; })
    .filter((x): x is number => x !== null);
  const reacts = rows
    .filter(r => r.first_new && r.first_take)
    .map(r => (Date.parse(r.first_take!) - Date.parse(r.first_new!)) / 3_600_000);
  const base = shipped.filter(inMarginBase);
  const mSales = base.reduce((a, r) => a + (r.sales_nv ?? 0), 0);
  const mPurch = base.reduce((a, r) => a + (r.purch_nv ?? 0), 0);
  const salesNv = shipped.reduce((a, r) => a + (r.sales_nv ?? 0), 0);
  const dRows = shipped.filter(r => !r.broken);
  const dSale = dRows.reduce((a, r) => a + (r.d_sale ?? 0), 0);
  const dCost = dRows.reduce((a, r) => a + (r.d_cost ?? 0), 0);
  const limit30 = new Date(Date.parse(today) - 30 * 86_400_000).toISOString().slice(0, 10);
  const oldest = overdue.reduce<string | null>((m, o) => (m === null || o.shipment_date < m ? o.shipment_date : m), null);
  const cancelled = rows.filter(r => r.grp === 'cancelled').length;
  return {
    key, label, region,
    total: rows.length, shipped: shipped.length, cancelled, inWork: rows.length - shipped.length - cancelled,
    cancelPct: pct(cancelled, rows.length),
    shipWithHist: withHist.length, onTimePct: pct(onTime, withHist.length),
    cycleDaysMed: median(cycles), reactHoursMed: median(reacts),
    fixPct: pct(shipped.filter(r => r.had_fix).length, shipped.length),
    shippedNoPurchase: shipped.filter(r => (r.purchases_n ?? 0) === 0).length,
    salesNv, avgCheckNv: shipped.length ? salesNv / shipped.length : null,
    marginBaseN: base.length, exclBroken: shipped.filter(r => r.broken).length,
    mSalesNv: mSales, mPurchNv: mPurch,
    marginNv: base.length ? mSales - mPurch : null, marginPct: base.length && mSales ? (100 * (mSales - mPurch)) / mSales : null,
    dSale, dCost, dCostToSalePct: dSale ? (100 * dCost) / dSale : null,
    overdue: overdue.length, overdue30: overdue.filter(o => o.shipment_date < limit30).length, oldestOverdue: oldest,
  };
}

export interface LogistRef { id: string; name: string }

/** Сводка: строки по логистам (или регионам) + «Итого». Просрочки — все даты, по логисту заявки. */
export function buildSummary(
  rows: ReqRow[], overdue: OverdueRow[], by: 'logist' | 'region', today: string,
  logistNames: Map<string, string>,
): { rows: SummaryRow[]; total: SummaryRow } {
  const keyOf = (logistId: string | null, name: string | null): string =>
    by === 'logist' ? (logistId ?? '__none') : regionOf(name ?? (logistId ? logistNames.get(logistId) : null));
  const groups = new Map<string, { rows: ReqRow[]; od: OverdueRow[]; name: string | null }>();
  const get = (k: string, name: string | null) => {
    let g = groups.get(k);
    if (!g) { g = { rows: [], od: [], name }; groups.set(k, g); }
    return g;
  };
  for (const r of rows) get(keyOf(r.logist_id, r.logist), r.logist).rows.push(r);
  for (const o of overdue) {
    const name = o.logist_id ? logistNames.get(o.logist_id) ?? null : null;
    get(keyOf(o.logist_id, name), name).od.push(o);
  }
  const out: SummaryRow[] = [];
  for (const [k, g] of groups) {
    if (by === 'logist') {
      const label = k === '__none' ? 'Логист не указан' : (g.name ?? logistNames.get(k) ?? '—');
      out.push(aggregate(k, label, regionOf(label === 'Логист не указан' ? null : label), g.rows, g.od, today));
    } else {
      out.push(aggregate(k, k, k as Region, g.rows, g.od, today));
    }
  }
  out.sort((a, b) => b.total - a.total || b.overdue - a.overdue || a.label.localeCompare(b.label, 'ru'));
  return { rows: out, total: aggregate('__total', 'Итого', null, rows, overdue, today) };
}

export interface StatusInterval { logist_id: string | null; status: string; hours: number }
export interface StatusTimeRow { status: string; n: number; medianH: number | null; p90H: number | null }

/** М4: время в статусе — медиана и 90-й процентиль, статусы с < minN интервалами скрыты. */
export function statusTimes(xs: StatusInterval[], minN = 20): StatusTimeRow[] {
  const by = new Map<string, number[]>();
  for (const x of xs) { const a = by.get(x.status) ?? []; a.push(x.hours); by.set(x.status, a); }
  return [...by.entries()]
    .filter(([, a]) => a.length >= minN)
    .map(([status, a]) => ({ status, n: a.length, medianH: median(a), p90H: percentile(a, 0.9) }))
    .sort((a, b) => b.n - a.n);
}
