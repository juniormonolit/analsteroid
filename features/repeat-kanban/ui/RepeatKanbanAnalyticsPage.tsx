'use client';
// «Аналитика канбана повторных» v2 (владелец 20.10: «сортировка по клику на заголовки,
// иерархия с агрегацией по филиалам, проконсультируйся с Fable — сделайте охуенно»; доступ —
// директорам и выше). ТЗ Fable: KPI-ряд → иерархическая таблица (филиал → … → менеджер,
// взвешенные % вверх по дереву, сортировка внутри уровня, светофор, Итого сверху) → люди
// (рейтинг с антиметрикой) → «куда ушёл пул» → динамика (копится) → журнал по людям.
// 21.10: вкладка «Результат» (задача → следующая отгрузка, RepeatResultsSection) и события
// Битрикса в журнале и счётчиках людей (engine/bitrixEvents.ts) с пометкой источника.
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, Info } from 'lucide-react';
import { taskUrl } from '../engine/config';
import { RepeatResultsSection } from './RepeatResultsSection';
import type { KanbanAnalytics, MgrDay, OrgNode, JournalRow } from '../engine/analytics';
import type { ManagerSummary } from '@/features/ai-analysis/engine/summary';
import { VIOLATION_LABELS } from '@/features/ai-analysis/engine/parse';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
// От миллиарда — «млрд» (владелец 21.10: «5057,1 млн» → «5,1 млрд»).
const moneyShort = (n: number) => (n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1).replace('.', ',')}\u00a0млрд\u00a0₽` : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')}\u00a0млн\u00a0₽` : n >= 1000 ? `${Math.round(n / 1000)}\u00a0тыс.\u00a0₽` : `${rub.format(n)}\u00a0₽`);
const todayMsk = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const fmtD = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('.');
const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;
const pct1 = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
/** Процент по-русски: «10,5%». */
const pctRu = (v: number) => `${String(v).replace('.', ',')}%`;

// ── Агрегат узла ──────────────────────────────────────────────────────────────
interface Agg {
  managers: number; total: number; pool: number; poolHot: number; poolPotential: number;
  inWork: number; reached: number; funnel: number; funnelSum: number; review: number; hidden: number; brak: number;
  tasksOpen: number; tasksOverdue: number; tasksControl: number; noTask: number; actions: number; tasksCreated: number; tasksAccepted: number;
  workedByTask: number;
}
const ZERO: Agg = { managers: 0, total: 0, pool: 0, poolHot: 0, poolPotential: 0, inWork: 0, reached: 0, funnel: 0, funnelSum: 0, review: 0, hidden: 0, brak: 0, tasksOpen: 0, tasksOverdue: 0, tasksControl: 0, noTask: 0, actions: 0, tasksCreated: 0, tasksAccepted: 0, workedByTask: 0 };
function add(a: Agg, m: MgrDay | Agg): Agg {
  const o = { ...a };
  for (const k of Object.keys(ZERO) as (keyof Agg)[]) if (k !== 'managers') o[k] += (m as unknown as Record<string, number>)[k] ?? 0;
  o.managers += 'managerId' in m ? 1 : (m as Agg).managers;
  return o;
}
// Проработано (владелец 21.10, как кольцо доски): заказчики в работе С задачей РОПа против тех, у кого
// окно открыто, а сделки нет. Сделки роботов/менеджеров без задачи не в счёт (давали 78 % «ни за что»).
// Имя strict оставлено — им пользуются сортировка, светофор и динамика. soft — доля не в пуле (справочно).
const strict = (a: Agg) => pct1(a.workedByTask, a.workedByTask + a.poolHot);
const soft = (a: Agg) => pct1(a.total - a.pool, a.total);

interface TreeNode {
  id: string; name: string; depth: number; kind: 'org' | 'mgr'; agg: Agg; children: TreeNode[];
  series: number[]; // строгое % по датам
  mgrIds: Set<string>;
}

