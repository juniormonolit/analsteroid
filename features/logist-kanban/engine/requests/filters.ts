// Фильтры доски запросов логистам — по образцу features/big-deals-kanban/engine/filters.ts.
// parseFilters/filtersToSearchParams — общий формат URL для сервера и клиента (useUrlState);
// matchFilters/sortComparator — чистые, работают по RequestCard (SLA и приоритет уже посчитаны).
// Без серверных импортов: файл тянет и клиент.
import {
  REQUEST_STATUSES, REQUEST_TYPES,
  type BoardColumnKey, type BoardSort, type LogistFilters, type OutcomeFilter, type RequestCard, type RequestStatus, type RequestType,
} from './contract';

const SORTS: readonly BoardSort[] = ['priority', 'sum', 'waiting', 'created'];
const ID_RE = /^\d{1,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (s: string, max: number) => s.trim().replace(/\s+/g, ' ').slice(0, max);
const lower = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const date = (v: string | null) => (v && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
const money = (v: string | null) => {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 ? Math.round(n) : undefined;
};

/** URLSearchParams → LogistFilters. Мусор отбрасывается, пустые поля не пишутся. */
export function parseFilters(sp: URLSearchParams): LogistFilters {
  const f: LogistFilters = {};
  const list = (k: string, max = 200) => uniq(sp.getAll(k).map(v => clean(v, max)).filter(Boolean)).slice(0, 300);
  const types = list('type').filter((t): t is RequestType => REQUEST_TYPES.includes(t as RequestType));
  if (types.length) f.types = types;
  const queues = list('queue').filter(x => ID_RE.test(x)).map(Number);
  if (queues.length) f.queues = queues;
  const regions = list('region', 40);
  if (regions.length) f.regions = regions;
  const depts = list('dept', 40);
  if (depts.length) f.depts = depts;
  const pg = list('pg');
  if (pg.length) f.productGroups = pg;
  const managers = list('manager').filter(x => ID_RE.test(x));
  if (managers.length) f.managers = managers;
  const mdept = list('mdept', 40).filter(x => /^[0-9a-f-]{1,40}$/i.test(x));
  if (mdept.length) f.managerDepts = mdept;
  const logists = list('logist').filter(x => ID_RE.test(x));
  if (logists.length) f.logists = logists;
  if (sp.get('mine') === '1') f.mine = true;
  if (sp.get('untaken') === '1') f.untaken = true;
  if (sp.get('returned') === '1') f.returned = true;
  const statuses = list('status').filter((s): s is RequestStatus => REQUEST_STATUSES.includes(s as RequestStatus));
  if (statuses.length) f.statuses = statuses;
  const sla = sp.get('sla');
  if (sla === 'hot' || sla === 'overdue') f.sla = sla;
  const sMin = money(sp.get('sumMin')), sMax = money(sp.get('sumMax'));
  if (sMin) f.sumMin = sMin;
  if (sMax) f.sumMax = sMax;
  const from = date(sp.get('from')), to = date(sp.get('to'));
  if (from) f.createdFrom = from;
  if (to) f.createdTo = to;
  const outcome = sp.get('outcome');
  if (outcome === 'sold' || outcome === 'lost' || outcome === 'open') f.outcome = outcome as OutcomeFilter;
  const q = clean(sp.get('q') ?? '', 200);
  if (q) f.q = q;
  const sort = sp.get('sort');
  if (sort && SORTS.includes(sort as BoardSort) && sort !== 'priority') f.sort = sort as BoardSort;
  return f;
}

/** LogistFilters → URLSearchParams (обратное parseFilters). */
export function filtersToSearchParams(f: LogistFilters, base?: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams(base);
  for (const k of ['type', 'queue', 'region', 'dept', 'pg', 'manager', 'mdept', 'logist', 'status', 'mine', 'untaken', 'returned', 'sla', 'sumMin', 'sumMax', 'from', 'to', 'outcome', 'q', 'sort']) sp.delete(k);
  const add = (k: string, xs: (string | number)[] | undefined) => { for (const x of xs ?? []) sp.append(k, String(x)); };
  add('type', f.types); add('queue', f.queues); add('region', f.regions); add('dept', f.depts); add('pg', f.productGroups);
  add('manager', f.managers); add('mdept', f.managerDepts); add('logist', f.logists); add('status', f.statuses);
  if (f.mine) sp.set('mine', '1');
  if (f.untaken) sp.set('untaken', '1');
  if (f.returned) sp.set('returned', '1');
  if (f.sla) sp.set('sla', f.sla);
  if (f.sumMin) sp.set('sumMin', String(f.sumMin));
  if (f.sumMax) sp.set('sumMax', String(f.sumMax));
  if (f.createdFrom) sp.set('from', f.createdFrom);
  if (f.createdTo) sp.set('to', f.createdTo);
  if (f.outcome) sp.set('outcome', f.outcome);
  if (f.q) sp.set('q', f.q);
  if (f.sort && f.sort !== 'priority') sp.set('sort', f.sort);
  return sp;
}

/** Дата YYYY-MM-DD по Москве. */
export const mskDate = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);

/** Подходит ли карточка. me — bitrix id текущего пользователя (для «Только мои»).
 *  managers уже включает развёрнутые managerDepts (это делает сервер). */
export function matchFilters(c: RequestCard, f: LogistFilters, me: string | null): boolean {
  if (f.types?.length && !f.types.includes(c.type)) return false;
  if (f.queues?.length && !(c.queue && f.queues.includes(c.queue.id))) return false;
  if (f.regions?.length && !(c.region && f.regions.includes(c.region))) return false;
  if (f.depts?.length && !(c.dept && f.depts.includes(c.dept))) return false;
  if (f.productGroups?.length && !c.productGroups.some(g => f.productGroups!.includes(g))) return false;
  if (f.managers?.length && !f.managers.includes(c.manager.bitrixId)) return false;
  if (f.logists?.length && !(c.logist && f.logists.includes(c.logist.bitrixId))) return false;
  if (f.mine && !(me && (c.manager.bitrixId === me || c.logist?.bitrixId === me))) return false;
  if (f.untaken && !(c.status === 'new' && !c.logist)) return false;
  if (f.statuses?.length && !f.statuses.includes(c.status)) return false;
  if (f.sla === 'overdue' && c.sla.state !== 'overdue') return false;
  if (f.sla === 'hot' && c.sla.state !== 'hot' && c.sla.state !== 'overdue') return false;
  if (f.returned && c.returnsCount === 0) return false;
  if (f.sumMin != null && c.amount < f.sumMin) return false;
  if (f.sumMax != null && c.amount > f.sumMax) return false;
  if (f.createdFrom || f.createdTo) {
    const d = mskDate(c.createdAt);
    if (f.createdFrom && d < f.createdFrom) return false;
    if (f.createdTo && d > f.createdTo) return false;
  }
  if (f.outcome) {
    if (f.outcome === 'open' ? c.dealOutcome !== null : c.dealOutcome !== f.outcome) return false;
  }
  if (f.q) {
    const q = lower(f.q.trim());
    if (q) {
      const digits = /^#?\d+$/.test(q) ? q.replace('#', '') : null;
      const hit = (digits !== null && (String(c.id) === digits || String(c.deal?.id ?? '') === digits || String(c.bxTaskId ?? '') === digits))
        || lower(c.client.name ?? '').includes(q)
        || lower(c.deal?.title ?? '').includes(q)
        || lower(c.itemsPreview).includes(q)
        || lower(c.address ?? '').includes(q);
      if (!hit) return false;
    }
  }
  return true;
}

const time = (s: string | null | undefined) => (s ? new Date(s).getTime() : 0);

/** priority — огонёк убыв.; sum — сумма убыв.; waiting — дольше ждёт сверху; created — новые сверху. */
export function sortComparator(sort: BoardSort = 'priority'): (a: RequestCard, b: RequestCard) => number {
  switch (sort) {
    case 'sum': return (a, b) => b.amount - a.amount || b.id - a.id;
    case 'waiting': return (a, b) => time(a.lastEventAt) - time(b.lastEventAt) || b.id - a.id;
    case 'created': return (a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id;
    default: return (a, b) => b.priority.score - a.priority.score || time(a.lastEventAt) - time(b.lastEventAt) || b.id - a.id;
  }
}

/** Колонка карточки в виде «Доска» (status) или «Сделки» (исход). */
export function columnOf(c: Pick<RequestCard, 'status' | 'dealOutcome'>, view: 'board' | 'deals'): BoardColumnKey | null {
  if (view === 'deals') return c.dealOutcome;
  return c.status;
}
