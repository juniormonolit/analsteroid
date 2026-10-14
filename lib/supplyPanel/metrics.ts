/**
 * Показатели за период из фактов calc.ts — порт refresh/metrics.py Панели снабжения (общий для API и сверки).
 * Источник — Панель снабжения, коммит 5504deae64a35b817f2a17e14cfc19b9f242f4c6; методика — docs/Методика.md.
 * Период полуоткрытый [d0, d1); время — наивное МСК, строкой «ГГГГ-ММ-ДД ЧЧ:ММ:СС» (см. parseDt).
 *
 * Совпадение с Python побитово: округление — pyRound (банковское по точному значению), порядок сумм по сделкам —
 * порядок обхода set[int] CPython (pySetOrder), сортировки устойчивы, строки сравниваются по кодовым точкам.
 */
import { fmt, isoOfDay, ts, weekdayOfDay } from './calc';
import type { Cycle, DealRow, DealsData, Facts, GoodsItem, Task } from './calc';
import { cmpNum, cmpStr, pyMedian, pyRound, pyRound0, pySetOrder, pyStr } from './pyCompat';

export type Dt = string;

/** parse_dt: «ГГГГ-ММ-ДД[ ЧЧ:ММ[:СС]]» (допустим T) → «ГГГГ-ММ-ДД ЧЧ:ММ:СС». */
export function parseDt(s: string): Dt {
  let v = s.trim().replace('T', ' ');
  if (!v.includes(' ')) v += ' 00:00:00';
  return fmt(ts(v))!;
}

/** Фильтры как в app.py `_args`. region/user — одно значение или набор; пустой набор region — без фильтра. */
export interface Filter {
  region?: string | Iterable<string> | null;
  group?: number | null;
  user?: number | Iterable<number> | null;
  dept?: string | null;
  person?: string | null;
}

/** Рабочие дни, которые хотя бы частично попадают в период. */
export function workdays(d0: Dt, d1: Dt, holidays: Set<string>): number {
  const s0 = ts(d0)!, s1 = ts(d1)!;
  let n = 0;
  const last = Math.floor((s1 - 1e-6) / 86400); // день момента d1 - 1 мкс
  for (let d = Math.floor(s0 / 86400); d <= last; d++) {
    if (weekdayOfDay(d) < 5 && !holidays.has(isoOfDay(d))) n++;
  }
  return n;
}

const inside = (d0: Dt, d1: Dt) => (x: string | null | undefined): boolean => x != null && d0 <= x && x < d1;
const own = <T>(o: Record<string, T> | undefined | null, k: string): T | undefined =>
  o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

export function projectRegion(facts: Facts, g: number | null): string {
  return own(facts.projects, pyStr(g))?.region || '?';
}

/** Регион снабженца на дату when; null — аккаунта нет в справочнике. */
export function userRegion(facts: Facts, uid: number | null, when: string | null = null): string | null {
  const periods = own(facts.user_regions, pyStr(uid));
  if (!periods || !periods.length) return null;
  let reg = periods[0]!.region;
  for (const p of periods) if (p.from && when && when.slice(0, 10) >= p.from) reg = p.region;
  return reg;
}

export function regionOf(facts: Facts, g: number | null, uid: number | null = null, when: string | null = null): string {
  return userRegion(facts, uid, when) || projectRegion(facts, g);
}

export function deptOf(facts: Facts, g: number | null): string {
  return own(facts.projects, pyStr(g))?.dept || '?';
}

export function userDept(facts: Facts, uid: number | null, when: string | null = null): string | null {
  const periods = own(facts.user_depts, pyStr(uid));
  if (!periods || !periods.length) return null;
  let dep = periods[0]!.dept;
  for (const p of periods) if (p.from && when && when.slice(0, 10) >= p.from) dep = p.dept;
  return dep;
}

export function deptFor(facts: Facts, g: number | null, uid: number | null = null, when: string | null = null): string {
  return userDept(facts, uid, when) || deptOf(facts, g);
}

/** ФИО сотрудника: для переданного аккаунта — кто работал на дату события, иначе текущее имя аккаунта. */
export function personOf(facts: Facts, uid: number | null, who: string | null | undefined): string {
  return who || own(facts.users, pyStr(uid)) || `id ${pyStr(uid)}`;
}

/** Общий «аккаунт» для всех, кто не снабженец. */
export const OUTSIDER = 0;

function* mapped(facts: Facts, outsiders: Set<number | null>): Generator<Task> {
  for (const t of facts.tasks) {
    if (!outsiders.has(t.resp) && !t.cycles.some(c => outsiders.has(c.by))) { yield t; continue; }
    const m: Task = { ...t };
    if (outsiders.has(t.resp)) { m.resp_who = personOf(facts, t.resp, t.resp_who); m.resp = OUTSIDER; }
    m.cycles = t.cycles.map(c => (outsiders.has(c.by) ? { ...c, who: personOf(facts, c.by, c.who), by: OUTSIDER } : c));
    yield m;
  }
}

