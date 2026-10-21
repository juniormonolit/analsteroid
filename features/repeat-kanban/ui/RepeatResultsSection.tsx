'use client';
// «Аналитика канбана повторных» → вкладка «Результат» (владелец 21.10: «результат задачи —
// только следующая отгрузка заказчика после постановки»). Воронка задачи проекта 118:
// поставлена → дозвонились → продано → отгружено (₽, дни). Методика и атрибуция — в шапке
// engine/results.ts. Иерархия и сортировка — как у таблицы «Проработанность» на этой же
// странице: первым уровнем подразделения «Отдела продаж», остальное — «Прочие подразделения».
import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { KanbanResults, ResultTask } from '../engine/results';
import type { OrgNode } from '../engine/saLookups';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const moneyShort = (n: number) => (n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1).replace('.', ',')} млрд ₽` : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} млн ₽` : n >= 1000 ? `${Math.round(n / 1000)} тыс. ₽` : `${rub.format(n)} ₽`);
const pct1 = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const DAY_MS = 86_400_000;
const fmtD = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('.');

// ── Агрегат ──────────────────────────────────────────────────────────────────
interface RAgg {
  managers: number;
  /** Все задачи периода. */
  tasks: number;
  /** Перепоставлены до отгрузки — вне базы конверсий. */
  superseded: number;
  /** База: задачи, не перепоставленные до отгрузки. */
  base: number;
  reached: number;
  /** Зрелые (старше 30 дн.) — база конверсий «продано»/«отгружено». */
  mature: number;
  soldN: number; shippedN: number;
  /** Отгружено всего (без ограничения 30 дн.) и сумма. */
  shipped: number; shippedSum: number;
  /** Отгрузка по заказу, проданному ещё до задачи. */
  preSold: number;
  /** В процессе: моложе 30 дн. и ещё не отгружено. */
  open: number;
  days: number[];
}
const zero = (): RAgg => ({ managers: 0, tasks: 0, superseded: 0, base: 0, reached: 0, mature: 0, soldN: 0, shippedN: 0, shipped: 0, shippedSum: 0, preSold: 0, open: 0, days: [] });
function merge(list: RAgg[]): RAgg {
  const o = zero();
  for (const a of list) {
    for (const k of Object.keys(o) as (keyof RAgg)[]) if (k !== 'days') (o[k] as number) += a[k] as number;
    o.days.push(...a.days);
  }
  return o;
}
function aggOfTasks(tasks: ResultTask[], matureDays: number): RAgg {
  const o = zero();
  o.managers = 1;
  const lim = matureDays * DAY_MS;
  for (const t of tasks) {
    o.tasks++;
    if (t.superseded) { o.superseded++; continue; }
    o.base++;
    const at = new Date(t.createdAt).getTime();
    if (t.reachedAt) o.reached++;
    if (t.shippedAt) {
      const ms = new Date(t.shippedAt).getTime() - at;
      o.shipped++; o.shippedSum += t.shippedAmount ?? 0; o.days.push(ms / DAY_MS);
      if (t.preSold) o.preSold++;
    }
    if (t.mature) {
      o.mature++;
      if (t.soldAt && new Date(t.soldAt).getTime() - at <= lim) o.soldN++;
      if (t.shippedAt && new Date(t.shippedAt).getTime() - at <= lim) o.shippedN++;
    } else if (!t.shippedAt) o.open++;
  }
  return o;
}
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};
const reachPct = (a: RAgg) => pct1(a.reached, a.base);
const soldPct = (a: RAgg) => pct1(a.soldN, a.mature);
const convPct = (a: RAgg) => pct1(a.shippedN, a.mature);

// ── Дерево (та же форма, что у «Проработанности») ────────────────────────────
interface RNode { id: string; name: string; depth: number; kind: 'org' | 'mgr'; agg: RAgg; children: RNode[] }

