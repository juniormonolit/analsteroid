/**
 * Факты по задачам снабжения — порт refresh/calc.py и refresh/domcalc.py Панели снабжения («Ответы на запросы»).
 * Источник — Панель снабжения, коммит 5504deae64a35b817f2a17e14cfc19b9f242f4c6 (VERSION).
 * Обновлять при смене методики; справочники — lib/supplyPanel/refs/*.json (копии refresh/*.json панели).
 * Результат обязан совпадать с Python побитово (см. scripts/supply-panel-verify.ts): та же форма, что facts.json / deals.json.
 *
 * Методика: цикл 1 — от создания задачи до первого ответа; цикл N — от N-го возобновления до следующего ответа;
 * ответ — переход в «Сделаны» (4) или сразу в «Завершены» (5) из «Новые»/«Выполняются»; возобновление — переход обратно;
 * рабочее время — будни 09:00–18:00 МСК без праздников; регион и департамент запроса — по снабженцу.
 */
import accountsJson from './refs/accounts.json' with { type: 'json' };
import regionsJson from './refs/regions.json' with { type: 'json' };
import departmentsJson from './refs/departments.json' with { type: 'json' };
import suppliersJson from './refs/suppliers.json' with { type: 'json' };
import { isService, makeCatalog } from './catalog';
import { cmpNum, cmpStr, pyNorm, pyRound, pyRound0 } from './pyCompat';
import type { Row, Tables } from './source';

export const WORK_FROM = 9;
export const WORK_TO = 18;
/** Нерабочие праздничные дни 2026 (постановление Правительства). */
const HOLIDAY_LIST: string[] = [
  ...Array.from({ length: 11 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
  '2026-02-23', '2026-03-09', '2026-05-01', '2026-05-11', '2026-06-12', '2026-11-04', '2026-12-31',
];
export const HOLIDAYS = new Set(HOLIDAY_LIST);
const DONE = new Set([4, 5]);
const OPEN = new Set([1, 2, 3, 6]);
const SUPPLIER_MIN_ANSWERS = 100;
export const GOODS_SINCE = '2026-07-21';

// ---------- формы данных (как facts.json) ----------

export interface Cycle {
  n: number; start: string | null; take: string | null; done: string | null; by: number | null;
  accept: string | null; reopen: string | null; reopen_by: string | null; skip_take: boolean | null;
  take_h: number | null; exec_h: number | null; answer_h: number | null; cycle_h: number | null; who?: string;
}
export interface Task {
  id: number; g: number | null; created: string | null; resp: number | null; status: number; deal: number | null;
  test: boolean; cycles: Cycle[]; resp_who?: string; mgr_who?: string; mgr?: number | null;
}
export interface DealFact { sold: string | null; shipped: string | null; lost: string | null; amount: number }
/** Позиция запроса: [название, количество, единица, путь по каталогу | null, услуга 0/1]. */
export type GoodsItem = [string | null, number | null, string, string[] | null, number];
export interface Facts {
  built_at: string; pulled_at: string | null;
  projects: Record<string, { name: string | null; region: string | null; dept: string | null }>;
  users: Record<string, string | null>;
  user_regions: Record<string, { from: string; region: string }[]>;
  user_depts: Record<string, { from: string; dept: string }[]>;
  non_suppliers: number[];
  holders: Record<string, { from: string; name: string }[]>;
  holidays: string[]; work_hours: [number, number];
  deals: Record<string, DealFact>;
  goods_since: string;
  tasks: Task[];
  goods: Record<string, { items: GoodsItem[] }>;
  cat_names: Record<string, string | null>;
  catalog_at: string | null;
}
/** Строка deals.json: [сделка, создана, регион, сумма, продана, проиграна, доминирующий лист, листья наличия, задачи]. */
export type DealRow = [number, string | null, string | null, number, number, number, string, string[], number[]];
export interface DealsData {
  built_at: string; catalog_at: string | null;
  names: Record<string, string | null>; parents: Record<string, string | null>; deals: DealRow[];
}

// ---------- время (наивное МСК, секунды от эпохи как «UTC») ----------

const ISO_RE = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d)(?::(\d\d)(?::(\d\d))?)?)?$/;
/** datetime.fromisoformat для «ГГГГ-ММ-ДД[ ЧЧ:ММ[:СС]]»; пусто → null. Секунды от эпохи (наивное время как UTC). */
export function ts(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = ISO_RE.exec(s.trim());
  if (!m) throw new Error('Invalid isoformat string');
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
}
export function fmt(sec: number | null): string | null {
  if (sec === null) return null;
  return new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
const dayOf = (sec: number): number => Math.floor(sec / 86400);
/** Пн=0 … Вс=6 (1970-01-01 — четверг). */
export const weekdayOfDay = (day: number): number => (((day + 3) % 7) + 7) % 7;
export const isoOfDay = (day: number): string => new Date(day * 86400000).toISOString().slice(0, 10);
const HOLIDAY_DAYS = new Set(HOLIDAY_LIST.map(s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000));

function isWorkday(day: number): boolean {
  return weekdayOfDay(day) < 5 && !HOLIDAY_DAYS.has(day);
}

/** Рабочие часы между a и b (секунды МСК); округление как round(x, 3) в Python. */
export function workHours(a: number | null, b: number | null): number {
  if (a === null || b === null || b <= a) return 0.0;
  let total = 0;
  for (let d = dayOf(a), last = dayOf(b); d <= last; d++) {
    if (!isWorkday(d)) continue;
    const lo = Math.max(a, d * 86400 + WORK_FROM * 3600);
    const hi = Math.min(b, d * 86400 + WORK_TO * 3600);
    if (hi > lo) total += hi - lo;
  }
  return pyRound(total / 3600, 3);
}

// ---------- справочники ----------

type Period<T> = { from?: string; name?: string; region?: string; dept?: string } & T;
export type Holders = Map<number, [string, string][]>;

export function loadHolders(): Holders {
  const res: Holders = new Map();
  for (const [k, v] of Object.entries(accountsJson as unknown as Record<string, unknown>)) {
    if (k.startsWith('_')) continue;
    res.set(Number(k), (v as Period<object>[]).map(p => [p.from || '', p.name!] as [string, string]));
  }
  return res;
}

/** ФИО сотрудника на аккаунте uid на дату when («ГГГГ-ММ-ДД …»); null — аккаунт не передавался. */
export function holder(holders: Holders, uid: number | null, when: string | null): string | null {
  const periods = uid ? holders.get(uid) : undefined;
  if (!periods || !uid) return null;
  let name = periods[0]![1];
  for (const [start, n] of periods) {
    if (start && when && when.slice(0, 10) >= start) name = n;
  }
  return name;
}

export function isTest(title: string | null): boolean {
  return /Падорина/i.test(title || '') || /\| *(888|777) /.test(title || '');
}

function pyInt(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) throw new Error(`invalid literal for int(): ${s}`);
  return Number(t.replace(/_/g, ''));
}