export type EventKind = 'new' | 'reopen' | 'answer' | 'sold' | 'shipped' | 'lost';
/** (вид, задача, цикл, аккаунт снабженца, проект, ФИО на дату события, регион, департамент). */
export type Ev = [EventKind, Task, Cycle | null, number | null, number | null, string, string, string];

const toSet = <T>(v: T | Iterable<T> | null | undefined, single: (x: unknown) => x is T): Set<T> | null =>
  v == null ? null : single(v) ? new Set([v]) : new Set(v as Iterable<T>);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number';

/** События периода; см. metrics.py events(). */
export function* events(facts: Facts, d0: Dt, d1: Dt, f: Filter = {}): Generator<Ev> {
  const ins = inside(d0, d1);
  const { group, dept, person } = f;
  const regionSet = toSet<string>(f.region ?? null, isStr);
  const region = regionSet && regionSet.size ? regionSet : null; // пустое — не фильтр
  const userSet = toSet<number>(f.user ?? null, isNum);
  const outsiders = new Set<number | null>(facts.non_suppliers || []);
  const src: Iterable<Task> = outsiders.size ? mapped(facts, outsiders) : facts.tasks;
  for (const t of src) {
    const g = t.g;
    if (t.test || (group && g !== group)) continue;
    const ok = (uid: number | null, who: string, reg: string, dep: string): boolean =>
      uid !== OUTSIDER && (userSet === null || (uid !== null && userSet.has(uid))) && (!person || who === person)
      && (!region || region.has(reg)) && (!dept || dep === dept);
    const rp = personOf(facts, t.resp, t.resp_who);
    // регион и департамент задачи — по её исполнителю на дату первого ответа (нет ответа — на дату создания)
    const first = t.cycles.find(c => c.done)?.done ?? null;
    const rr = regionOf(facts, g, t.resp, first || t.created);
    const rd = deptFor(facts, g, t.resp, first || t.created);
    if (ins(t.created) && ok(t.resp, rp, rr, rd)) yield ['new', t, null, t.resp, g, rp, rr, rd];
    const deal = t.deal ? own(facts.deals, String(t.deal)) : undefined;
    if (deal && ok(t.resp, rp, rr, rd)) {
      if (ins(deal.sold)) yield ['sold', t, null, t.resp, g, rp, rr, rd];
      if (ins(deal.shipped)) yield ['shipped', t, null, t.resp, g, rp, rr, rd];
      if (ins(deal.lost)) yield ['lost', t, null, t.resp, g, rp, rr, rd];
    }
    for (const c of t.cycles) {
      if (c.n > 1 && ins(c.start)) {
        // возобновление — тому, кто потом ответил; ответа ещё нет — исполнителю задачи
        const uid = c.by !== null ? c.by : t.resp;
        const wp = c.by !== null ? personOf(facts, c.by, c.who) : rp;
        const wr = regionOf(facts, g, uid, c.start), wd = deptFor(facts, g, uid, c.start);
        if (ok(uid, wp, wr, wd)) yield ['reopen', t, c, uid, g, wp, wr, wd];
      }
      if (ins(c.done)) {
        const cp = personOf(facts, c.by, c.who);
        const cr = regionOf(facts, g, c.by, c.done), cd = deptFor(facts, g, c.by, c.done);
        if (ok(c.by, cp, cr, cd)) yield ['answer', t, c, c.by, g, cp, cr, cd];
      }
    }
  }
}

/** Что показывает клик по показателю: вид события (или несколько) и условие на цикл. CR — по завершённым сделкам. */
export const PICK: Record<string, [EventKind | EventKind[], ((c: Cycle) => boolean) | null]> = {
  cr_sale_pct: [['sold', 'lost'], null], cr_ship_pct: [['shipped', 'lost'], null],
  new: ['new', null], new_per_day: ['new', null],
  reopens: ['reopen', null], reopens_per_day: ['reopen', null],
  req_all: [['new', 'reopen'], null], req_all_per_day: [['new', 'reopen'], null],
  done: ['answer', c => c.n === 1],
  all_answer_h: ['answer', null],
  answer_h: ['answer', c => c.n === 1], answer_med_h: ['answer', c => c.n === 1],
  take_h: ['answer', c => c.n === 1 && !c.skip_take],
  exec_h: ['answer', c => c.n === 1 && !c.skip_take],
  cycle_h: ['answer', c => c.n === 1 && c.cycle_h !== null],
  gt3: ['answer', c => c.n === 1 && c.answer_h! > 3],
  gt9: ['answer', c => c.n === 1 && c.answer_h! > 9],
  gt3_pct: ['answer', c => c.n === 1 && c.answer_h! > 3],
  gt9_pct: ['answer', c => c.n === 1 && c.answer_h! > 9],
  reopened: ['answer', c => c.n === 1 && c.reopen !== null],
  skip_take: ['answer', c => c.n === 1 && !!c.skip_take],
  answers: ['answer', null], answers_per_day: ['answer', null],
  repeat: ['answer', c => c.n > 1], repeat_answer_h: ['answer', c => c.n > 1],
  sales: ['sold', null], amount: ['sold', null], conversion_pct: ['sold', null],
  shipments: ['shipped', null], ship_amount: ['shipped', null], ship_conversion_pct: ['shipped', null],
};

