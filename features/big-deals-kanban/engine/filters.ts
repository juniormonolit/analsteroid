// Фильтры и сортировка карточек «Канбана больших чеков». Одни и те же условия (BigFilters) у доски, «Сегодня»,
// своих колонок, аналитики и массового закрытия — matchFilters здесь, реэкспорт из board.ts.
import { BIG_COLUMNS, BIG_DEALS_GROUP_IDS, type BigColumnKey } from './config';
import type { BigFilters, BigSort, BigTaskCard, BigTaskState } from './types';

export const cardAmount = (c: BigTaskCard) => c.deal?.amount || c.taskAmount || 0;

const DAY = 86_400_000;
const STATES: readonly BigTaskState[] = ['unread', 'pending', 'in_progress', 'control', 'done', 'deferred'];
const COLUMN_KEYS = new Set<string>(BIG_COLUMNS.map(c => c.key));
const SORTS: readonly BigSort[] = ['default', 'sum', 'days', 'created', 'idle'];

/** Дата YYYY-MM-DD по Москве. */
export const mskDate = (iso: string | number) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
const lower = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Дней без изменений (changedAt, иначе createdAt). */
export const idleDays = (c: BigTaskCard, now = Date.now()) =>
  Math.max(0, Math.floor((now - new Date(c.changedAt ?? c.createdAt).getTime()) / DAY));

/** Подходит ли карточка под условия. Карточка должна быть «состарена» на now (withAge) — daysInColumn/stuck.
 *  noCalls: звонки неизвестны (БД звонков недоступна, calls = null) — НЕ подходит (для массового закрытия безопаснее).
 *  deal 'open': сделка не закрыта ИЛИ сделки нет. */
export function matchFilters(c: BigTaskCard, f: BigFilters, now = Date.now()): boolean {
  if (f.groups?.length && !f.groups.includes(c.groupId)) return false;
  if (f.manager && c.responsible.id !== f.manager && c.deal?.assigned?.id !== f.manager) return false;
  if (f.products?.length && !c.productGroups.some(g => f.products!.includes(g))) return false;
  if (f.columns?.length && !f.columns.includes(c.column)) return false;
  if (f.states?.length && !f.states.includes(c.state)) return false;
  if (f.hideLost && (c.column === 'lost_check' || c.column === 'lost_done')) return false;
  if (f.unassigned && (!c.unassigned || c.state === 'done' || c.column === 'sold' || c.column === 'lost_check' || c.column === 'lost_done')) return false;
  const amount = cardAmount(c);
  if (f.sumMin != null && amount < f.sumMin) return false;
  if (f.sumMax != null && amount > f.sumMax) return false;
  if (f.createdFrom || f.createdTo) {
    const d = mskDate(c.createdAt);
    if (f.createdFrom && d < f.createdFrom) return false;
    if (f.createdTo && d > f.createdTo) return false;
  }
  if (f.daysMin != null && c.daysInColumn < f.daysMin) return false;
  if (f.idleDaysMin != null && idleDays(c, now) < f.idleDaysMin) return false;
  if (f.stuck && !c.stuck) return false;
  if (f.noCalls && !(c.calls && c.calls.total === 0)) return false;
  if (f.deal) {
    const st = c.deal?.closed ?? null;
    if (f.deal === 'open' ? st !== null : st !== f.deal) return false;
  }
  if (f.q) {
    const q = lower(f.q.trim());
    if (q) {
      const digits = /^#?\d+$/.test(q) ? q.replace('#', '') : null;
      const hit = (digits && (String(c.id) === digits || String(c.deal?.id ?? '') === digits))
        || lower(c.title).includes(q)
        || lower(c.deal?.title ?? '').includes(q)
        || lower(c.client ?? '').includes(q)
        || lower(c.note?.text ?? '').includes(q);
      if (!hit) return false;
    }
  }
  return true;
}

// ── сортировка ──────────────────────────────────────────────────────────────
const byControlThenAmount = (a: BigTaskCard, b: BigTaskCard) =>
  Number(b.state === 'control') - Number(a.state === 'control') || cardAmount(b) - cardAmount(a) || b.id - a.id;
const time = (s: string | null | undefined) => (s ? new Date(s).getTime() : 0);