// ---------- задача → циклы ----------

/** События задачи: [ts, id, field, from, to, user_id] по возрастанию (ts, id). */
export type Event = [string | null, number | null, string | null, string | null, string | null, number | null];
interface TaskRow { task_id: number; group_id: number | null; title: string | null; created_at: string | null; created_by: number | null; responsible_id: number | null; deal_id: number | null }
interface Cur {
  n: number; start: number | null; take: number | null; done: number | null; by: number | null; accept: number | null;
  reopen: number | null; reopen_by: number | null; skip_take: boolean; who?: string | null;
}
const newCur = (n: number, start: number | null): Cur =>
  ({ n, start, take: null, done: null, by: null, accept: null, reopen: null, reopen_by: null, skip_take: false });

export function buildTask(task: TaskRow, events: Event[], holders: Holders): Task {
  const created = ts(task.created_at);
  const respChanges = events.filter(e => e[2] === 'RESPONSIBLE_ID');
  let resp: number | null = respChanges.length && respChanges[0]![3] ? pyInt(respChanges[0]![3]!) : task.responsible_id;
  let status = 2;
  const cycles: Cur[] = [];
  let cur = newCur(1, created);
  for (const [tRaw, , field, vFrom, vTo, user] of events) {
    const t = ts(tRaw);
    if (field === 'RESPONSIBLE_ID') {
      resp = vTo ? pyInt(vTo) : resp;
      continue;
    }
    if (field !== 'STATUS') continue;
    let sFrom: number, sTo: number;
    try {
      if (vFrom === null || vTo === null) throw new Error('None');
      sFrom = pyInt(vFrom); sTo = pyInt(vTo);
    } catch { continue; }
    if (DONE.has(sFrom) && OPEN.has(sTo)) {
      cur.reopen = t; cur.reopen_by = user;
      cycles.push(cur);
      cur = newCur(cur.n + 1, t);
    } else if (sTo === 3 && cur.take === null && cur.done === null) {
      cur.take = t;
    } else if (OPEN.has(sFrom) && DONE.has(sTo) && cur.done === null) {
      cur.done = t; cur.by = resp;
      cur.skip_take = cur.take === null;
      if (sTo === 5) cur.accept = t;
    } else if (sFrom === 4 && sTo === 5 && cur.accept === null) {
      cur.accept = t;
    }
    status = sTo;
  }
  cycles.push(cur);

  const out: Cycle[] = [];
  for (const c of cycles) {
    // Python: truthiness datetime — любой datetime истинен; null — ложь
    const done = c.done !== null, take = c.take !== null, accept = c.accept !== null, reopen = c.reopen !== null;
    c.who = done ? holder(holders, c.by, fmt(c.done)) : null;
    const takeH = take && done && !c.skip_take ? workHours(c.start, c.take) : null;
    const execH = take && done ? workHours(c.take, c.done) : null;
    const o: Cycle = {
      n: c.n, start: fmt(c.start), take: fmt(c.take), done: fmt(c.done), by: c.by, accept: fmt(c.accept), reopen: fmt(c.reopen),
      reopen_by: reopen
        ? (c.reopen_by === c.by ? 'исполнитель' : c.reopen_by === task.created_by ? 'постановщик' : (c.reopen_by ? 'другой' : null))
        : null,
      skip_take: done ? c.skip_take : null,
      take_h: takeH, exec_h: execH,
      answer_h: done ? workHours(c.start, c.done) : null,
      cycle_h: accept ? workHours(c.start, c.accept) : null,
    };
    out.push(o);
    if (c.who) o.who = c.who;
  }
  const first = out.find(c => c.by) ?? null;
  const respUid = first ? first.by : resp;
  const res: Task = {
    id: task.task_id, g: task.group_id, created: fmt(created), resp: respUid, status, deal: task.deal_id,
    test: isTest(task.title), cycles: out,
  };
  const respWho = holder(holders, respUid, first ? first.done : fmt(created));
  const mgrWho = holder(holders, task.created_by, fmt(created));
  if (respWho) res.resp_who = respWho;
  if (mgrWho) res.mgr_who = mgrWho;
  return res;
}