function buildResultTree(org: OrgNode[], leaves: { id: string; name: string; deptId: string | null; agg: RAgg }[]): RNode[] {
  const byId = new Map(org.map(o => [o.id, o]));
  const childrenOf = new Map<string | null, OrgNode[]>();
  for (const o of org) { const p = o.parentId && byId.has(o.parentId) ? o.parentId : null; const l = childrenOf.get(p) ?? []; l.push(o); childrenOf.set(p, l); }
  const byDept = new Map<string, typeof leaves>();
  for (const m of leaves) { const k = m.deptId && byId.has(m.deptId) ? m.deptId : '__none'; const l = byDept.get(k) ?? []; l.push(m); byDept.set(k, l); }
  const leaf = (m: (typeof leaves)[number]): RNode => ({ id: `m:${m.id}`, name: m.name, depth: 0, kind: 'mgr', agg: m.agg, children: [] });
  const mk = (o: OrgNode): RNode | null => {
    const all = [...(childrenOf.get(o.id) ?? []).map(mk).filter((x): x is RNode => !!x), ...(byDept.get(o.id) ?? []).map(leaf)];
    return all.length ? { id: o.id, name: o.name, depth: 0, kind: 'org', agg: merge(all.map(c => c.agg)), children: all } : null;
  };
  let top = (childrenOf.get(null) ?? []).map(mk).filter((x): x is RNode => !!x);
  // Одиночный корень («Дирекция») разворачиваем; «Отдел продаж» — первым уровнем, прочее — в один узел.
  while (top.length === 1 && top[0].children.some(c => c.kind === 'org')) top = top[0].children;
  const sales = top.find(n => n.kind === 'org' && /^отдел продаж$/i.test(n.name.trim()));
  if (sales) {
    const rest = top.filter(n => n !== sales);
    top = [...sales.children];
    if (rest.length) top.push({ id: '__other', name: 'Прочие подразделения', depth: 0, kind: 'org', agg: merge(rest.map(c => c.agg)), children: rest });
  }
  const none = byDept.get('__none');
  if (none?.length) { const kids = none.map(leaf); top.push({ id: '__none', name: 'Без отдела', depth: 0, kind: 'org', agg: merge(kids.map(c => c.agg)), children: kids }); }
  const redepth = (n: RNode, d: number) => { n.depth = d; n.children.forEach(c => redepth(c, d + 1)); };
  top.forEach(r => redepth(r, 0));
  return top;
}

type SortKey = 'name' | 'tasks' | 'reach' | 'sold' | 'shipped' | 'sum' | 'conv' | 'open' | 'days';
const COLS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'name', label: 'Подразделение', hint: 'Филиал → департамент → отдел → команда → менеджер (ответственный задачи)' },
  { key: 'tasks', label: 'Поставлено', hint: 'Задачи проекта «Повторные продажи», созданные в периоде (из канбана и прямо в Битриксе). Серым — перепоставлены до отгрузки: их результат засчитан последней задаче' },
  { key: 'reach', label: 'Дозвон', hint: 'Звонок > 20 с по сделке задачи после постановки — среди задач без перепостановки' },
  { key: 'sold', label: 'Продано', hint: 'Продажа заказчика (любая сделка воронок 0–3) в течение 30 дней после задачи — среди задач старше 30 дней' },
  { key: 'shipped', label: 'Отгружено', hint: 'Следующая отгрузка заказчика после задачи (за всё время наблюдения)' },
  { key: 'sum', label: 'Сумма отгрузок', hint: 'Сумма сделок этих отгрузок' },
  { key: 'conv', label: 'Задача → отгрузка', hint: 'Отгрузка в течение 30 дней после задачи — среди задач старше 30 дней (у свежих отгрузка ещё не могла наступить)' },
  { key: 'open', label: 'В процессе', hint: 'Задачам меньше 30 дней, отгрузки пока нет — исход ещё неизвестен' },
  { key: 'days', label: 'Дней до отгрузки', hint: 'Медиана дней от постановки задачи до отгрузки' },
];
const sortVal = (n: RNode, k: SortKey): number | string => {
  const a = n.agg;
  switch (k) {
    case 'name': return n.name; case 'tasks': return a.tasks; case 'reach': return reachPct(a) ?? -1; case 'sold': return soldPct(a) ?? -1;
    case 'shipped': return a.shipped; case 'sum': return a.shippedSum; case 'conv': return convPct(a) ?? -1; case 'open': return a.open;
    case 'days': return median(a.days) ?? Infinity;
  }
};

const head = 'whitespace-nowrap px-2 py-2 text-right text-[11.5px] font-medium text-[var(--color-text-muted)] select-none';
const cell = 'whitespace-nowrap px-2 py-1.5 text-right tabular-nums';
const muted = 'ml-1 text-[11px] font-normal text-[var(--color-text-muted)]';