const avg = (xs: number[]): number | null => {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return pyRound(s / xs.length, 2);
};
const med = (xs: number[]): number | null => (xs.length ? pyRound(pyMedian(xs), 2) : null);

interface Acc {
  new: number; reopens: number; done: number; skip_take: number; reopened: number; gt3: number; gt9: number;
  answers: number; repeat: number; reopen_by_self: number; reopen_by_creator: number;
  take: number[]; exec: number[]; answer: number[]; all_answer: number[]; cycle: number[]; repeat_answer: number[];
  sold_tasks: number; deals: Set<number>; shipped_tasks: number; ship_deals: Set<number>; lost_deals: Set<number>;
}
const newAcc = (): Acc => ({
  new: 0, reopens: 0, done: 0, skip_take: 0, reopened: 0, gt3: 0, gt9: 0, answers: 0, repeat: 0, reopen_by_self: 0, reopen_by_creator: 0,
  take: [], exec: [], answer: [], all_answer: [], cycle: [], repeat_answer: [],
  sold_tasks: 0, deals: new Set(), shipped_tasks: 0, ship_deals: new Set(), lost_deals: new Set(),
});

function add(a: Acc, kind: EventKind, t: Task, c: Cycle | null): void {
  if (kind === 'new') a.new++;
  else if (kind === 'sold') { a.sold_tasks++; a.deals.add(t.deal!); }
  else if (kind === 'shipped') { a.shipped_tasks++; a.ship_deals.add(t.deal!); }
  else if (kind === 'lost') a.lost_deals.add(t.deal!);
  else if (kind === 'reopen') a.reopens++;
  else {
    const cc = c!;
    a.answers++;
    a.all_answer.push(cc.answer_h!);
    if (cc.reopen) {
      a.reopen_by_self += +(cc.reopen_by === 'исполнитель');
      a.reopen_by_creator += +(cc.reopen_by === 'постановщик');
    }
    if (cc.n > 1) {
      a.repeat++;
      a.repeat_answer.push(cc.answer_h!);
      return;
    }
    a.done++;
    if (cc.skip_take) a.skip_take++;
    else { a.take.push(cc.take_h!); a.exec.push(cc.exec_h!); }
    a.answer.push(cc.answer_h!);
    if (cc.cycle_h !== null) a.cycle.push(cc.cycle_h);
    a.gt3 += +(cc.answer_h! > 3);
    a.gt9 += +(cc.answer_h! > 9);
    a.reopened += +(cc.reopen !== null);
  }
}

/** Сумма сумм сделок множества: порядок сложения как при обходе set[int] в CPython (float-сумма зависит от порядка). */
function sumDeals(deals: Facts['deals'], ids: Set<number>): number {
  const list = [...ids];
  let exact = true, big = 0;
  for (const d of list) {
    const x = deals[String(d)]!.amount;
    if (!Number.isInteger(x)) exact = false;
    big += Math.abs(x);
  }
  const order = exact && big < 2 ** 53 ? list : pySetOrder(list);
  let s = 0;
  for (const d of order) s += deals[String(d)]!.amount;
  return s;
}

const enc = (key: readonly unknown[]): string => key.map(p => (p === null ? 'n' : typeof p === 'number' ? `#${p}` : `s${p}`)).join('\u0001');

class AccMap {
  readonly m = new Map<string, { key: unknown[]; a: Acc }>();
  get(key: unknown[]): Acc {
    const k = enc(key);
    let e = this.m.get(k);
    if (!e) this.m.set(k, e = { key, a: newAcc() });
    return e.a;
  }
}