function buildTree(org: OrgNode[], mgr: MgrDay[], snapDate: string, dates: string[]): { roots: TreeNode[]; total: TreeNode } {
  const byId = new Map(org.map(o => [o.id, o]));
  const childrenOf = new Map<string | null, OrgNode[]>();
  for (const o of org) { const p = o.parentId && byId.has(o.parentId) ? o.parentId : null; const l = childrenOf.get(p) ?? []; l.push(o); childrenOf.set(p, l); }
  const last = mgr.filter(m => m.date === snapDate);
  const mgrByDept = new Map<string, MgrDay[]>();
  for (const m of last) { const k = m.deptId && byId.has(m.deptId) ? m.deptId : '__none'; const l = mgrByDept.get(k) ?? []; l.push(m); mgrByDept.set(k, l); }
  const byDate = new Map<string, MgrDay[]>();
  for (const m of mgr) { const l = byDate.get(m.date) ?? []; l.push(m); byDate.set(m.date, l); }
  const seriesOf = (ids: Set<string>) => dates.map(d => { let a = ZERO; for (const m of byDate.get(d) ?? []) if (ids.has(m.managerId)) a = add(a, m); return strict(a); });

  const mk = (o: OrgNode, depth: number): TreeNode | null => {
    const kids = (childrenOf.get(o.id) ?? []).map(c => mk(c, depth + 1)).filter((x): x is TreeNode => !!x);
    const mgrs = (mgrByDept.get(o.id) ?? []).map(m => ({
      id: `m:${m.managerId}`, name: m.name, depth: depth + 1, kind: 'mgr' as const, agg: add(ZERO, m), children: [],
      series: [] as number[], mgrIds: new Set([m.managerId]),
    }));
    const all = [...kids, ...mgrs];
    if (!all.length) return null;
    const ids = new Set(all.flatMap(c => [...c.mgrIds]));
    const node: TreeNode = { id: o.id, name: o.name, depth, kind: 'org', agg: all.reduce((s, c) => add(s, c.agg), ZERO), children: all, series: [], mgrIds: ids };
    return node;
  };
  const roots = (childrenOf.get(null) ?? []).map(o => mk(o, 0)).filter((x): x is TreeNode => !!x);
  const none = mgrByDept.get('__none');
  if (none?.length) {
    const kids = none.map(m => ({ id: `m:${m.managerId}`, name: m.name, depth: 1, kind: 'mgr' as const, agg: add(ZERO, m), children: [], series: [] as number[], mgrIds: new Set([m.managerId]) }));
    roots.push({ id: '__none', name: 'Без отдела', depth: 0, kind: 'org', agg: kids.reduce((s, c) => add(s, c.agg), ZERO), children: kids, series: [], mgrIds: new Set(none.map(m => m.managerId)) });
  }
  // Одиночный верхний узел («Дирекция» — корень оргструктуры) не уровень анализа: разворачиваем,
  // пока сверху один узел, — первым уровнем идут филиалы/департаменты.
  let top: TreeNode[] = roots.filter(r => r.id !== '__none');
  const noneNode = roots.find(r => r.id === '__none');
  while (top.length === 1 && top[0].children.some(c => c.kind === 'org')) top = top[0].children;
  // Анализ — по продажам: первым уровнем идут подразделения «Отдела продаж» (филиалы и
  // департаменты), всё остальное под «Дирекцией» (снабжение, бухгалтерия, люди напрямую) —
  // в свёрнутый узел «Прочие подразделения».
  const sales = top.find(n => n.kind === 'org' && /^отдел продаж$/i.test(n.name.trim()));
  if (sales) {
    const rest = top.filter(n => n !== sales);
    top = [...sales.children];
    if (rest.length) {
      top.push({ id: '__other', name: 'Прочие подразделения', depth: 0, kind: 'org', agg: rest.reduce((s, c) => add(s, c.agg), ZERO),
        children: rest, series: [], mgrIds: new Set(rest.flatMap(c => [...c.mgrIds])) });
    }
  }
  const finalRoots = noneNode ? [...top, noneNode] : top;
  const redepth = (n: TreeNode, d: number) => { n.depth = d; n.children.forEach(c => redepth(c, d + 1)); };
  finalRoots.forEach(r => redepth(r, 0));
  const fill = (n: TreeNode) => { n.series = seriesOf(n.mgrIds); n.children.forEach(fill); };
  finalRoots.forEach(fill);
  const allIds = new Set(last.map(m => m.managerId));
  const total: TreeNode = { id: '__total', name: 'Итого', depth: 0, kind: 'org', agg: last.reduce((s, m) => add(s, m), ZERO), children: [], series: seriesOf(allIds), mgrIds: allIds };
  return { roots: finalRoots, total };
}

type SortKey = 'name' | 'total' | 'pool' | 'potential' | 'strict' | 'inWork' | 'funnel' | 'delta';
const COLS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'name', label: 'Подразделение', hint: 'Филиал → департамент → отдел → команда → менеджер' },
  { key: 'total', label: 'Заказчиков', hint: 'Все, кроме брака' },
  { key: 'pool', label: 'В пуле', hint: 'Нет открытой повторной сделки; серым — «Срочно» (окно 22 дня открыто)' },
  { key: 'potential', label: 'Потенциал пула', hint: 'Годовая выручка заказчиков пула, если их вернуть' },
  { key: 'strict', label: 'Проработано', hint: 'Заказчики, по которым РОП поставил задачу, среди них плюс тех, у кого окно повторной продажи открыто, а сделки нет. Сделки без задачи не в счёт. Взвешенно по заказчикам вверх по дереву' },
  { key: 'inWork', label: 'В дозвоне', hint: 'Взят в работу и попытки связаться' },
  { key: 'funnel', label: 'В воронке', hint: 'Повторные сделки в работе: штук / сумма' },
  { key: 'delta', label: 'Δ за период', hint: 'Изменение «проработано» за доступные дни, п.п.; линия — 30 дней' },
];
const sortVal = (n: TreeNode, k: SortKey): number | string => {
  const a = n.agg;
  switch (k) {
    case 'name': return n.name; case 'total': return a.total; case 'pool': return a.pool; case 'potential': return a.poolPotential;
    case 'strict': return strict(a); case 'inWork': return a.inWork; case 'funnel': return a.funnelSum;
    case 'delta': return n.series.length > 1 ? n.series[n.series.length - 1] - n.series[0] : -Infinity;
  }
};