function Pct({ v, a, b }: { v: number | null; a: number; b: number }) {
  if (v === null) return <span className="text-[var(--color-text-muted)]" title="Нет задач в базе">—</span>;
  return <span title={`${a} из ${b}`}><b>{v}%</b><span className={muted}>{a}/{b}</span></span>;
}

function Cells({ a }: { a: RAgg }) {
  const med = median(a.days);
  return (
    <>
      <td className={cell}>{rub.format(a.tasks)}{a.superseded > 0 && <span className={muted} title="Перепоставлены до отгрузки">−{a.superseded}</span>}</td>
      <td className={cell}><Pct v={reachPct(a)} a={a.reached} b={a.base} /></td>
      <td className={cell}><Pct v={soldPct(a)} a={a.soldN} b={a.mature} /></td>
      <td className={cell}>{rub.format(a.shipped)}{a.preSold > 0 && <span className={muted} title="Из них заказ был продан ещё до задачи">в т.ч. {a.preSold} до задачи</span>}</td>
      <td className={cell}>{moneyShort(a.shippedSum)}</td>
      <td className={cell}><Pct v={convPct(a)} a={a.shippedN} b={a.mature} /></td>
      <td className={cell}>{a.open ? rub.format(a.open) : <span className="text-[var(--color-text-muted)]">—</span>}</td>
      <td className={cell}>{med === null ? <span className="text-[var(--color-text-muted)]">—</span> : `${String(med).replace('.', ',')} дн.`}</td>
    </>
  );
}