/** Строка показателей (срез). Поля — как в Python out(). */
export interface AggRow {
  key: number | string | null; name: string;
  new: number; new_per_day: number | null; reopens: number; reopens_per_day: number | null; req_all: number; req_all_per_day: number | null;
  all_answer_h: number | null; take_h: number | null; exec_h: number | null; answer_h: number | null; answer_med_h: number | null; cycle_h: number | null;
  done: number; skip_take: number; skip_take_pct: number | null; reopened: number; reopened_pct: number | null;
  gt3: number; gt3_pct: number | null; gt9: number; gt9_pct: number | null;
  answers: number; answers_per_day: number | null; repeat: number; repeat_answer_h: number | null;
  reopen_by_self: number; reopen_by_creator: number;
  sales: number; amount: number; sold_tasks: number; conversion_pct: number | null;
  shipments: number; ship_amount: number; shipped_tasks: number; ship_conversion_pct: number | null;
  lost: number; cr_sale_pct: number | null; cr_ship_pct: number | null;
  persons?: AggRow[]; children?: AggRow[]; reg?: string | null; dep?: string | null; preg?: string;
}
export interface Aggregate {
  from: string; to: string; workdays: number;
  user: AggRow[]; group: AggRow[]; region: AggRow[]; dept: AggRow[]; tree: AggRow[]; dtree: AggRow[]; total: AggRow;
}

const pct = (x: number, y: number): number | null => (y ? pyRound((100 * x) / y, 1) : null);