// ---------- регион / департамент / не снабженцы ----------

export function departments(projects: Row[]): Map<number, string> {
  const res = new Map<number, string>();
  for (const r of projects) if (r.dept !== null) res.set(r.group_id as number, r.dept as string);
  const base = new Map<number, string>();
  for (const [dep, groups] of Object.entries(departmentsJson as unknown as Record<string, unknown>)) {
    if (dep.startsWith('_')) continue;
    for (const g of groups as number[]) base.set(g, dep);
  }
  for (const [g, d] of res) base.set(g, d);
  return base;
}

/** Большинство ответов (без ответов — большинство задач); ничья — по числу задач, затем по названию. */
function majority(tasks: Task[], byGroup: Map<number | null, string | null>): Map<number, string> {
  const votes = new Map<number, Map<string, [number, number]>>();
  for (const t of tasks) {
    const key = byGroup.get(t.g);
    if (t.test || !key) continue;
    const answered = t.cycles.filter(c => c.done && c.by).map(c => c.by!);
    for (const uid of answered.length ? answered : [t.resp]) {
      if (uid) {
        let m = votes.get(uid);
        if (!m) votes.set(uid, m = new Map());
        let v = m.get(key);
        if (!v) m.set(key, v = [0, 0]);
        v[answered.length ? 0 : 1]++;
      }
    }
  }
  const res = new Map<number, string>();
  for (const [uid, m] of votes) {
    let best: [string, [number, number]] | null = null;
    for (const kv of m) {
      if (!best || cmpNum(kv[1][0], best[1][0]) > 0
        || (kv[1][0] === best[1][0] && (kv[1][1] > best[1][1] || (kv[1][1] === best[1][1] && cmpStr(kv[0], best[0]) > 0)))) best = kv;
    }
    res.set(uid, best![0]);
  }
  return res;
}

export type PeriodMap = Map<number, [string, string][]>;