export function RepeatResultsSection({ date, period }: { date: string; period: 'day' | 'week' | 'month' }) {
  const { data, isLoading, error } = useQuery<KanbanResults>({
    queryKey: ['repeat-kanban-results', date, period],
    queryFn: async () => {
      const r = await fetch(`/api/repeat-kanban/analytics/results?date=${date}&period=${period}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Ошибка');
      return j;
    },
  });
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>({ key: 'sum', dir: -1 });
  const [open, setOpen] = useState<Set<string>>(new Set());

  const { roots, total } = useMemo(() => {
    if (!data) return { roots: [] as RNode[], total: null as RAgg | null };
    const byMgr = new Map<string, ResultTask[]>();
    for (const t of data.tasks) { const k = t.managerId ?? '__none'; const l = byMgr.get(k) ?? []; l.push(t); byMgr.set(k, l); }
    const leaves = [...byMgr.entries()].map(([id, ts]) => ({
      id, name: id === '__none' ? 'Без ответственного' : data.managers[id]?.name ?? `#${id}`,
      deptId: id === '__none' ? null : data.managers[id]?.deptId ?? null, agg: aggOfTasks(ts, data.matureDays),
    }));
    return { roots: buildResultTree(data.org, leaves), total: merge(leaves.map(l => l.agg)) };
  }, [data]);

  const sorted = (nodes: RNode[]) => !sort ? nodes : [...nodes].sort((a, b) => {
    const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
    return (typeof va === 'string' ? va.localeCompare(vb as string, 'ru') : (va as number) - (vb as number)) * sort.dir;
  });
  // «Дней до отгрузки» — меньше лучше: первый клик по возрастанию.
  const clickSort = (k: SortKey) => setSort(s => {
    const first: 1 | -1 = k === 'name' || k === 'days' ? 1 : -1;
    return !s || s.key !== k ? { key: k, dir: first } : s.dir === first ? { key: k, dir: first === 1 ? -1 : 1 } : null;
  });
  const expandTo = (depth: number | 'mgr') => {
    const ids = new Set<string>();
    const walk = (n: RNode) => { if (n.kind === 'org' && (depth === 'mgr' || n.depth < depth)) ids.add(n.id); n.children.forEach(walk); };
    roots.forEach(walk);
    setOpen(ids);
  };

  const renderRows = (nodes: RNode[]): React.ReactNode => sorted(nodes).map(n => {
    const isOpen = open.has(n.id);
    return (
      <Fragment key={n.id}>
        <tr className={`border-b border-[var(--color-border)] ${n.depth === 0 ? 'bg-[var(--color-bg)]' : ''} hover:bg-[var(--color-bg-hover)]`}>
          <td className="sticky left-0 z-10 bg-inherit px-2 py-1.5 text-left" style={{ paddingLeft: 8 + n.depth * 18 }}>
            <div className="flex items-center gap-1">
              {n.kind === 'org' ? (
                <button type="button" onClick={() => setOpen(s => { const x = new Set(s); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; })}
                  className="tap-target inline-flex h-5 w-5 items-center justify-center text-[var(--color-text-muted)]" aria-label={isOpen ? 'Свернуть' : 'Раскрыть'}>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : <span className="inline-block w-5" />}
              <span className={n.kind === 'org' ? (n.depth === 0 ? 'font-bold' : 'font-semibold') : ''}>{n.name}</span>
              {n.kind === 'org' && <span className="text-[11px] text-[var(--color-text-muted)]">· {n.agg.managers}</span>}
            </div>
          </td>
          <Cells a={n.agg} />
        </tr>
        {isOpen && renderRows(n.children)}
      </Fragment>
    );
  });

  const Kpi = ({ label, value, sub }: { label: string; value: string; sub: string }) => (
    <div className="flex min-w-0 flex-col justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5">
      <div className="text-[11.5px] text-[var(--color-text-muted)]">{label}</div>
      <div className="text-[24px] font-bold leading-tight tabular-nums">{value}</div>
      <div className="text-[11.5px] text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );

  if (error) return <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{(error as Error).message}</div>;
  if (isLoading || !data || !total) return <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Считаю результат задач…</div>;
  const md = data.matureDays;
  const conv = convPct(total), med = median(total.days);
  const periodLabel = data.period === 'day' ? fmtD(data.date) : `${fmtD(data.fromDate)}–${fmtD(data.date)}`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Задачи проекта «Повторные продажи», поставленные {data.period === 'day' ? '' : 'с '}{periodLabel}. Результат задачи — <b>следующая отгрузка заказчика</b> после
        постановки; если до отгрузки по заказчику ставили ещё задачу, отгрузка засчитана последней. Конверсии «продано» и «задача → отгрузка» —
        по задачам старше {md} дней (исход за {md} дней), у свежих — «в процессе».
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Задач поставлено" value={rub.format(total.tasks)} sub={`перепоставлено ${total.superseded} · в процессе ${total.open}`} />
        <Kpi label="Отгружено по задачам" value={moneyShort(total.shippedSum)} sub={`${rub.format(total.shipped)} отгрузок${total.preSold ? ` · ${total.preSold} — заказ до задачи` : ''}`} />
        <Kpi label="Задача → отгрузка" value={conv === null ? '—' : `${conv}%`}
          sub={total.mature ? `${total.shippedN} из ${total.mature} задач старше ${md} дн.` : `задачам периода меньше ${md} дн. — возьмите дату раньше`} />
        <Kpi label="Дозвонились" value={reachPct(total) === null ? '—' : `${reachPct(total)}%`} sub={`${total.reached} из ${total.base} задач`} />
        <Kpi label="Дней до отгрузки" value={med === null ? '—' : String(med).replace('.', ',')} sub="медиана от постановки" />
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Результат по подразделениям · {periodLabel}</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            <button type="button" onClick={() => setOpen(new Set())} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">Только филиалы</button>
            <button type="button" onClick={() => expandTo(3)} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">До отделов</button>
            <button type="button" onClick={() => expandTo('mgr')} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">До менеджеров</button>
          </div>
        </div>
        {data.tasks.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">За период задач в проекте не ставили.</div> : (
          <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <table className="w-full min-w-[1080px] text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  {COLS.map((c, i) => (
                    <th key={c.key} title={c.hint} className={`${head} ${i === 0 ? 'sticky left-0 z-10 bg-[var(--color-bg-surface)] text-left' : ''} cursor-pointer hover:text-[var(--color-text)]`} onClick={() => clickSort(c.key)}>
                      {c.label}{sort?.key === c.key ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}
                    </th>
                  ))}
                </tr>
                <tr className="border-b-2 border-[var(--color-border-strong)] bg-[var(--color-bg)] font-bold">
                  <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-1.5 text-left">Итого <span className="text-[11px] font-normal text-[var(--color-text-muted)]">· {total.managers} менеджеров</span></td>
                  <Cells a={total} />
                </tr>
              </thead>
              <tbody>{renderRows(roots)}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