/** default — сначала «ждут контроля», потом по сумме; sum — по сумме убыв.; days — дольше в колонке сверху;
 *  created — новые сверху; idle — дольше без изменений сверху. */
export function sortComparator(sort: BigSort = 'default'): (a: BigTaskCard, b: BigTaskCard) => number {
  switch (sort) {
    case 'sum': return (a, b) => cardAmount(b) - cardAmount(a) || b.id - a.id;
    case 'days': return (a, b) => time(a.inColumnSince) - time(b.inColumnSince) || cardAmount(b) - cardAmount(a) || b.id - a.id;
    case 'created': return (a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id;
    case 'idle': return (a, b) => time(a.changedAt ?? a.createdAt) - time(b.changedAt ?? b.createdAt) || b.id - a.id;
    default: return byControlThenAmount;
  }
}

export const parseSort = (v: string | null | undefined): BigSort => (SORTS.includes(v as BigSort) ? (v as BigSort) : 'default');

// ── разбор и проверка ───────────────────────────────────────────────────────
const int = (v: unknown, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null;
};
const dateStr = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);

/** Нормализует произвольный объект в BigFilters: неизвестное и мусор отбрасываются, пустые поля не пишутся. */
export function normalizeFilters(raw: unknown): BigFilters {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f: BigFilters = {};
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const groups = [...new Set(arr(r.groups).map(Number).filter(g => BIG_DEALS_GROUP_IDS.includes(g)))];
  if (groups.length) f.groups = groups;
  const manager = typeof r.manager === 'number' ? String(r.manager) : r.manager;
  if (typeof manager === 'string' && /^\d{1,10}$/.test(manager)) f.manager = manager;
  const products = [...new Set(arr(r.products).map(x => str(x, 200)).filter((x): x is string => !!x))].slice(0, 50);
  if (products.length) f.products = products;
  const q = str(r.q, 200);
  if (q) f.q = q;
  const sMin = int(r.sumMin, 1e12), sMax = int(r.sumMax, 1e12);
  if (sMin) f.sumMin = sMin;
  if (sMax) f.sumMax = sMax;
  const cf = dateStr(r.createdFrom), ct = dateStr(r.createdTo);
  if (cf) f.createdFrom = cf;
  if (ct) f.createdTo = ct;
  const states = [...new Set(arr(r.states).filter((s): s is BigTaskState => STATES.includes(s as BigTaskState)))];
  if (states.length) f.states = states;
  const columns = [...new Set(arr(r.columns).filter((s): s is BigColumnKey => typeof s === 'string' && COLUMN_KEYS.has(s)))];
  if (columns.length) f.columns = columns;
  const dMin = int(r.daysMin, 3650), iMin = int(r.idleDaysMin, 3650);
  if (dMin) f.daysMin = dMin;
  if (iMin) f.idleDaysMin = iMin;
  if (r.stuck === true) f.stuck = true;
  if (r.noCalls === true) f.noCalls = true;
  if (r.hideLost === true) f.hideLost = true;
  if (r.unassigned === true) f.unassigned = true;
  if (r.deal === 'won' || r.deal === 'lost' || r.deal === 'open') f.deal = r.deal;
  return f;
}

export const filtersEmpty = (f: BigFilters) => Object.keys(f).length === 0;

/** Query доски → BigFilters: group=74,81 manager=123 product=A|B q smin smax cfrom cto states=a,b cols=a,b dmin idle
 *  stuck=1 nocalls=1 deal=won|lost|open. */
export function filtersFromQuery(sp: URLSearchParams): BigFilters {
  const list = (k: string, sep: string) => (sp.get(k) ?? '').split(sep).map(x => x.trim()).filter(Boolean);
  return normalizeFilters({
    groups: list('group', ','), manager: sp.get('manager'), products: list('product', '|'), q: sp.get('q'),
    sumMin: sp.get('smin'), sumMax: sp.get('smax'), createdFrom: sp.get('cfrom'), createdTo: sp.get('cto'),
    states: list('states', ','), columns: list('cols', ','), daysMin: sp.get('dmin'), idleDaysMin: sp.get('idle'),
    stuck: sp.get('stuck') === '1', noCalls: sp.get('nocalls') === '1', hideLost: sp.get('nolost') === '1', unassigned: sp.get('unas') === '1', deal: sp.get('deal'),
  });
}