export function userRegions(tasks: Task[], projectRegion: Map<number | null, string | null>): PeriodMap {
  const res: PeriodMap = new Map();
  for (const [uid, reg] of majority(tasks, projectRegion)) res.set(uid, [['', reg]]);
  for (const [k, v] of Object.entries(regionsJson as unknown as Record<string, unknown>)) {
    if (!k.startsWith('_')) res.set(Number(k), (v as Period<object>[]).map(p => [p.from || '', p.region!] as [string, string]));
  }
  return res;
}

export function userDepts(tasks: Task[], projectDept: Map<number | null, string | null>): PeriodMap {
  const res: PeriodMap = new Map();
  for (const [uid, dep] of majority(tasks, projectDept)) res.set(uid, [['', dep]]);
  const users = (departmentsJson as unknown as Record<string, unknown>)['_users'] as Record<string, Period<object>[]> | undefined;
  for (const [k, v] of Object.entries(users || {})) res.set(Number(k), v.map(p => [p.from || '', p.dept!] as [string, string]));
  return res;
}

export function nonSuppliers(supplyUsers: Row[], tasks: Task[]): number[] {
  const cfg = suppliersJson as unknown as { include?: number[]; exclude?: number[] };
  const org = new Set<number | null>(supplyUsers.map(r => r.user_id as number | null));
  const answers = new Map<number, number>();
  const seen = new Set<number | null>();
  for (const t of tasks) {
    seen.add(t.resp);
    for (const c of t.cycles) {
      if (c.done && c.by) {
        answers.set(c.by, (answers.get(c.by) ?? 0) + 1);
        seen.add(c.by);
      }
    }
  }
  const ok = new Set<number | null>(org);
  for (const [u, n] of answers) if (n >= SUPPLIER_MIN_ANSWERS) ok.add(u);
  for (const u of cfg.include ?? []) ok.add(u);
  for (const u of cfg.exclude ?? []) ok.delete(u);
  return [...seen].filter((u): u is number => !!u && !ok.has(u)).sort(cmpNum);
}

// ---------- сборка facts ----------