export function aggregate(facts: Facts, d0: Dt, d1: Dt, f: Filter = {}): Aggregate {
  const acc = {
    user: new AccMap(), person: new AccMap(), group: new AccMap(), gtree: new AccMap(), dept: new AccMap(),
    region: new AccMap(), tree: new AccMap(), dtree: new AccMap(), total: new AccMap(),
  };
  for (const [kind, t, c, uid, g, who, reg, dep] of events(facts, d0, d1, f)) {
    const cuts: [AccMap, unknown[]][] = [
      [acc.user, [uid]], [acc.person, [uid, who]], [acc.group, [g]], [acc.dept, [dep]], [acc.region, [reg]], [acc.total, ['']],
      [acc.gtree, [g, uid]], [acc.gtree, [g, uid, who]],
      [acc.tree, [reg]], [acc.tree, [reg, dep]], [acc.tree, [reg, dep, g]], [acc.tree, [reg, dep, g, uid]], [acc.tree, [reg, dep, g, uid, who]],
      [acc.dtree, [dep]], [acc.dtree, [dep, reg]], [acc.dtree, [dep, reg, g]], [acc.dtree, [dep, reg, g, uid]], [acc.dtree, [dep, reg, g, uid, who]],
    ];
    for (const [m, key] of cuts) add(m.get(key), kind, t, c);
  }

  const holidays = new Set(facts.holidays);
  const wd = workdays(d0, d1, holidays);
  const deals = facts.deals;
  const perDay = (x: number): number | null => (wd ? pyRound(x / wd, 1) : null);

  const out = (key: number | string | null, a: Acc, name: string): AggRow => ({
    key, name,
    new: a.new, new_per_day: perDay(a.new),
    reopens: a.reopens, reopens_per_day: perDay(a.reopens),
    req_all: a.new + a.reopens, req_all_per_day: perDay(a.new + a.reopens),
    all_answer_h: avg(a.all_answer),
    take_h: avg(a.take), exec_h: avg(a.exec),
    answer_h: avg(a.answer), answer_med_h: med(a.answer), cycle_h: avg(a.cycle),
    done: a.done, skip_take: a.skip_take, skip_take_pct: pct(a.skip_take, a.done),
    reopened: a.reopened, reopened_pct: pct(a.reopened, a.done),
    gt3: a.gt3, gt3_pct: pct(a.gt3, a.done), gt9: a.gt9, gt9_pct: pct(a.gt9, a.done),
    answers: a.answers, answers_per_day: perDay(a.answers),
    repeat: a.repeat, repeat_answer_h: avg(a.repeat_answer),
    reopen_by_self: a.reopen_by_self, reopen_by_creator: a.reopen_by_creator,
    sales: a.deals.size, amount: pyRound0(sumDeals(deals, a.deals)),
    sold_tasks: a.sold_tasks, conversion_pct: pct(a.sold_tasks, a.new),
    shipments: a.ship_deals.size, ship_amount: pyRound0(sumDeals(deals, a.ship_deals)),
    shipped_tasks: a.shipped_tasks, ship_conversion_pct: pct(a.shipped_tasks, a.new),
    lost: a.lost_deals.size,
    cr_sale_pct: pct(a.deals.size, a.deals.size + a.lost_deals.size),
    cr_ship_pct: pct(a.ship_deals.size, a.ship_deals.size + a.lost_deals.size),
  });

  const users = facts.users, projects = facts.projects;
  const uname = (k: number | string | null): string =>
    k === OUTSIDER ? 'Не снабженцы (менеджеры и прочие)' : own(users, pyStr(k)) || `id ${pyStr(k)}`;
  const gname = (k: number | string | null): string => own(projects, pyStr(k))?.name || `проект ${pyStr(k)}`;
  const order = (x: AggRow, y: AggRow): number => cmpNum(-x.req_all, -y.req_all) || cmpNum(-x.done, -y.done) || cmpStr(x.name, y.name);
  const res = { from: d0, to: d1, workdays: wd } as Aggregate;

  type Persons = Map<string, Acc>;
  /** Строка аккаунта. Несколько сотрудников в периоде — имена через «/» и строки по каждому (persons). */
  const account = (uid: number | null, a: Acc, persons: Persons): AggRow => {
    const people = [...persons.entries()].sort((x, y) => cmpNum(-(x[1].new + x[1].answers), -(y[1].new + y[1].answers)));
    let row: AggRow;
    if (uid === OUTSIDER) {
      row = out(uid, a, uname(uid));
      row.persons = people.map(([p, pa]) => out(p, pa, p));
    } else if (people.length <= 1) {
      row = out(uid, a, people.length ? people[0]![0] : uname(uid));
    } else {
      row = out(uid, a, people.map(([p]) => p).join(' / ') + ` (аккаунт ${uid})`);
      row.persons = people.map(([p, pa]) => out(p, pa, p));
    }
    row.reg = userRegion(facts, uid, res.to); // регион снабженца — для чипа
    row.dep = userDept(facts, uid, res.to);
    return row;
  };

  // сотрудники аккаунта: uid → (ФИО → показатели), в порядке появления
  const personsOf = new Map<number | null, Persons>();
  for (const { key, a } of acc.person.m.values()) {
    const uid = key[0] as number | null;
    let p = personsOf.get(uid);
    if (!p) personsOf.set(uid, p = new Map());
    p.set(key[1] as string, a);
  }
  const empty: Persons = new Map();
  res.user = [...acc.user.m.values()].map(({ key, a }) => account(key[0] as number | null, a, personsOf.get(key[0] as number | null) ?? empty)).sort(order);
  res.group = [...acc.group.m.values()].map(({ key, a }) => out(key[0] as number | null, a, gname(key[0] as number | null))).sort(order);

  // уровни дерева: родитель (enc префикса) → записи в порядке вставки
  const byParent = (m: AccMap): Map<string, { key: unknown[]; a: Acc }[]> => {
    const idx = new Map<string, { key: unknown[]; a: Acc }[]>();
    for (const e of m.m.values()) {
      const pk = enc(e.key.slice(0, -1));
      const l = idx.get(pk);
      if (l) l.push(e); else idx.set(pk, [e]);
    }
    return idx;
  };
  const gIdx = byParent(acc.gtree);
  for (const r of res.group) { // категория раскрывается по снабженцам
    r.children = (gIdx.get(enc([r.key])) ?? [])
      .filter(e => e.key.length === 2)
      .map(e => {
        const ps: Persons = new Map();
        for (const p of gIdx.get(enc(e.key)) ?? []) if (p.key.length === 3) ps.set(p.key[2] as string, p.a);
        return account(e.key[1] as number | null, e.a, ps);
      }).sort(order);
  }
  res.region = [...acc.region.m.values()].map(({ key, a }) => out(key[0] as string, a, key[0] as string)).sort(order);
  res.dept = [...acc.dept.m.values()].map(({ key, a }) => out(key[0] as string, a, key[0] as string)).sort(order);

  // деревья: регион → департамент → категория → снабженец и департамент → регион → категория → снабженец
  const regionName = (k: number | string | null) => String(k);
  const deptName = (k: number | string | null) => `Департамент ${k}`;
  const level = (tree: AccMap, idx: Map<string, { key: unknown[]; a: Acc }[]>, names: ((k: number | string | null) => string)[], prefix: unknown[]): AggRow[] => {
    const kids = (idx.get(enc(prefix)) ?? []).filter(e => e.key.length === prefix.length + 1);
    if (prefix.length === 3) { // уровень аккаунтов: сотрудники периода внутри
      const rows = kids.map(e => {
        const ps: Persons = new Map();
        for (const p of idx.get(enc(e.key)) ?? []) if (p.key.length === 5) ps.set(p.key[4] as string, p.a);
        return account(e.key[3] as number | null, e.a, ps);
      });
      return rows.sort(order);
    }
    const rows = kids.map(e => {
      const k = e.key[e.key.length - 1] as number | string | null;
      const r = out(k, e.a, names[e.key.length - 1]!(k));
      if (prefix.length === 2) r.preg = projectRegion(facts, r.key as number | null); // регион проекта — пометить чужой
      r.children = level(tree, idx, names, [...prefix, r.key]);
      return r;
    });
    return rows.sort(order);
  };
  const tIdx = byParent(acc.tree), dIdx = byParent(acc.dtree);
  res.tree = level(acc.tree, tIdx, [regionName, deptName, gname, uname], []);
  res.dtree = level(acc.dtree, dIdx, [deptName, regionName, gname, uname], []);
  res.total = out('', acc.total.m.get(enc(['']))?.a ?? newAcc(), 'Итого');
  return res;
}