function Light({ v }: { v: number }) {
  const st = v < 30 ? { bg: '#f4cccc', fg: '#990000' } : v < 60 ? { bg: '#fff2cc', fg: '#7f6000' } : { bg: '#d9ead3', fg: '#38761d' };
  return <span className="inline-block min-w-[56px] rounded px-1.5 py-0.5 text-right font-bold tabular-nums" style={{ background: st.bg, color: st.fg }}>{pctRu(v)}</span>;
}
function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="text-[11px] text-[var(--color-text-muted)]">с {points.length ? 'первого снимка' : '—'}</span>;
  const w = 60, h = 18, max = Math.max(10, ...points);
  const step = w / (points.length - 1);
  return <svg width={w} height={h} aria-hidden><path d={points.map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - (p / max) * h).toFixed(1)}`).join(' ')} fill="none" stroke="var(--color-accent)" strokeWidth="1.8" /></svg>;
}
function Delta({ points: all, window }: { points: number[]; window?: number }) {
  const points = window ? all.slice(-window) : all;
  if (points.length < 2) return <span className="text-[11px] text-[var(--color-text-muted)]">нет сравнения</span>;
  const d = Math.round((points[points.length - 1] - points[0]) * 10) / 10;
  return <span className="tabular-nums font-semibold" style={{ color: d > 0 ? '#38761d' : d < 0 ? '#990000' : 'var(--color-text-muted)' }}>{d > 0 ? '▲' : d < 0 ? '▼' : ''}{d === 0 ? '—' : ` ${Math.abs(d)} п.п.`}</span>;
}

// ── Журнал: группы действий ───────────────────────────────────────────────────
const EVENT_LABEL: Record<string, string> = {
  deal_task_created: 'Сделка + задача', deal_returned_from_reject: 'Сделка из отказа + задача', task_created: 'Задача в сделку',
  task_comment_posted: 'Комментарий в чат', reject_reviewed: 'Разобран отказ', rejected_direct: 'Сразу в брак',
  hidden: 'Скрыт из пула', unhidden: 'Возвращён в пул', reject_cleared: 'Снят брак',
  task_accepted: 'Задача принята', task_accepted_deal_closed: 'Задача принята, сделка в брак', task_returned: 'Задача на доработку',
  tags_set: 'Теги',
  // События Битрикса (source = 'bitrix').
  bx_task_created: 'Задача в Битриксе', bx_task_submitted: 'Сдал на проверку', bx_task_closed: 'Задача завершена',
  bx_stage: 'Стадия сделки', bx_call_reached: 'Дозвон', bx_call_attempt: 'Попытка звонка',
};
const KIND_OF: Record<string, 'work' | 'leak' | 'undo' | 'aux' | 'bitrix'> = {
  deal_task_created: 'work', deal_returned_from_reject: 'work', task_created: 'work', reject_reviewed: 'work',
  rejected_direct: 'leak', hidden: 'leak', unhidden: 'undo', reject_cleared: 'undo', task_comment_posted: 'aux',
  task_accepted: 'work', task_returned: 'work', task_accepted_deal_closed: 'leak', tags_set: 'aux',
  // Задача, поставленная прямо в Битриксе, — та же работа, что «Задача в сделку» кликом.
  bx_task_created: 'work', bx_task_submitted: 'bitrix', bx_task_closed: 'bitrix', bx_stage: 'bitrix', bx_call_reached: 'bitrix', bx_call_attempt: 'bitrix',
};
const KIND_LABEL = { work: 'Работа', leak: 'Утечка (скрыто, брак)', undo: 'Откаты', bitrix: 'Битрикс: стадии, звонки, сдача задач' } as const;
/** Действие человека в счётчиках «Действий» (рейтинг, KPI): клики канбана без комментариев и
 *  задачи, поставленные в Битриксе (их канбан не видел). Стадии, звонки, сдача/приёмка —
 *  отдельными колонками «В Битриксе», чтобы десятки звонков не топили клики РОПа. */
const isAction = (j: JournalRow) => j.type !== 'task_comment_posted' && j.type !== 'tags_set' && (j.source === 'kanban' || j.type === 'bx_task_created');
const fmtSec = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
function labelOf(j: JournalRow): string {
  if (j.type === 'bx_stage') return `Стадия: ${String(j.payload.stageName ?? j.payload.stageId ?? '')}`;
  if (j.type === 'bx_task_closed') return j.payload.accepted ? 'Задача принята' : 'Задача завершена';
  if (j.type === 'bx_call_reached' || j.type === 'bx_call_attempt') {
    const sec = Number(j.payload.sec ?? 0);
    return `${EVENT_LABEL[j.type]}${j.payload.inbound ? ' (входящий)' : ''}${sec ? ` ${fmtSec(sec)}` : ''}`;
  }
  return EVENT_LABEL[j.type] ?? j.type;
}
/** Куда ушёл заказчик действием: для стека «куда ушёл пул». */
function sinkOf(j: JournalRow): 'deal' | 'return' | 'noanswer' | 'hidden' | 'brak' | null {
  if (j.type === 'deal_task_created' || j.type === 'deal_returned_from_reject' || j.type === 'task_created' || j.type === 'bx_task_created') return 'deal';
  if (j.type === 'hidden') return 'hidden';
  if (j.type === 'rejected_direct' || j.type === 'task_accepted_deal_closed') return 'brak';
  if (j.type === 'reject_reviewed') return j.payload.decision === 'brak' ? 'brak' : j.payload.decision === 'no_answer' ? 'noanswer' : 'return';
  return null;
}
const SINKS = [
  { key: 'deal', label: 'Сделка + задача', color: '#38761d' }, { key: 'return', label: 'Вернули менеджеру', color: '#6aa84f' },
  { key: 'noanswer', label: 'Недозвон', color: '#b7b7b7' }, { key: 'hidden', label: 'Скрыт', color: '#e69138' }, { key: 'brak', label: 'Брак', color: '#cc0000' },
] as const;

const head = 'whitespace-nowrap px-2 py-2 text-right text-[11.5px] font-medium text-[var(--color-text-muted)] select-none';
const cell = 'whitespace-nowrap px-2 py-1.5 text-right tabular-nums';

export function RepeatKanbanAnalyticsPage() {
  const [date, setDate] = useState(todayMsk());
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');
  const { data, isLoading, error } = useQuery<KanbanAnalytics>({
    queryKey: ['repeat-kanban-analytics', date, period],
    queryFn: async () => {
      const r = await fetch(`/api/repeat-kanban/analytics?date=${date}&period=${period}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Ошибка');
      return j;
    },
  });
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>({ key: 'potential', dir: -1 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [peopleTab, setPeopleTab] = useState<'mgr' | 'actors'>('actors');
  const [jKinds, setJKinds] = useState<Set<string>>(new Set());
  const [jSearch, setJSearch] = useState('');
  const [jSource, setJSource] = useState<'all' | 'kanban' | 'bitrix'>('all');
  const [view, setView] = useState<'work' | 'result'>('work');

  // Даты снимков внутри периода — для дельт «конец против начала»; линия — всегда 30 дней.
  const periodDates = useMemo(() => (data ? data.dates.filter(d => d >= (period === 'day' ? (data.dates[data.dates.length - 2] ?? d) : data.fromDate)) : []), [data, period]);
  const tree = useMemo(() => (data?.snapDate ? buildTree(data.org, data.mgr, data.snapDate, data.dates) : null), [data]);
  const mgrBranch = useMemo(() => {
    // Менеджер → корень (филиал) — для стека «куда ушёл пул».
    const map = new Map<string, string>();
    const walk = (n: TreeNode, root: string) => { if (n.kind === 'mgr') map.set(n.id.slice(2), root); n.children.forEach(c => walk(c, root)); };
    tree?.roots.forEach(r => walk(r, r.name));
    return map;
  }, [tree]);

  const sorted = (nodes: TreeNode[]) => {
    if (!sort) return nodes;
    return [...nodes].sort((a, b) => {
      const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
      return (typeof va === 'string' ? va.localeCompare(vb as string, 'ru') : (va as number) - (vb as number)) * sort.dir;
    });
  };
  const clickSort = (k: SortKey) => setSort(s => (!s || s.key !== k ? { key: k, dir: k === 'name' ? 1 : -1 } : s.dir === -1 ? { key: k, dir: 1 } : null));
  const expandTo = (depth: number | 'mgr') => {
    const ids = new Set<string>();
    const walk = (n: TreeNode) => { if (n.kind === 'org' && (depth === 'mgr' || n.depth < depth)) ids.add(n.id); n.children.forEach(walk); };
    tree?.roots.forEach(walk);
    setOpen(ids);
  };

  // KPI с дельтой к предыдущему снимку.
  const kpi = useMemo(() => {
    if (!tree || !data) return null;
    // База сравнения — первый снимок периода (для «день» — предыдущий снимок).
    const prevDate = periodDates.length > 1 ? periodDates[0] : null;
    const prev = prevDate ? data.mgr.filter(m => m.date === prevDate).reduce((s, m) => add(s, m), ZERO) : null;
    return { cur: tree.total.agg, prev, prevDate };
  }, [tree, data, periodDates]);
  const todayActions = data?.journal.filter(isAction).length ?? 0;
  const periodLabel = !data || period === 'day' ? fmtD(date) : `${fmtD(data.fromDate)}–${fmtD(date)}`;

  // Люди: клики канбана + задачи из Битрикса — «Действий»; остальное Битрикса — отдельно
  // (счётчики с сервера полные, журнал стадий/звонков может быть обрезан).
  const actors = useMemo(() => {
    type A = { actor: string; role: string | null; total: number; deals: number; reviews: number; leak: number; clients: Set<string>; bxStages: number; bxCalls: number; bxReached: number; bxTasks: number };
    const m = new Map<string, A>();
    const get = (actor: string, role: string | null) => {
      let a = m.get(actor);
      if (!a) { a = { actor, role, total: 0, deals: 0, reviews: 0, leak: 0, clients: new Set<string>(), bxStages: 0, bxCalls: 0, bxReached: 0, bxTasks: 0 }; m.set(actor, a); }
      if (!a.role && role) a.role = role;
      return a;
    };
    for (const j of data?.journal ?? []) {
      if (!isAction(j)) continue;
      const a = get(j.actor, j.actorRole);
      a.total++; if (sinkOf(j) === 'deal') a.deals++; if (j.type === 'reject_reviewed') a.reviews++; if (KIND_OF[j.type] === 'leak') a.leak++;
      if (j.clientKey) a.clients.add(j.clientKey);
    }
    for (const [name, c] of Object.entries(data?.bitrixCounts ?? {})) {
      if (c.stages + c.calls + c.submitted + c.closed === 0) continue;
      const a = get(name, null);
      a.bxStages = c.stages; a.bxCalls = c.calls; a.bxReached = c.reached; a.bxTasks = c.submitted + c.closed;
    }
    return [...m.values()].sort((a, b) => b.total - a.total || (b.bxStages + b.bxCalls + b.bxTasks) - (a.bxStages + a.bxCalls + a.bxTasks));
  }, [data]);
  // ИИ-оценка проработки звонков (владелец 23.10: «в рейтинге менеджеров не вижу оценок проработки повторных
  // сделок по ИИ-анализу»): средний балл по последним отчётам заказчиков за 90 дней (features/ai-analysis).
  // Только у кого право на ИИ-анализ: без него API отвечает 403 — колонок нет. Сопоставление — по имени
  // (и рейтинг, и main_manager отчётов берут имя из оргструктуры).
  const ai = useQuery<{ managers: ManagerSummary[] }>({
    queryKey: ['ai-analysis-summary', 90],
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async () => { const r = await fetch('/api/ai-analysis/summary?days=90'); if (!r.ok) throw new Error(String(r.status)); return r.json(); },
  });
  const aiByName = useMemo(() => new Map((ai.data?.managers ?? []).map(m => [m.manager.trim().toLowerCase(), m])), [ai.data]);
  const aiOf = (name: string | null | undefined) => (name ? aiByName.get(name.trim().toLowerCase()) : undefined);
  const mgrRating = useMemo(() => {
    if (!data?.snapDate) return [];
    const acts = new Map<string, { total: number; leak: number }>();
    for (const j of data.journal) { if (!j.managerId || !isAction(j)) continue; const a = acts.get(j.managerId) ?? { total: 0, leak: 0 }; a.total++; if (KIND_OF[j.type] === 'leak') a.leak++; acts.set(j.managerId, a); }
    return data.mgr.filter(m => m.date === data.snapDate && m.pool + m.inWork + m.funnel >= 20).map(m => {
      const a = acts.get(m.managerId) ?? { total: 0, leak: 0 };
      return { m, strict: pct1(m.inWork + m.funnel, m.total), per100: m.pool ? Math.round((a.total / m.pool) * 1000) / 10 : 0, acts: a.total, leakPct: a.total ? Math.round((a.leak / a.total) * 100) : 0 };
    }).sort((x, y) => y.strict - x.strict);
  }, [data]);

  // Куда ушёл пул — по филиалам.
  const sinks = useMemo(() => {
    const by = new Map<string, Record<string, number>>();
    for (const j of data?.journal ?? []) {
      const s = sinkOf(j); if (!s) continue;
      const br = (j.managerId && mgrBranch.get(j.managerId)) || 'Без филиала';
      const r = by.get(br) ?? {}; r[s] = (r[s] ?? 0) + 1; by.set(br, r);
    }
    return [...by.entries()].map(([br, r]) => ({ br, r, total: Object.values(r).reduce((s, n) => s + n, 0) })).sort((a, b) => b.total - a.total);
  }, [data, mgrBranch]);

  // Журнал по людям.
  const journalGroups = useMemo(() => {
    const q = jSearch.trim().toLowerCase();
    const rows = (data?.journal ?? []).filter(j => (!jKinds.size || jKinds.has(KIND_OF[j.type] ?? 'aux'))
      && (jSource === 'all' || j.source === jSource)
      && (!q || `${j.clientName ?? ''} ${j.clientKey ?? ''} ${j.actor}`.toLowerCase().includes(q)));
    const g = new Map<string, JournalRow[]>();
    for (const r of rows) { const l = g.get(r.actor) ?? []; l.push(r); g.set(r.actor, l); }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data, jKinds, jSearch, jSource]);
  const [openActors, setOpenActors] = useState<Set<string>>(new Set());

  const renderRows = (nodes: TreeNode[]): React.ReactNode => sorted(nodes).map(n => {
    const a = n.agg; const isOpen = open.has(n.id); const st = strict(a);
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
              {n.kind === 'org' && <span className="text-[11px] text-[var(--color-text-muted)]">· {a.managers}</span>}
              {a.tasksOverdue > 0 && <span className="rounded bg-[#f4cccc] px-1 text-[10.5px] font-bold text-[#990000]" title="Просрочено задач">{a.tasksOverdue}</span>}
              <button type="button" onClick={() => setDetail(d => (d === n.id ? null : n.id))} className="tap-target ml-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]" aria-label="Подробнее"><Info size={13} /></button>
            </div>
          </td>
          <td className={cell}>{rub.format(a.total)}</td>
          <td className={cell}>{rub.format(a.pool)}{a.poolHot > 0 && <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">срочно {a.poolHot}</span>}</td>
          <td className={cell}>{moneyShort(a.poolPotential)}</td>
          <td className={cell} title={`С задачей ${a.workedByTask} из ${a.workedByTask + a.poolHot} (окно открыто без сделки — ${a.poolHot}). Не в пуле вообще, включая сделки без задачи: ${soft(a)}%`}><Light v={st} /></td>
          <td className={cell}>{rub.format(a.inWork)}</td>
          <td className={cell}>{rub.format(a.funnel)}<span className="ml-1 text-[11px] text-[var(--color-text-muted)]">{moneyShort(a.funnelSum)}</span></td>
          <td className={cell}><div className="flex items-center justify-end gap-2"><Spark points={n.series} /><Delta points={n.series} window={periodDates.length} /></div></td>
        </tr>
        {detail === n.id && (
          <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <td colSpan={8} className="px-4 py-2 text-[12.5px] text-[var(--color-text-secondary)]">
              Отказы на проверке <b>{a.review}</b> · скрыто <b>{a.hidden}</b> · брак <b>{a.brak}</b> · с задачей <b>{a.workedByTask}</b> · не в пуле (включая сделки без задачи) <b>{soft(a)}%</b> ·
              дозвонились <b>{a.reached}</b> из {a.inWork} · задачи: открыто <b>{a.tasksOpen}</b>, просрочено <b>{a.tasksOverdue}</b>, ждут приёмки <b>{a.tasksControl}</b>,
              без задачи <b>{a.noTask}</b> · за день: действий <b>{a.actions}</b>, задач создано <b>{a.tasksCreated}</b>, принято <b>{a.tasksAccepted}</b>
            </td>
          </tr>
        )}
        {isOpen && renderRows(n.children)}
      </Fragment>
    );
  });

  const Kpi = ({ label, value, sub, d, better }: { label: string; value: string; sub?: string; d?: number | null; better?: 'up' | 'down' }) => (
    <div className="flex min-w-0 flex-col justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5">
      <div className="text-[11.5px] text-[var(--color-text-muted)]">{label}</div>
      <div className="text-[24px] font-bold leading-tight tabular-nums">{value}</div>
      <div className="text-[11.5px] text-[var(--color-text-muted)]">
        {d === undefined || d === null ? (sub ?? `срез ${data?.snapDate ? fmtD(data.snapDate) : '—'} 23:30`) : (
          <span style={{ color: d === 0 ? undefined : (d > 0) === (better !== 'down') ? '#38761d' : '#990000' }}>
            {d > 0 ? '▲' : d < 0 ? '▼' : '—'} {d !== 0 ? rub.format(Math.abs(d)) : ''} к {kpi?.prevDate ? fmtD(kpi.prevDate) : ''}{sub ? ` · ${sub}` : ''}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <Link href="/repeat-kanban" className="inline-flex min-h-11 items-center gap-1 text-sm text-[var(--color-accent)] hover:underline"><ArrowLeft size={14} /> Канбан</Link>
            <h1 className="text-xl font-semibold">Аналитика канбана повторных</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Снимки пула — каждый день в 23:30 МСК, журнал — в реальном времени. История копится с 20.10.2026.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
          {/* Период (владелец 21.10): состояние пула — последний снимок, действия — сумма за период,
              дельты — конец против начала. */}
          <div className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1" role="tablist" aria-label="Период">
            {([['day', 'День'], ['week', 'Неделя'], ['month', '30 дней']] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={period === k} onClick={() => setPeriod(k)}
                className={`min-h-9 rounded-md px-3 text-sm ${period === k ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{l}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            {period === 'day' ? 'День' : 'По'}
            <input type="date" value={date} max={todayMsk()} onChange={e => e.target.value && setDate(e.target.value)}
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base sm:text-sm" />
          </label>
          </div>
        </header>
        {/* Вкладки: две — переносом (flex-wrap), без горизонтальной ленты (CLAUDE.md, правило 12). */}
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Раздел аналитики">
          {([['work', 'Проработка'], ['result', 'Результат: задача → отгрузка']] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
              className={`min-h-11 rounded-lg border px-4 text-sm font-medium ${view === k ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>{l}</button>
          ))}
        </div>
        {view === 'result' && <RepeatResultsSection date={date} period={period} />}
        {view === 'work' && (<>
        {error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{(error as Error).message}</div>}
        {isLoading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Загружаю…</div>}

        {/* KPI — 5 секунд. */}
        {kpi && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {/* Δ — только если у прошлого снимка есть мера «с задачей» (появилась 21.10, миграция 235):
                иначе «▲11 к 20.10» — рост от несуществующего нуля. */}
            <Kpi label="Проработано" value={pctRu(strict(kpi.cur))} d={kpi.prev && kpi.prev.workedByTask > 0 ? Math.round((strict(kpi.cur) - strict(kpi.prev)) * 10) / 10 : null} sub={`с задачей ${kpi.cur.workedByTask} из ${kpi.cur.workedByTask + kpi.cur.poolHot}`} />
            <Kpi label="В пуле, заказчиков" value={rub.format(kpi.cur.pool)} d={kpi.prev ? kpi.cur.pool - kpi.prev.pool : null} better="down" sub={`срочно ${kpi.cur.poolHot}`} />
            <Kpi label="Потенциал пула" value={moneyShort(kpi.cur.poolPotential)} d={null} sub="уменьшается, когда пул очищают" />
            <Kpi label="В воронке" value={`${rub.format(kpi.cur.funnel)} сделок`} d={kpi.prev ? kpi.cur.funnel - kpi.prev.funnel : null} sub={moneyShort(kpi.cur.funnelSum)} />
            <Kpi label={period !== 'day' ? `Действий за ${period === 'week' ? 'неделю' : '30 дней'}` : date === todayMsk() ? 'Действий сегодня' : `Действий ${fmtD(date)}`} value={rub.format(todayActions)} sub={`сделок ${actors.reduce((s, a) => s + a.deals, 0)} · отказов ${actors.reduce((s, a) => s + a.reviews, 0)} · утечка ${actors.reduce((s, a) => s + a.leak, 0)}`} />
          </div>
        )}

        {/* Иерархическая таблица. */}
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">Проработанность по подразделениям{data?.snapDate ? ` · снимок ${fmtD(data.snapDate)}` : ''}</h2>
            <div className="flex flex-wrap gap-2 text-sm">
              <button type="button" onClick={() => setOpen(new Set())} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">Только филиалы</button>
              <button type="button" onClick={() => expandTo(3)} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">До отделов</button>
              <button type="button" onClick={() => expandTo('mgr')} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">До менеджеров</button>
            </div>
          </div>
          {!tree ? <div className="text-sm text-[var(--color-text-muted)]">Снимков ещё нет — первый появится в 23:30 МСК.</div> : (
            <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
              <table className="w-full min-w-[980px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    {COLS.map((c, i) => (
                      <th key={c.key} title={c.hint} className={`${head} ${i === 0 ? 'sticky left-0 z-10 bg-[var(--color-bg-surface)] text-left' : ''} cursor-pointer hover:text-[var(--color-text)]`} onClick={() => clickSort(c.key)}>
                        {c.label}{sort?.key === c.key ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}
                      </th>
                    ))}
                  </tr>
                  {/* Итого — сверху, всегда видно (ТЗ Fable). */}
                  <tr className="border-b-2 border-[var(--color-border-strong)] bg-[var(--color-bg)] font-bold">
                    <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-1.5 text-left">Итого <span className="text-[11px] font-normal text-[var(--color-text-muted)]">· {tree.total.agg.managers} менеджеров</span></td>
                    <td className={cell}>{rub.format(tree.total.agg.total)}</td>
                    <td className={cell}>{rub.format(tree.total.agg.pool)}<span className="ml-1 text-[11px] font-normal text-[var(--color-text-muted)]">срочно {tree.total.agg.poolHot}</span></td>
                    <td className={cell}>{moneyShort(tree.total.agg.poolPotential)}</td>
                    <td className={cell}><Light v={strict(tree.total.agg)} /></td>
                    <td className={cell}>{rub.format(tree.total.agg.inWork)}</td>
                    <td className={cell}>{rub.format(tree.total.agg.funnel)}<span className="ml-1 text-[11px] font-normal text-[var(--color-text-muted)]">{moneyShort(tree.total.agg.funnelSum)}</span></td>
                    <td className={cell}><div className="flex items-center justify-end gap-2"><Spark points={tree.total.series} /><Delta points={tree.total.series} window={periodDates.length} /></div></td>
                  </tr>
                </thead>
                <tbody>{renderRows(tree.roots)}</tbody>
              </table>
            </div>
          )}
        </section>

        {/* Люди. */}
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Люди · {periodLabel}</h2>
            {(['actors', 'mgr'] as const).map(t => (
              <button key={t} type="button" onClick={() => setPeopleTab(t)}
                className={`min-h-11 rounded-lg border px-3 text-sm ${peopleTab === t ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
                {t === 'actors' ? 'Кто работал: канбан и Битрикс' : 'Менеджеры — рейтинг'}
              </button>
            ))}
          </div>
          <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            {peopleTab === 'actors' ? (
              actors.length === 0 ? <div className="p-4 text-sm text-[var(--color-text-muted)]">За период действий не было.</div> : (
                <table className="w-full min-w-[960px] text-sm">
                  <thead><tr className="border-b border-[var(--color-border)]">
                    <th className={`${head} text-left`}>Кто</th><th className={head}>Действий</th><th className={head}>Заказчиков</th>
                    <th className={head} title="Клики в канбане и задачи, поставленные прямо в Битриксе">Сделок + задач</th><th className={head}>Разобрано отказов</th>
                    <th className={head} title="Доля «скрыто + сразу в брак» от всех действий: высокая — пул чистят не работой">Утечка</th>
                    <th className={head} title="Битрикс: смены стадий повторных сделок (кроме сделанных канбаном)">Стадий</th>
                    <th className={head} title="Битрикс: звонки по сделкам задач проекта после постановки — всего / дозвон > 20 с">Звонков / дозвон</th>
                    <th className={head} title="Битрикс: задачи сданы на проверку и завершены/приняты">Сдано / принято</th>
                  </tr></thead>
                  <tbody>{actors.map((a, i) => (
                    <tr key={a.actor} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-2 py-1.5"><span className="mr-1">{i < 3 ? ['🥇', '🥈', '🥉'][i] : ''}</span><b>{a.actor}</b>{a.role && <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">{a.role}</span>}</td>
                      <td className={`${cell} font-bold`}>{a.total}</td><td className={cell}>{a.clients.size}</td><td className={cell}>{a.deals}</td><td className={cell}>{a.reviews}</td>
                      <td className={cell} style={a.total && a.leak / a.total > 0.25 ? { color: '#990000', fontWeight: 700 } : { color: 'var(--color-text-muted)' }}>{a.total ? `${Math.round((a.leak / a.total) * 100)}%` : '—'}</td>
                      <td className={cell}>{a.bxStages || '—'}</td>
                      <td className={cell}>{a.bxCalls ? <>{a.bxCalls}<span className="ml-1 text-[11px] text-[var(--color-text-muted)]">/ {a.bxReached}</span></> : '—'}</td>
                      <td className={cell}>{a.bxTasks || '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )
            ) : (
              <table className="w-full min-w-[820px] text-sm">
                <thead><tr className="border-b border-[var(--color-border)]">
                  <th className={`${head} text-left`}>Менеджер</th><th className={head}>Проработано</th><th className={head}>В пуле</th>
                  <th className={head} title="Действий в канбане по его заказчикам на 100 заказчиков в пуле — интенсивность, без эффекта размера отдела">На 100 в пуле</th>
                  <th className={head}>Задач принято / просрочено</th><th className={head} title="Доля «скрыто + брак» среди действий по его заказчикам">Утечка</th>
                  {ai.isSuccess && <>
                    <th className={head} title="ИИ-анализ звонков: средний балл по 8 критериям (последний отчёт каждого заказчика за 90 дней) / заказчиков с отчётом">ИИ-оценка</th>
                    <th className={head} title="ИИ-анализ: найденные нарушения за 90 дней">ИИ: нарушения</th>
                  </>}
                </tr></thead>
                <tbody>{mgrRating.map((r, i) => (
                  <tr key={r.m.managerId} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-2 py-1.5"><span className="mr-1">{i < 3 ? ['🥇', '🥈', '🥉'][i] : ''}</span><b>{r.m.name}</b><span className="ml-1 text-[11px] text-[var(--color-text-muted)]">{r.m.deptName}</span></td>
                    <td className={cell}><Light v={r.strict} /></td><td className={cell}>{rub.format(r.m.pool)}</td><td className={cell}>{r.per100}</td>
                    <td className={cell}>{r.m.tasksAccepted} / <span style={r.m.tasksOverdue ? { color: '#990000', fontWeight: 700 } : undefined}>{r.m.tasksOverdue}</span></td>
                    <td className={cell} style={r.leakPct > 25 ? { color: '#990000', fontWeight: 700 } : { color: 'var(--color-text-muted)' }}>{r.acts ? `${r.leakPct}%` : '—'}</td>
                    {ai.isSuccess && (() => {
                      const x = aiOf(r.m.name);
                      const v = x?.avgScore ?? null;
                      const few = !x || x.analyses < 3;
                      const viol = x ? Object.entries(x.violations) as [keyof typeof VIOLATION_LABELS, number][] : [];
                      return <>
                        <td className={cell} style={v === null || few ? { color: 'var(--color-text-muted)' } : v < 0.4 ? { color: '#990000', fontWeight: 700 } : v < 0.7 ? { color: '#b45f06' } : { color: '#38761d' }}
                          title={few && x ? 'Меньше 3 заказчиков с отчётом — мало данных' : undefined}>
                          {v === null ? '—' : `${Math.round(v * 100)}%`}{x && <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">/ {x.analyses}</span>}
                        </td>
                        <td className={cell} title={viol.map(([k, n]) => `${VIOLATION_LABELS[k]}: ${n}`).join('\n') || undefined}
                          style={viol.length ? { color: '#990000', fontWeight: 700 } : { color: 'var(--color-text-muted)' }}>
                          {viol.length ? viol.reduce((a, [, n]) => a + n, 0) : '—'}
                        </td>
                      </>;
                    })()}
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
          {peopleTab === 'mgr' && <div className="text-[11.5px] text-[var(--color-text-muted)]">В рейтинге — менеджеры с 20+ заказчиками в работе и пуле, чтобы три клиента не давали 100%.</div>}
          {peopleTab === 'mgr' && ai.isSuccess && (
            <div className="text-[11.5px] text-[var(--color-text-muted)]">
              «ИИ-оценка» — средний балл проработки звонков по ИИ-анализу (последний отчёт каждого заказчика за 90 дней) / заказчиков с отчётом; серым — меньше 3 отчётов.
              {' '}<Link href="/ai-analysis/managers" className="text-[var(--color-accent)] hover:underline">Подробно по 8 критериям и нарушениям →</Link>
            </div>
          )}
        </section>

        {/* Куда ушёл пул. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Куда ушёл пул · {periodLabel}</h2>
          <div className="flex flex-wrap gap-3 text-[12px]">{SINKS.map(s => <span key={s.key} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}</div>
          {sinks.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">За период из пула никого не брали.</div> : (
            <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
              {sinks.map(s => (
                <div key={s.br} className="grid grid-cols-[160px_1fr_40px] items-center gap-2 text-sm">
                  <span className="truncate" title={s.br}>{s.br}</span>
                  <div className="flex h-4 overflow-hidden rounded">
                    {SINKS.map(k => s.r[k.key] ? <div key={k.key} title={`${k.label}: ${s.r[k.key]}`} style={{ width: `${(s.r[k.key] / s.total) * 100}%`, background: k.color }} /> : null)}
                  </div>
                  <span className="text-right tabular-nums">{s.total}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Динамика — копится. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Динамика проработанности по филиалам</h2>
          {(data?.dates.length ?? 0) < 2 ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-secondary)]">
              Накапливаем историю: {data?.dates.length ?? 0} из 30 дней.
              <div className="mt-2 h-2 overflow-hidden rounded bg-[var(--color-bg-hover)]"><div className="h-full bg-[var(--color-accent)]" style={{ width: `${((data?.dates.length ?? 0) / 30) * 100}%` }} /></div>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
              {(tree?.roots ?? []).slice(0, 8).map(r => (
                <div key={r.id} className="grid grid-cols-[160px_1fr_60px] items-center gap-2 py-1 text-sm">
                  <span className="truncate">{r.name}</span>
                  <svg viewBox="0 0 300 30" className="h-8 w-full" preserveAspectRatio="none" aria-hidden>
                    <path d={r.series.map((p, i) => `${i ? 'L' : 'M'}${(i * 300 / Math.max(1, r.series.length - 1)).toFixed(1)},${(30 - (p / 100) * 30).toFixed(1)}`).join(' ')} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
                  </svg>
                  <span className="text-right"><Delta points={r.series} window={periodDates.length} /></span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Журнал. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">Журнал · {periodLabel}</h2>
          <p className="text-[12px] text-[var(--color-text-muted)]">
            Клики в канбане и события Битрикса: задачи проекта, поставленные не из канбана, сдача и приёмка задач, смены стадий повторных сделок, звонки по сделкам задач.
            «Сдал на проверку» — по последнему изменению задачи (истории статусов в копии нет).
            {data?.bitrixTruncated && ' Стадий и звонков слишком много — в журнале последние 3000 каждого вида; счётчики в «Людях» — полные.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map(k => (
              <button key={k} type="button" onClick={() => setJKinds(s => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; })}
                className={`min-h-11 rounded-lg border px-3 text-sm ${jKinds.has(k) ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
                {KIND_LABEL[k]}
              </button>
            ))}
            {/* Источник: клики канбана / события копии Битрикса. */}
            <div className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1" role="tablist" aria-label="Источник">
              {([['all', 'Все'], ['kanban', 'Канбан'], ['bitrix', 'Битрикс']] as const).map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={jSource === k} onClick={() => setJSource(k)}
                  className={`min-h-9 rounded-md px-3 text-sm ${jSource === k ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{l}</button>
              ))}
            </div>
            <input value={jSearch} onChange={e => setJSearch(e.target.value)} placeholder="Поиск по заказчику или человеку"
              className="min-h-11 min-w-[200px] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base sm:max-w-xs sm:text-sm" />
          </div>
          {journalGroups.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">Пусто.</div> : (
            <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
              {journalGroups.map(([actor, rows]) => {
                const isOpen = openActors.has(actor);
                const cnt = rows.reduce((m, r) => { m[r.type] = (m[r.type] ?? 0) + 1; return m; }, {} as Record<string, number>);
                return (
                  <div key={actor}>
                    <button type="button" onClick={() => setOpenActors(s => { const x = new Set(s); if (x.has(actor)) x.delete(actor); else x.add(actor); return x; })}
                      className="flex min-h-11 w-full flex-wrap items-center gap-x-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <b>{actor}</b><span className="text-[var(--color-text-muted)]">— {rows.length} действий:</span>
                      <span className="text-[var(--color-text-secondary)]">{Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${EVENT_LABEL[t] ?? t} ${n}`).join(', ')}</span>
                    </button>
                    {isOpen && rows.map((j, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--color-border)] px-3 py-1.5 pl-9 text-[12.5px]">
                        <span className="w-12 shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtTime(j.ts)}</span>
                        <span style={{ color: KIND_OF[j.type] === 'leak' ? '#b45f06' : KIND_OF[j.type] === 'undo' ? 'var(--color-text-muted)' : undefined }}>
                          {j.source === 'bitrix' && <span className="mr-1 rounded border border-[var(--color-border)] px-1 text-[10.5px] text-[var(--color-text-muted)]">Битрикс</span>}
                          {labelOf(j)}{j.type === 'reject_reviewed' && j.payload.decision ? ` · ${j.payload.decision === 'brak' ? 'брак' : j.payload.decision === 'no_answer' ? 'недозвон' : 'вернуть'}` : ''}
                        </span>
                        <span className="font-medium">{j.clientName ?? j.clientKey ?? ''}</span>
                        {j.dealId && <a href={dealUrl(j.dealId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"><ExternalLink size={11} />#{j.dealId}</a>}
                        {j.taskId && <a href={taskUrl(j.taskId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"><ExternalLink size={11} />задача</a>}
                        {typeof j.payload.comment === 'string' && j.payload.comment && <span className="min-w-0 basis-full truncate text-[var(--color-text-secondary)] sm:basis-auto">«{j.payload.comment}»</span>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        </>)}
      </div>
    </div>
  );
}