const pad = (n: number) => String(n).padStart(2, '0');
/** Текущее время МСК «ГГГГ-ММ-ДД ЧЧ:ММ». */
export function nowMsk(now = new Date()): string {
  const d = new Date(now.getTime() + 3 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const metaValue = (meta: Row[], key: string): string | null => {
  const r = meta.find(m => m.key === key);
  return r ? (r.value as string | null) : null;
};

const periodsOut = <K extends string>(m: PeriodMap, k: K): Record<string, ({ from: string } & Record<K, string>)[]> => {
  const o: Record<string, ({ from: string } & Record<K, string>)[]> = {};
  for (const [uid, p] of m) o[String(uid)] = p.map(([f, v]) => ({ from: f, [k]: v } as { from: string } & Record<K, string>));
  return o;
};

export function buildFacts(t: Tables, now = new Date()): Facts {
  // история по задачам: order by task_id, ts, id (NULL — первым, как в SQLite)
  const hist = t.history.slice().sort((a, b) =>
    cmpNum(a.task_id as number, b.task_id as number)
    || (a.ts === b.ts ? 0 : a.ts === null ? -1 : b.ts === null ? 1 : cmpStr(a.ts as string, b.ts as string))
    || (a.id === b.id ? 0 : a.id === null ? -1 : b.id === null ? 1 : cmpNum(a.id as number, b.id as number)));
  const events = new Map<number, Event[]>();
  for (const r of hist) {
    let l = events.get(r.task_id as number);
    if (!l) events.set(r.task_id as number, l = []);
    l.push([r.ts as string | null, r.id as number | null, r.field as string | null, r.val_from as string | null, r.val_to as string | null, r.user_id as number | null]);
  }
  const holders = loadHolders();
  const projectIds = new Set(t.projects.map(r => r.group_id as number | null).filter((g): g is number => g !== null));
  const denied = new Set(t.denied.map(r => r.task_id));
  const fetched = new Set(t.fetched.map(r => r.task_id));
  const tasks: Task[] = [];
  for (const r of t.tasks) {
    if (r.is_deleted !== 0 || !projectIds.has(r.group_id as number) || denied.has(r.task_id) || !fetched.has(r.task_id)) continue;
    tasks.push(buildTask(r as unknown as TaskRow, events.get(r.task_id as number) ?? [], holders));
  }
  // продажа и отгрузка засчитываются, если сделку потом не проиграли; проигрыш — если после него сделку не продали
  const kept = (at: string | null, lost: string | null) => (at && !(lost && lost > at) ? at : null);
  const lostOf = (at: string | null, sold: string | null) => (at && !(sold && sold > at) ? at : null);
  const dealsAll = new Map<number, DealFact>();
  for (const r of t.deals) {
    dealsAll.set(r.deal_id as number, {
      sold: kept(r.sold_at as string | null, r.lost_at as string | null),
      shipped: kept(r.delivered_at as string | null, r.lost_at as string | null),
      lost: lostOf(r.lost_at as string | null, r.sold_at as string | null),
      amount: r.amount as number,
    });
  }
  const dept = departments(t.projects);
  const projRegion = new Map<number | null, string | null>();
  const projDept = new Map<number | null, string | null>();
  for (const r of t.projects) projRegion.set(r.group_id as number, r.region as string | null);
  for (const [g, d] of dept) projDept.set(g, d);
  const regions = userRegions(tasks, projRegion);
  const depts = userDepts(tasks, projDept);
  const projects: Facts['projects'] = {};
  for (const r of t.projects) projects[String(r.group_id)] = { name: r.name as string | null, region: r.region as string | null, dept: dept.get(r.group_id as number) ?? null };
  const users: Facts['users'] = {};
  for (const r of t.users) users[String(r.user_id)] = r.name as string | null;
  const holdersOut: Facts['holders'] = {};
  for (const [uid, p] of holders) holdersOut[String(uid)] = p.map(([f, n]) => ({ from: f, name: n }));
  const deals: Facts['deals'] = {};
  for (const [k, v] of dealsAll) if (v.sold || v.shipped || v.lost) deals[String(k)] = v;
  const { goods, names } = loadGoods(t);
  return {
    built_at: nowMsk(now),
    pulled_at: metaValue(t.meta, 'pulled_at'),
    projects, users,
    user_regions: periodsOut(regions, 'region'),
    user_depts: periodsOut(depts, 'dept'),
    non_suppliers: nonSuppliers(t.supply_users, tasks),
    holders: holdersOut,
    holidays: HOLIDAY_LIST.slice().sort(),
    work_hours: [WORK_FROM, WORK_TO],
    deals, goods_since: GOODS_SINCE, tasks,
    goods, cat_names: names,
    catalog_at: metaValue(t.meta, 'catalog_at'),
  };
}

/** Товары запросов с привязкой к каталогу; названия узлов — отдельно (cat_names). */
export function loadGoods(t: Tables): { goods: Facts['goods']; names: Facts['cat_names'] } {
  const cat = makeCatalog(t.cat_sections, t.cat_products, t.cat_offers);
  const byName = new Map<string, number>();
  for (const [pid, [name]] of [...cat.offers, ...cat.products]) {
    const k = pyNorm(name);
    if (!byName.has(k)) byName.set(k, pid);
  }
  const dealProducts = new Map<string, number>();
  for (const r of t.deal_products) dealProducts.set(`${r.deal_id}\u0001${pyNorm(r.name as string | null)}`, r.product_id as number);
  const taskDeals = new Map<number, (number | null)[]>();
  for (const r of t.tasks) {
    if (r.is_deleted !== 0) continue;
    let l = taskDeals.get(r.task_id as number);
    if (!l) taskDeals.set(r.task_id as number, l = []);
    l.push(r.deal_id as number | null);
  }
  const rows: { tid: number; n: number | null; deal: number | null; product: string | null; qty: number | null; unit: string | null }[] = [];
  for (const g of t.goods) {
    for (const deal of taskDeals.get(g.task_id as number) ?? []) {
      rows.push({ tid: g.task_id as number, n: g.n as number | null, deal, product: g.product as string | null, qty: g.qty as number | null, unit: g.unit as string | null });
    }
  }
  rows.sort((a, b) => cmpNum(a.tid, b.tid) || cmpNum(a.n ?? -Infinity, b.n ?? -Infinity));
  const goods: Facts['goods'] = {};
  for (const r of rows) {
    const n = pyNorm(r.product);
    const pid = byName.get(n) || dealProducts.get(`${r.deal}\u0001${n}`);
    const path = pid ? cat.resolve(pid) : null;
    (goods[String(r.tid)] ??= { items: [] }).items.push([r.product, r.qty, r.unit || '', path, Number(isService(path))]);
  }
  return { goods, names: cat.names };
}

// ---------- domcalc: сделки с доминирующей категорией ----------

export const UNDEF = '_undef';
const AMOUNT_MAX = 1e8; // выше — заглушка менеджера (1e16, 11111111111111), в сумму не входит

/** Лист доминирующего пути сделки (наибольшая сумма на каждом уровне) или UNDEF. */
export function dominant(lines: [string[], number][], parents: Map<string, string | null>): string {
  const sums = new Map<string, number>();
  for (const [path, s] of lines) for (const node of path) sums.set(node, (sums.get(node) ?? 0) + s);
  let max = -Infinity;
  for (const v of sums.values()) if (v > max) max = v;
  if (!sums.size || max <= 0) return UNDEF;
  const children = new Map<string | null, Set<string>>();
  for (const [path] of lines) {
    for (const node of path) {
      const p = parents.get(node) ?? null;
      let s = children.get(p);
      if (!s) children.set(p, s = new Set());
      s.add(node);
    }
  }
  let node: string | null = null;
  for (;;) {
    const kids = children.get(node);
    if (!kids || !kids.size) return node as string;
    let best: string | null = null;
    for (const k of kids) {
      if (best === null) { best = k; continue; }
      const a = sums.get(k)!, b = sums.get(best)!;
      if (a > b || (a === b && cmpStr(k, best) > 0)) best = k;
    }
    node = best;
  }
}

export function buildDeals(t: Tables, now = new Date()): DealsData {
  const cat = makeCatalog(t.cat_sections, t.cat_products, t.cat_offers);
  const projectIds = new Set(t.projects.map(r => r.group_id as number | null).filter((g): g is number => g !== null));
  const denied = new Set(t.denied.map(r => r.task_id));
  const tasks = new Map<number, number[]>();
  for (const r of t.tasks) {
    if (r.is_deleted !== 0 || r.deal_id === null || !projectIds.has(r.group_id as number) || denied.has(r.task_id)) continue;
    if (isTest(r.title as string | null)) continue;
    const l = tasks.get(r.deal_id as number);
    if (l) l.push(r.task_id as number); else tasks.set(r.deal_id as number, [r.task_id as number]);
  }
  const lines = new Map<number, [string[], number][]>();
  for (const r of t.deal_lines) {
    const pid = r.product_id as number | null;
    const path = pid ? cat.resolve(pid) : null;
    if (path && !isService(path)) {
      const l = lines.get(r.deal_id as number) ?? [];
      l.push([path, (r.sum as number | null) || 0.0]);
      lines.set(r.deal_id as number, l);
    }
  }
  const all = t.deals_all.slice().sort((a, b) => cmpNum(a.deal_id as number, b.deal_id as number));
  const deals: DealRow[] = [];
  for (const d of all) {
    const ls = lines.get(d.deal_id as number) ?? [];
    const dom = dominant(ls, cat.parents);
    const present = [...new Set(ls.map(([p]) => p[p.length - 1]!))].sort(cmpStr);
    const amount = (d.amount as number | null) || 0;
    const sold = d.sold_at as string | null, lost = d.lost_at as string | null;
    deals.push([
      d.deal_id as number, d.created_at as string | null, d.region as string | null,
      amount <= AMOUNT_MAX ? pyRound0(amount) : 0,
      sold && !(lost && lost > sold) ? 1 : 0,
      lost && !(sold && sold > lost) ? 1 : 0,
      dom, present, tasks.get(d.deal_id as number) ?? [],
    ]);
  }
  const names = cat.names;
  names[UNDEF] = 'Не определено';
  const used = new Set<string>();
  for (const d of deals) { used.add(d[6]); for (const n of d[7]) used.add(n); }
  const keep = new Set<string>();
  for (const u of used) {
    let n: string | null | undefined = u;
    while (n && !keep.has(n)) {
      keep.add(n);
      n = cat.parents.get(n);
    }
  }
  const outNames: DealsData['names'] = {};
  for (const k of Object.keys(names)) if (keep.has(k)) outNames[k] = names[k]!;
  const outParents: DealsData['parents'] = {};
  for (const k of keep) if (k !== UNDEF) outParents[k] = cat.parents.get(k) ?? null;
  return { built_at: nowMsk(now), catalog_at: metaValue(t.meta, 'catalog_at'), names: outNames, parents: outParents, deals };
}