// ---------- списки задач ----------

export interface TaskListRow {
  id: number; g: number | null; dept: string; project_dept: string; region: string; project_region: string;
  created: string | null; supplier: number | null; supplier_name: string; manager_id: number | null; manager_who: string | null;
  deal: number | null; cycle: number; start: string | null; take: string | null; done: string | null; accept: string | null;
  take_min: number | null; exec_min: number | null; answer_min: number | null; cycle_min: number | null;
  skip_take: boolean | null; reopens: number; reopen_by: string | null;
  sold: string | null; shipped: string | null; lost: string | null; outcome: string | null;
}

const OUTCOME: Record<string, string> = { sold: 'продана', shipped: 'отгружена', lost: 'проиграна' };

/** Задачи, из которых сложился показатель metric: по одной строке на событие. */
export function listTasks(facts: Facts, d0: Dt, d1: Dt, metric: string, f: Filter = {}): TaskListRow[] {
  const pick = Object.prototype.hasOwnProperty.call(PICK, metric) ? PICK[metric] : undefined;
  if (!pick) throw new Error(`неизвестный показатель ${metric}`);
  const [kind, cond] = pick;
  const kinds: EventKind[] = Array.isArray(kind) ? kind : [kind];
  const byDeal = metric.startsWith('cr_'); // CR считается по сделкам: одна строка на сделку
  const rows: TaskListRow[] = [];
  const seen = new Set<string>();
  const mins = (h: number | null): number | null => (h === null ? null : pyRound0(h * 60));
  for (const [k, t, c, uid, , who, reg, dep] of events(facts, d0, d1, f)) {
    if (!kinds.includes(k) || (cond && !cond(c!))) continue;
    if (byDeal) {
      const key = `${pyStr(t.deal)}\u0001${k}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const c1 = t.cycles[0]!;
    const cc = c || c1;
    const deal = t.deal ? own(facts.deals, String(t.deal)) : undefined;
    rows.push({
      id: t.id, g: t.g, dept: dep, project_dept: deptOf(facts, t.g), region: reg,
      project_region: projectRegion(facts, t.g), created: t.created, supplier: uid,
      supplier_name: who, manager_id: t.mgr ?? null, manager_who: t.mgr_who ?? null, deal: t.deal,
      cycle: cc.n, start: cc.start, take: cc.take, done: cc.done, accept: cc.accept,
      take_min: mins(cc.take_h), exec_min: mins(cc.exec_h),
      answer_min: mins(cc.answer_h), cycle_min: mins(cc.cycle_h),
      skip_take: cc.skip_take, reopens: t.cycles.filter(x => x.reopen).length,
      reopen_by: cc.reopen_by,
      sold: deal ? deal.sold : null, shipped: deal ? deal.shipped : null, lost: deal ? deal.lost : null,
      outcome: OUTCOME[k] ?? null,
    });
  }
  rows.sort((a, b) => cmpStr(a.done || a.created || '', b.done || b.created || ''));
  return rows;
}

// ---------- товары ----------

/** Объём по единице, в которой товар просят чаще всего: [сумма, единица, число единиц измерения]. */
function unitSum(items: [number | null, string][]): [number | null, string, number] {
  const by = new Map<string, [number, number]>();
  for (const [qty, unit] of items) {
    if (qty !== null) {
      let u = by.get(unit);
      if (!u) by.set(unit, u = [0.0, 0]);
      u[0] += qty;
      u[1]++;
    }
  }
  if (!by.size) return [null, '', 0];
  let best: [string, [number, number]] | null = null;
  for (const kv of by) if (!best || kv[1][1] > best[1][1]) best = kv;
  return [pyRound(best![1][0], 2), best![0], by.size];
}

export const NONE = '_none'; // узел «Вне каталога»

/** Путь позиции в дереве: узлы каталога, либо «Вне каталога» → название позиции. */
export function itemPath(item: GoodsItem): string[] {
  return item[3] && item[3].length ? item[3] : [NONE, 'n:' + (item[0] ?? 'None')];
}

export interface GoodsRow {
  key: string; path: string; kind: string; name: string; requests: number; share_pct: number | null;
  deals: number; sold: number; sold_pct: number | null; volume: number | null; unit: string; units: number;
  children?: GoodsRow[];
}
export interface GoodsTree {
  from: string; to: string; since: string | null; catalog_at: string | null; rows: GoodsRow[]; total: GoodsRow;
}

export function goodsTree(facts: Facts, d0: Dt, d1: Dt, f: Filter = {}): GoodsTree {
  const goods = facts.goods || {}, deals = facts.deals, names = facts.cat_names || {};
  interface GA { tasks: Set<number>; deals: Set<number>; sold: Set<number>; items: [number | null, string][]; leaf: boolean }
  const acc = new Map<string, { key: string[]; a: GA }>();
  const mk = (): GA => ({ tasks: new Set(), deals: new Set(), sold: new Set(), items: [], leaf: false });
  for (const [kind, t] of events(facts, d0, d1, f)) {
    if (kind !== 'new') continue;
    const gd = own(goods, String(t.id));
    if (!gd) continue;
    const deal = t.deal ? own(deals, String(t.deal)) : undefined;
    const sold = !!(deal && deal.sold);
    const seen = new Set<string>();
    for (const item of gd.items) {
      if (item[4]) continue;
      const path = itemPath(item);
      for (let n = 0; n <= path.length; n++) {
        const key = path.slice(0, n);
        const ek = key.join('\u0001');
        let e = acc.get(ek);
        if (!e) acc.set(ek, e = { key, a: mk() });
        const a = e.a;
        if (!seen.has(ek)) { // один товар дважды в запросе — запрос считается один раз
          a.tasks.add(t.id);
          if (t.deal) {
            a.deals.add(t.deal);
            if (sold) a.sold.add(t.deal);
          }
          seen.add(ek);
        }
        if (n === path.length) {
          a.leaf = true;
          a.items.push([item[1], item[2]]);
        }
      }
    }
  }
  const label = (node: string): string => (node === NONE ? 'Вне каталога' : node.startsWith('n:') ? node.slice(2) : own(names, node) || node);
  const out = (key: string[], a: GA, parent: number | null): GoodsRow => {
    const [vol, unit, units] = a.leaf ? unitSum(a.items) : [null, '', 0];
    const n = a.tasks.size;
    return {
      key: key.length ? key[key.length - 1]! : '', path: key.join('/'), kind: key.length ? key[key.length - 1]![0]! : '',
      name: key.length ? label(key[key.length - 1]!) : 'Итого', requests: n,
      share_pct: parent ? pyRound((100 * n) / parent, 1) : null,
      deals: a.deals.size, sold: a.sold.size,
      sold_pct: a.deals.size ? pyRound((100 * a.sold.size) / a.deals.size, 1) : null,
      volume: vol, unit, units,
    };
  };
  const children = new Map<string, { key: string[]; a: GA }[]>();
  for (const e of acc.values()) {
    if (!e.key.length) continue;
    const pk = e.key.slice(0, -1).join('\u0001');
    const l = children.get(pk);
    if (l) l.push(e); else children.set(pk, [e]);
  }
  const level = (prefix: string[], parentN: number): GoodsRow[] => {
    const rows: GoodsRow[] = [];
    for (const { key, a } of children.get(prefix.join('\u0001')) ?? []) {
      const r = out(key, a, parentN);
      let kids = level(key, a.tasks.size);
      // раздел с единственной карточкой того же названия: лишний уровень не показываем, предложения — сразу под разделом
      if (kids.length === 1 && kids[0]!.kind === 'p' && kids[0]!.name === r.name) kids = kids[0]!.children ?? [];
      if (kids.length) r.children = kids;
      rows.push(r);
    }
    return rows.sort((x, y) => cmpNum(+(x.kind === NONE[0]), +(y.kind === NONE[0])) || cmpNum(-x.requests, -y.requests) || cmpStr(x.name, y.name));
  };
  const total = acc.get('')?.a ?? mk();
  return { from: d0, to: d1, since: facts.goods_since ?? null, catalog_at: facts.catalog_at ?? null, rows: level([], total.tasks.size), total: out([], total, null) };
}

/** Задачи, у которых есть позиция (не услуга) в поддереве path — список узлов от корня (для списка по клику). */
export function goodsTasks(facts: Facts, path: string[]): Set<number> {
  const goods = facts.goods || {};
  const n = path.length;
  const res = new Set<number>();
  for (const [tid, gd] of Object.entries(goods)) {
    if (gd.items.some(i => {
      if (i[4]) return false;
      const p = itemPath(i).slice(0, n);
      return p.length === n && p.every((x, j) => x === path[j]);
    })) res.add(Number(tid));
  }
  return res;
}

// ---------- доля запросов по доминирующей категории сделки (deals.json) ----------

function chainOf(parents: Record<string, string | null>, node: string | null): string[] {
  const out: string[] = [];
  while (node) {
    out.push(node);
    node = own(parents, node) ?? null;
  }
  return out.reverse();
}

function* domDeals(dd: DealsData, d0: Dt, d1: Dt, region: string | Iterable<string> | null | undefined): Generator<DealRow> {
  const ins = inside(d0, d1);
  const set = toSet<string>(region ?? null, isStr);
  for (const d of dd.deals) if (ins(d[1]) && (!set || !set.size || (d[2] !== null && set.has(d[2])))) yield d;
}

export interface DomRow {
  key: string; path: string; kind: string; name: string; deals: number; req: number; share_pct: number | null; tasks: number;
  amount: number; sold: number; sold_pct: number | null; has: number; has_req: number; has_share_pct: number | null;
  children?: DomRow[];
}
export interface DomTree { from: string; to: string; built_at: string | null; rows: DomRow[]; total: DomRow }

export function domTree(dd: DealsData, d0: Dt, d1: Dt, region: string | Iterable<string> | null = null): DomTree {
  const parents = dd.parents, names = dd.names;
  interface DA { deals: number; req: number; tasks: number; amount: number; sold: number; has: number; has_req: number }
  const mk = (): DA => ({ deals: 0, req: 0, tasks: 0, amount: 0.0, sold: 0, has: 0, has_req: 0 });
  const acc = new Map<string, DA>();
  const chains = new Map<string, string[]>();
  const chain = (n: string): string[] => {
    let c = chains.get(n);
    if (!c) chains.set(n, c = chainOf(parents, n));
    return c;
  };
  const total = mk();
  for (const d of domDeals(dd, d0, d1, region)) {
    const hasReq = d[8].length > 0 ? 1 : 0;
    total.deals++; total.req += hasReq; total.tasks += d[8].length; total.amount += d[3]; total.sold += d[4];
    for (const node of chain(d[6])) {
      let a = acc.get(node);
      if (!a) acc.set(node, a = mk());
      a.deals++; a.req += hasReq; a.tasks += d[8].length; a.amount += d[3]; a.sold += d[4];
    }
    const seen = new Set<string>();
    for (const leaf of d[7]) {
      for (const node of chain(leaf)) {
        if (seen.has(node)) continue;
        seen.add(node);
        let a = acc.get(node);
        if (!a) acc.set(node, a = mk());
        a.has++; a.has_req += hasReq;
      }
    }
  }
  const out = (node: string, a: DA): DomRow => ({
    key: node, path: node, kind: node.slice(0, 1), name: own(names, node) || node,
    deals: a.deals, req: a.req, share_pct: pct(a.req, a.deals), tasks: a.tasks,
    amount: pyRound0(a.amount), sold: a.sold, sold_pct: pct(a.sold, a.deals),
    has: a.has, has_req: a.has_req, has_share_pct: pct(a.has_req, a.has),
  });
  const children = new Map<string | null, string[]>();
  for (const node of acc.keys()) {
    const p = own(parents, node) ?? null;
    const l = children.get(p);
    if (l) l.push(node); else children.set(p, [node]);
  }
  const level = (parent: string | null): DomRow[] => {
    const rows: DomRow[] = [];
    for (const node of children.get(parent) ?? []) {
      const r = out(node, acc.get(node)!);
      let kids = level(node);
      if (kids.length === 1 && kids[0]!.kind === 'p' && kids[0]!.name === r.name) kids = level(kids[0]!.key);
      if (kids.length) r.children = kids;
      rows.push(r);
    }
    return rows.sort((x, y) => cmpNum(+(x.key === UNDEF_KEY), +(y.key === UNDEF_KEY)) || cmpNum(-x.deals, -y.deals) || cmpNum(-x.has, -y.has) || cmpStr(x.name, y.name));
  };
  return { from: d0, to: d1, built_at: dd.built_at ?? null, rows: level(null), total: { ...out('', total), name: 'Итого', kind: '' } };
}
const UNDEF_KEY = '_undef';

export interface DomDealRow {
  deal: number; created: string | null; region: string | null; amount: number; sold: boolean; lost: boolean; dominant: string; tasks: number[];
}

/** Сделки узла node за период: kind = dom (доминирует) или has (есть позиция). */
export function domDealsList(dd: DealsData, d0: Dt, d1: Dt, node: string, kind: 'dom' | 'has', region: string | Iterable<string> | null = null): DomDealRow[] {
  const parents = dd.parents, names = dd.names;
  const rows: DomDealRow[] = [];
  for (const d of domDeals(dd, d0, d1, region)) {
    const ok = kind === 'dom' ? chainOf(parents, d[6]).includes(node) : d[7].some(leaf => chainOf(parents, leaf).includes(node));
    if (ok) {
      rows.push({
        deal: d[0], created: d[1], region: d[2], amount: d[3], sold: !!d[4], lost: !!d[5],
        dominant: d[6] !== UNDEF_KEY ? chainOf(parents, d[6]).slice(0, 2).map(n => (Object.prototype.hasOwnProperty.call(names, n) ? names[n] : n)).join(' / ') : 'Не определено',
        tasks: d[8],
      });
    }
  }
  rows.sort((a, b) => cmpStr(b.created ?? '', a.created ?? ''));
  return rows;
}
