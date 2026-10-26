'use client';
// «Аналитика канбана повторных» v3 (владелец 26.10: «разделить на табы, чтобы полотна не скроллить; быстро видеть
// два характера — кто сколько действий выполнил и какой результат это принёс; по умолчанию „за всё время“; в разрезе
// компании, филиалов, департаментов и отделов; пул, зависло, скорость приёмки и разбора, конверсия „взят из пула →
// продажа → отгрузка“ в штуках и ₽; приведи к охуенному виду»; проект экрана — Fable).
// Табы: Обзор (карта «активность × результат» + светофор) · Активность · Результат · Пул и скорость · Журнал.
// Данные: /analytics (снимки + журнал кликов и событий Битрикса), /analytics/results (задача → продажа → отгрузка,
// engine/results.ts), /analytics/speed (ждут приёмки, зависло, разбор, очередь — engine/speed.ts). Дерево — analyticsTree.ts.
import Link from 'next/link';
import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, Info } from 'lucide-react';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { taskUrl } from '../engine/config';
import type { KanbanAnalytics, MgrDay, JournalRow } from '../engine/analytics';
import type { KanbanResults } from '../engine/results';
import type { KanbanSpeed } from '../engine/speed';
import type { AiStats } from '../engine/aiStats';
import type { ManagerSummary } from '@/features/ai-analysis/engine/summary';
import { VIOLATION_LABELS } from '@/features/ai-analysis/engine/parse';
import { buildTree, crShipped, crSold, median, nodesAtLevel, pct, per100, worked, ZERO, type MAgg, type TreeNode } from './analyticsTree';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const moneyShort = (n: number) => (n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1).replace('.', ',')} млрд ₽` : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} млн ₽` : n >= 1000 ? `${Math.round(n / 1000)} тыс. ₽` : `${rub.format(n)} ₽`);
const todayMsk = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const fmtTime = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const fmtD = (ymd: string) => ymd.split('-').reverse().slice(0, 2).join('.');
const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;
const pctRu = (v: number | null) => (v === null ? '—' : `${String(v).replace('.', ',')}%`);
const hours = (h: number | null) => (h === null ? '—' : h < 48 ? `${h} ч` : `${Math.round(h / 24)} дн.`);
const DAY_MS = 86_400_000;

type Period = 'all' | 'day' | 'week' | 'month';
const PERIODS: [Period, string][] = [['all', 'Всё время'], ['day', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц']];
type Tab = 'overview' | 'activity' | 'results' | 'pool' | 'ai' | 'journal';
const TABS: [Tab, string][] = [['overview', 'Обзор'], ['activity', 'Активность'], ['results', 'Результат'], ['pool', 'Пул и скорость'], ['ai', 'ИИ-разборы'], ['journal', 'Журнал']];

// ── Журнал: виды действий ─────────────────────────────────────────────────────
const EVENT_LABEL: Record<string, string> = {
  deal_task_created: 'Сделка + задача', deal_returned_from_reject: 'Сделка из отказа + задача', task_created: 'Задача в сделку',
  task_comment_posted: 'Комментарий в чат', reject_reviewed: 'Разобран отказ', rejected_direct: 'Сразу в брак',
  hidden: 'Скрыт из пула', unhidden: 'Возвращён в пул', reject_cleared: 'Снят брак',
  task_accepted: 'Задача принята', task_accepted_deal_closed: 'Задача принята, сделка в брак', task_returned: 'Задача на доработку',
  task_accepted_postponed: 'Задача принята, отложен', task_replaced: 'Откат и новая задача', hide_requested: 'Предложил скрыть',
  hide_request_accepted: 'Скрыт по просьбе', hide_request_declined: 'Отклонил «скрыть»', manager_reassigned: 'Сменил менеджера',
  tags_set: 'Теги', customers_merged: 'Склеил заказчиков',
  bx_task_created: 'Задача в Битриксе', bx_task_submitted: 'Сдал на проверку', bx_task_closed: 'Задача завершена',
  bx_stage: 'Стадия сделки', bx_call_reached: 'Дозвон', bx_call_attempt: 'Попытка звонка',
};
const KIND_OF: Record<string, 'work' | 'leak' | 'undo' | 'aux' | 'bitrix'> = {
  deal_task_created: 'work', deal_returned_from_reject: 'work', task_created: 'work', reject_reviewed: 'work', task_replaced: 'work',
  rejected_direct: 'leak', hidden: 'leak', unhidden: 'undo', reject_cleared: 'undo', task_comment_posted: 'aux',
  task_accepted: 'work', task_returned: 'work', task_accepted_postponed: 'work', task_accepted_deal_closed: 'leak', tags_set: 'aux',
  hide_request_accepted: 'leak', hide_request_declined: 'work', hide_requested: 'aux', manager_reassigned: 'work', customers_merged: 'aux',
  bx_task_created: 'work', bx_task_submitted: 'bitrix', bx_task_closed: 'bitrix', bx_stage: 'bitrix', bx_call_reached: 'bitrix', bx_call_attempt: 'bitrix',
};
const KIND_LABEL = { work: 'Работа', leak: 'Утечка (скрыто, брак)', undo: 'Откаты', bitrix: 'Битрикс: стадии, звонки, сдача задач' } as const;
/** Действие человека: клики канбана без служебных (комментарий, теги) и задачи, поставленные прямо в Битриксе. */
const isAction = (j: JournalRow) => !['task_comment_posted', 'tags_set', 'hide_requested'].includes(j.type) && (j.source === 'kanban' || j.type === 'bx_task_created');
const isAccept = (t: string) => t === 'task_accepted' || t === 'task_accepted_deal_closed' || t === 'task_accepted_postponed';
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
function sinkOf(j: JournalRow): 'deal' | 'return' | 'noanswer' | 'hidden' | 'brak' | null {
  if (['deal_task_created', 'deal_returned_from_reject', 'task_created', 'bx_task_created', 'task_replaced'].includes(j.type)) return 'deal';
  if (j.type === 'hidden' || j.type === 'hide_request_accepted' || j.type === 'task_accepted_postponed') return 'hidden';
  if (j.type === 'rejected_direct' || j.type === 'task_accepted_deal_closed') return 'brak';
  if (j.type === 'reject_reviewed') return j.payload.decision === 'brak' ? 'brak' : j.payload.decision === 'no_answer' ? 'noanswer' : j.payload.decision === 'postpone' ? 'hidden' : 'return';
  return null;
}
const SINKS = [
  { key: 'deal', label: 'Сделка + задача', color: '#38761d' }, { key: 'return', label: 'Вернули менеджеру', color: '#6aa84f' },
  { key: 'noanswer', label: 'Недозвон', color: '#b7b7b7' }, { key: 'hidden', label: 'Скрыт / отложен', color: '#e69138' }, { key: 'brak', label: 'Брак', color: '#cc0000' },
] as const;

// ── Мелочи интерфейса ─────────────────────────────────────────────────────────
const head = 'whitespace-nowrap px-2 py-2 text-right text-[11.5px] font-medium text-[var(--color-text-muted)] select-none';
const cell = 'whitespace-nowrap px-2 py-1.5 text-right tabular-nums';
const LIGHT = { good: { bg: '#d9ead3', fg: '#38761d' }, mid: { bg: '#fff2cc', fg: '#7f6000' }, bad: { bg: '#f4cccc', fg: '#990000' } } as const;
function Light({ v, lo = 30, hi = 60 }: { v: number | null; lo?: number; hi?: number }) {
  if (v === null) return <span className="text-[var(--color-text-muted)]">—</span>;
  const st = v < lo ? LIGHT.bad : v < hi ? LIGHT.mid : LIGHT.good;
  return <span className="inline-block min-w-[56px] rounded px-1.5 py-0.5 text-right font-bold tabular-nums" style={{ background: st.bg, color: st.fg }}>{pctRu(v)}</span>;
}
function Kpi({ label, value, sub, hint }: { label: string; value: string; sub?: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5" title={hint}>
      <div className="truncate text-[11.5px] text-[var(--color-text-muted)]">{label}</div>
      <div className="truncate text-[22px] font-bold leading-tight tabular-nums sm:text-[24px]">{value}</div>
      {sub && <div className="truncate text-[11.5px] text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}
const KpiRow = ({ children }: { children: React.ReactNode }) => <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">{children}</div>;
const Note = ({ children }: { children: React.ReactNode }) => <p className="text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">{children}</p>;
const Btn = ({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button type="button" onClick={onClick} aria-pressed={on}
    className={`min-h-11 rounded-lg border px-3 text-sm ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>{children}</button>
);

// ── Иерархическая таблица (общая для табов) ──────────────────────────────────
interface Col { key: string; label: string; hint?: string; sort: (a: MAgg) => number | null; render: (a: MAgg) => React.ReactNode }
function TreeTable({ roots, total, cols, defaultSort, minW }: { roots: TreeNode[]; total: TreeNode; cols: Col[]; defaultSort: string; minW: number }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: defaultSort, dir: -1 });
  const sortOf = (n: TreeNode) => (sort.key === 'name' ? n.name : cols.find(c => c.key === sort.key)?.sort(n.agg) ?? -Infinity);
  const sorted = (nodes: TreeNode[]) => [...nodes].sort((a, b) => {
    const va = sortOf(a), vb = sortOf(b);
    return (typeof va === 'string' ? va.localeCompare(vb as string, 'ru') : ((va ?? -Infinity) as number) - ((vb ?? -Infinity) as number)) * sort.dir;
  });
  const clickSort = (k: string) => setSort(s => (s.key !== k ? { key: k, dir: k === 'name' ? 1 : -1 } : { key: k, dir: s.dir === -1 ? 1 : -1 }));
  const expandTo = (depth: number | 'mgr') => {
    const ids = new Set<string>();
    const walk = (n: TreeNode) => { if (n.kind === 'org' && (depth === 'mgr' || n.depth < depth)) ids.add(n.id); n.children.forEach(walk); };
    roots.forEach(walk);
    setOpen(ids);
  };
  const rows = (nodes: TreeNode[]): React.ReactNode => sorted(nodes).map(n => {
    const isOpen = open.has(n.id);
    return (
      <Fragment key={n.id}>
        <tr className={`border-b border-[var(--color-border)] ${n.depth === 0 ? 'bg-[var(--color-bg)]' : ''} hover:bg-[var(--color-bg-hover)]`}>
          <td className="sticky left-0 z-10 max-w-[220px] bg-inherit px-2 py-1.5 text-left sm:max-w-none" style={{ paddingLeft: 8 + n.depth * 16 }}>
            <div className="flex min-w-0 items-center gap-1">
              {n.kind === 'org' ? (
                <button type="button" onClick={() => setOpen(s => { const x = new Set(s); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; })}
                  className="tap-target inline-flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)]" aria-label={isOpen ? 'Свернуть' : 'Раскрыть'}>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : <span className="inline-block w-5 shrink-0" />}
              <span className={`truncate ${n.kind === 'org' ? (n.depth === 0 ? 'font-bold' : 'font-semibold') : ''}`} title={n.name}>{n.name}</span>
              {n.kind === 'org' && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">· {n.agg.managers}</span>}
            </div>
          </td>
          {cols.map(c => <td key={c.key} className={cell}>{c.render(n.agg)}</td>)}
        </tr>
        {isOpen && rows(n.children)}
      </Fragment>
    );
  });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-2 text-sm">
        <Btn onClick={() => setOpen(new Set())}>Филиалы</Btn>
        <Btn onClick={() => expandTo(2)}>До отделов</Btn>
        <Btn onClick={() => expandTo('mgr')}>До менеджеров</Btn>
      </div>
      <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <table className="w-full text-sm" style={{ minWidth: minW }}>
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className={`${head} sticky left-0 z-10 cursor-pointer bg-[var(--color-bg-surface)] text-left hover:text-[var(--color-text)]`} onClick={() => clickSort('name')}>
                Подразделение{sort.key === 'name' ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}
              </th>
              {cols.map(c => (
                <th key={c.key} title={c.hint} className={`${head} cursor-pointer hover:text-[var(--color-text)]`} onClick={() => clickSort(c.key)}>
                  {c.label}{c.hint && <Info size={10} className="ml-0.5 inline opacity-50" />}{sort.key === c.key ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}
                </th>
              ))}
            </tr>
            <tr className="border-b-2 border-[var(--color-border-strong)] bg-[var(--color-bg)] font-bold">
              <td className="sticky left-0 z-10 bg-[var(--color-bg)] px-2 py-1.5 text-left">Итого <span className="text-[11px] font-normal text-[var(--color-text-muted)]">· {total.agg.managers}</span></td>
              {cols.map(c => <td key={c.key} className={cell}>{c.render(total.agg)}</td>)}
            </tr>
          </thead>
          <tbody>{rows(roots)}</tbody>
        </table>
      </div>
    </div>
  );
}

// ── Карта «Активность × Результат» ────────────────────────────────────────────
interface MapPoint { id: string; label: string; short: string; x: number; y: number; size: number; agg: MAgg }
function ActivityResultMap({ points }: { points: MapPoint[] }) {
  const [hover, setHover] = useState<string | null>(null);
  // Рисуем в реальных пикселях контейнера (владелец 26.10: на широком экране viewBox растягивал шрифты и круги
  // в разы — «распидорасило»): ширина — по контейнеру, высота фиксированная, подписи всегда 11–12 px.
  // Callback-ref: блок появляется не сразу (данные, «мало точек»), эффект с [] его не видел — ширина застревала на 640.
  const ro = useRef<ResizeObserver | null>(null);
  const [W, setW] = useState(0);
  const box = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(Math.round(el.clientWidth));
    ro.current = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.current.observe(el);
  }, []);
  if (points.length < 2) return <Note>Для карты нужно хотя бы два подразделения с пулом и задачами за период.</Note>;
  const H = 400, P = 44, PT = 30;
  const maxX = Math.max(...points.map(p => p.x)) * 1.1 || 1, maxY = Math.max(...points.map(p => p.y)) * 1.1 || 1;
  const sx = (x: number) => P + (x / maxX) * (W - P * 2), sy = (y: number) => H - P - (y / maxY) * (H - P - PT);
  const mx = median(points.map(p => p.x)) ?? 0, my = median(points.map(p => p.y)) ?? 0;
  const maxSize = Math.max(...points.map(p => p.size)) || 1;
  const cur = points.find(p => p.id === hover);
  return (
    <div ref={box} className="relative w-full min-w-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]" style={{ height: H }}>
      {W >= 320 && <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Карта активность и результат по подразделениям">
        {/* Квадранты по медианам. */}
        <rect x={sx(mx)} y={PT} width={W - P - sx(mx)} height={sy(my) - PT} fill="#d9ead3" opacity={0.45} />
        <rect x={P} y={sy(my)} width={sx(mx) - P} height={H - P - sy(my)} fill="#f4cccc" opacity={0.45} />
        <line x1={sx(mx)} x2={sx(mx)} y1={PT} y2={H - P} stroke="var(--color-border-strong)" strokeDasharray="4 4" />
        <line x1={P} x2={W - P} y1={sy(my)} y2={sy(my)} stroke="var(--color-border-strong)" strokeDasharray="4 4" />
        {/* Названия зон — над и под полем, чтобы не наезжали на точки. */}
        <text x={W - P} y={PT - 10} textAnchor="end" fontSize="11.5" fill="#38761d" fontWeight="700">↗ Активно и эффективно</text>
        <text x={P} y={PT - 10} fontSize="11.5" fill="#7f6000">↖ Результат без системы</text>
        <text x={W - P} y={H - P + 26} textAnchor="end" fontSize="11.5" fill="#7f6000">Активно, но без результата ↘</text>
        <text x={P} y={H - P + 26} fontSize="11.5" fill="#990000" fontWeight="700">↙ Не работают</text>
        <text x={W / 2} y={H - P + 14} textAnchor="middle" fontSize="11" fill="var(--color-text-muted)">действий на 100 в пуле →</text>
        <text x={12} y={H / 2} textAnchor="middle" fontSize="11" fill="var(--color-text-muted)" transform={`rotate(-90 12 ${H / 2})`}>CR Взят → Продажа, % →</text>
        {points.map(p => (
          <g key={p.id} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} onClick={() => setHover(h => (h === p.id ? null : p.id))} className="cursor-pointer">
            <circle cx={sx(p.x)} cy={sy(p.y)} r={6 + 12 * Math.sqrt(p.size / maxSize)} fill="var(--color-accent)" fillOpacity={hover === p.id ? 0.85 : 0.45} stroke="var(--color-accent)" />
            <text x={sx(p.x)} y={sy(p.y) - 9 - 12 * Math.sqrt(p.size / maxSize)} textAnchor="middle" fontSize="11" fill="var(--color-text)">{p.short.length > 20 ? `${p.short.slice(0, 19)}…` : p.short}</text>
          </g>
        ))}
      </svg>}
      {cur && (
        <div className="absolute left-2 right-2 top-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[12.5px] shadow sm:left-auto sm:w-72">
          <div className="font-semibold">{cur.label}</div>
          <div>Действий {rub.format(cur.agg.actions)} · в пуле {rub.format(cur.agg.pool)} · <b>{cur.x}</b> на 100</div>
          <div>Задач {rub.format(cur.agg.base)} · продано {cur.agg.soldN} ({moneyShort(cur.agg.soldSum)}) · <b>{pctRu(cur.y)}</b></div>
          <div>Отгружено {cur.agg.shippedN} · {moneyShort(cur.agg.shippedSum)}</div>
        </div>
      )}
    </div>
  );
}

/** Терцили внутри уровня: верхняя треть — зелёный, нижняя — красный (относительно соседей, не абсолютный порог). */
function tercile(values: (number | null)[]): (v: number | null) => keyof typeof LIGHT | null {
  const s = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (s.length < 3) return () => null;
  const lo = s[Math.floor(s.length / 3)], hi = s[Math.floor((2 * s.length) / 3)];
  // Нулей обычно много (не работают вовсе) — нижняя граница включительно, иначе «0» окажется жёлтым.
  if (hi === lo) return v => (v === null ? null : v > hi ? 'good' : v < lo || v === 0 ? 'bad' : 'mid');
  return v => (v === null ? null : v >= hi ? 'good' : v <= lo ? 'bad' : 'mid');
}

// ── Страница ──────────────────────────────────────────────────────────────────
export function RepeatKanbanAnalyticsPage() {
  const [tab, setTab] = useUrlState('tab', stringParam('overview'));
  const [period, setPeriod] = useUrlState('period', stringParam('all'));
  const p = (PERIODS.some(([k]) => k === period) ? period : 'all') as Period;
  const date = todayMsk();
  const get = async <T,>(url: string): Promise<T> => { const r = await fetch(url); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'Ошибка'); return j; };
  const an = useQuery<KanbanAnalytics>({ queryKey: ['rk-analytics', p], queryFn: () => get(`/api/repeat-kanban/analytics?date=${date}&period=${p}`) });
  const res = useQuery<KanbanResults>({ queryKey: ['rk-results', p], queryFn: () => get(`/api/repeat-kanban/analytics/results?date=${date}&period=${p}`) });
  const sp = useQuery<KanbanSpeed>({ queryKey: ['rk-speed', p], queryFn: () => get(`/api/repeat-kanban/analytics/speed?date=${date}&period=${p}`) });
  const ais = useQuery<AiStats>({ queryKey: ['rk-ai', p], queryFn: () => get(`/api/repeat-kanban/analytics/ai?date=${date}&period=${p}`) });
  const ai = useQuery<{ managers: ManagerSummary[] }>({
    queryKey: ['ai-analysis-summary', 90], retry: false, staleTime: 5 * 60_000,
    queryFn: async () => { const r = await fetch('/api/ai-analysis/summary?days=90'); if (!r.ok) throw new Error(String(r.status)); return r.json(); },
  });

  // Агрегат по менеджеру из всех источников.
  const model = useMemo(() => {
    const org = an.data?.org ?? res.data?.org ?? sp.data?.org;
    if (!org) return null;
    const dir = new Map<string, { name: string; deptId: string | null }>();
    const by = new Map<string, MAgg>();
    const A = (id: string) => { let a = by.get(id); if (!a) { a = ZERO(); by.set(id, a); } return a; };
    const snap = an.data?.snapDate ?? null;
    for (const m of an.data?.mgr ?? []) {
      if (m.date !== snap) continue;
      dir.set(m.managerId, { name: m.name, deptId: m.deptId });
      Object.assign(A(m.managerId), { total: m.total, pool: m.pool, poolHot: m.poolHot, poolPotential: m.poolPotential, workedByTask: m.workedByTask,
        inWork: m.inWork, funnel: m.funnel, funnelSum: m.funnelSum, review: m.review, hidden: m.hidden, brak: m.brak, noTask: m.noTask });
    }
    for (const j of an.data?.journal ?? []) {
      if (!j.managerId) continue;
      const a = A(j.managerId);
      if (isAction(j)) { a.actions++; if (KIND_OF[j.type] === 'leak') a.leak++; }
      if (j.type === 'reject_reviewed') a.reviews++;
      if (j.type === 'task_returned') a.returned++;
      if (isAccept(j.type)) a.acceptedKanban++;
    }
    const lim = (res.data?.matureDays ?? 30) * DAY_MS;
    for (const t of res.data?.tasks ?? []) {
      if (!t.managerId) continue;
      const a = A(t.managerId);
      a.tasks++;
      if (t.superseded) continue;
      a.base++;
      const at = new Date(t.createdAt).getTime();
      if (t.reachedAt) a.reached++;
      if (t.soldAt) { a.soldN++; a.soldSum += t.soldAmount ?? 0; }
      if (t.shippedAt) { a.shippedN++; a.shippedSum += t.shippedAmount ?? 0; a.shipDays.push(Math.round((new Date(t.shippedAt).getTime() - at) / DAY_MS)); }
      if (t.mature) { a.mature++; if (t.soldAt && new Date(t.soldAt).getTime() - at <= lim) a.matureSold++; if (t.shippedAt && new Date(t.shippedAt).getTime() - at <= lim) a.matureShipped++; }
      else if (!t.shippedAt) a.inProgress++;
    }
    for (const [id, info] of Object.entries(res.data?.managers ?? {})) if (!dir.has(id)) dir.set(id, info);
    for (const m of sp.data?.mgr ?? []) {
      Object.assign(A(m.managerId), { control: m.control, controlWaitH: m.controlWaitH, overdue: m.overdue, overdue7: m.overdue7, openTasks: m.open, closed: m.accepted, reviewH: m.reviewH, queued: m.queued });
      if (!dir.has(m.managerId)) dir.set(m.managerId, sp.data!.managers[m.managerId] ?? { name: `#${m.managerId}`, deptId: null });
    }
    for (const m of ais.data?.mgr ?? []) Object.assign(A(m.managerId), { aiAnalyses: m.analyses, aiScoreSum: m.scoreSum, aiScoreN: m.scoreN, aiViolations: m.violations, aiRequests: m.requests });
    const list = [...by.entries()].map(([managerId, agg]) => ({ managerId, name: dir.get(managerId)?.name ?? `#${managerId}`, deptId: dir.get(managerId)?.deptId ?? null, agg }));
    return buildTree(org, list);
  }, [an.data, res.data, sp.data, ais.data]);

  const loading = an.isLoading || res.isLoading || sp.isLoading;
  const err = an.error ?? res.error ?? sp.error;
  const T = model?.total.agg;
  const periodText = p === 'all' ? `за всё время (задачи — с ${fmtD(res.data?.fromDate ?? '2026-09-01')}, журнал канбана — с 20.10)` : p === 'day' ? 'сегодня' : p === 'week' ? 'за 7 дней' : 'за 30 дней';

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <Link href="/repeat-kanban" className="inline-flex min-h-11 items-center gap-1 text-sm text-[var(--color-accent)] hover:underline"><ArrowLeft size={14} /> Канбан</Link>
            <h1 className="text-xl font-semibold">Аналитика канбана повторных</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Действия и результат {periodText}. Пул и «ждут приёмки» — текущее состояние.</p>
          </div>
          <div className="grid w-full grid-cols-4 gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1 sm:flex sm:w-auto" role="tablist" aria-label="Период">
            {PERIODS.map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={p === k} onClick={() => setPeriod(k)}
                className={`min-h-9 whitespace-nowrap rounded-md px-2 text-sm sm:px-3 ${p === k ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{l}</button>
            ))}
          </div>
        </header>
        {/* Пять вкладок — переносом (flex-wrap), без горизонтальной ленты (CLAUDE.md, правило 12). */}
        <div className="flex flex-wrap gap-2 border-b border-[var(--color-border)] pb-3" role="tablist" aria-label="Раздел аналитики">
          {TABS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`min-h-11 rounded-lg border px-4 text-sm font-medium ${tab === k ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>{l}</button>
          ))}
        </div>
        {err && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{(err as Error).message}</div>}
        {loading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Собираю аналитику… за всё время это 5–15 секунд.</div>}
        {model && T && tab === 'overview' && <Overview model={model} />}
        {model && T && tab === 'activity' && <Activity model={model} data={an.data} ai={ai.data} aiOk={ai.isSuccess} />}
        {model && T && tab === 'results' && <Results model={model} matureDays={res.data?.matureDays ?? 30} />}
        {model && T && tab === 'pool' && <PoolSpeed model={model} data={an.data} />}
        {model && tab === 'ai' && ais.data && <AiTab model={model} s={ais.data} />}
        {tab === 'ai' && ais.isLoading && <Note>Считаю ИИ-разборы…</Note>}
        {tab === 'journal' && an.data && <Journal data={an.data} />}
      </div>
    </div>
  );
}

// ── Обзор ─────────────────────────────────────────────────────────────────────
function Overview({ model }: { model: { roots: TreeNode[]; total: TreeNode } }) {
  const [level, setLevel] = useState(1);
  const T = model.total.agg;
  const nodes = nodesAtLevel(model.roots, level).filter(({ node }) => node.agg.pool + node.agg.base > 0);
  const pts: MapPoint[] = nodes.filter(({ node }) => per100(node.agg) !== null && crSold(node.agg) !== null && node.agg.base >= 5)
    .map(({ node, path }) => ({ id: node.id, label: level ? path : node.name, short: node.name.replace(/^(Департамент|Отдел|Команда)\s+/i, ''), x: per100(node.agg)!, y: crSold(node.agg)!, size: node.agg.pool, agg: node.agg }));
  const act = tercile(nodes.map(n => per100(n.node.agg))), resT = tercile(nodes.map(n => crSold(n.node.agg)));
  const rank = (k: keyof typeof LIGHT | null) => (k === 'good' ? 2 : k === 'mid' ? 1 : 0);
  const list = nodes.map(n => ({ ...n, a: act(per100(n.node.agg)), r: resT(crSold(n.node.agg)) }))
    .sort((x, y) => rank(y.a) + rank(y.r) - (rank(x.a) + rank(x.r)) || (crSold(y.node.agg) ?? 0) - (crSold(x.node.agg) ?? 0));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <KpiRow>
        <Kpi label="Действий" value={rub.format(T.actions)} sub={`${per100(T) === null ? '—' : String(per100(T)).replace('.', ',')} на 100 в пуле`} hint="Клики РОПов в канбане (без комментариев и тегов) + задачи проекта, поставленные прямо в Битриксе" />
        <Kpi label="Задач поставлено" value={rub.format(T.tasks)} sub={`перепоставлено ${T.tasks - T.base}`} hint="Задачи проекта «Повторные продажи» за период — и из канбана, и из Битрикса" />
        <Kpi label="Проработано" value={pctRu(worked(T))} sub={`с задачей ${T.workedByTask} из ${T.workedByTask + T.poolHot}`} hint="Сейчас: заказчики с задачей РОПа среди тех, у кого окно повторной продажи открыто" />
        <Kpi label="CR Взят → Продажа" value={pctRu(crSold(T))} sub={`${T.soldN} из ${T.base} · ${moneyShort(T.soldSum)}`} hint="Продано после постановки задачи (до следующей отгрузки), среди поставленных. Часть задач ещё в работе — будет расти" />
        <Kpi label="CR Взят → Отгрузка" value={pctRu(crShipped(T))} sub={`${T.shippedN} отгрузок`} hint="Следующая отгрузка заказчика после задачи" />
        <Kpi label="Отгружено по задачам" value={moneyShort(T.shippedSum)} sub={`в работе ещё ${T.inProgress}`} />
      </KpiRow>
      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Кто работает с канбаном и что это даёт</h2>
          <div className="flex flex-wrap gap-2">
            {([[0, 'Филиалы'], [1, 'Департаменты'], [2, 'Отделы']] as const).map(([l, t]) => <Btn key={l} on={level === l} onClick={() => setLevel(l)}>{t}</Btn>)}
          </div>
        </div>
        <Note>Вправо — больше действий на 100 заказчиков пула, вверх — выше CR Взят → Продажа; размер круга — пул. Линии — медианы, на карте подразделения с 5+ задачами. Наведите или нажмите на круг.</Note>
        <div className="hidden sm:block"><ActivityResultMap points={pts} /></div>
        <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 text-[11.5px] text-[var(--color-text-muted)]"><span>Подразделение</span><span className="w-24 text-right">Активность</span><span className="w-24 text-right">Результат</span></div>
          {list.map(({ node, path, a, r }) => (
            <div key={node.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate" title={path}>{level ? path : node.name}</span>
              <span className="w-24 text-right"><Chip k={a} text={per100(node.agg) === null ? '—' : `${String(per100(node.agg)).replace('.', ',')} / 100`} /></span>
              <span className="w-24 text-right"><Chip k={r} text={pctRu(crSold(node.agg))} /></span>
            </div>
          ))}
        </div>
        <Note>Цвет — относительно соседей этого уровня: зелёный — верхняя треть, красный — нижняя. Активность — действий на 100 заказчиков пула, результат — CR Взят → Продажа.</Note>
      </section>
    </div>
  );
}
function Chip({ k, text }: { k: keyof typeof LIGHT | null; text: string }) {
  const st = k ? LIGHT[k] : null;
  return <span className="inline-block min-w-[64px] rounded px-1.5 py-0.5 text-right text-[12.5px] font-bold tabular-nums" style={st ? { background: st.bg, color: st.fg } : { color: 'var(--color-text-muted)' }}>{text}</span>;
}

// ── Активность ────────────────────────────────────────────────────────────────
function Activity({ model, data, ai, aiOk }: { model: { roots: TreeNode[]; total: TreeNode }; data: KanbanAnalytics | undefined; ai: { managers: ManagerSummary[] } | undefined; aiOk: boolean }) {
  const [view, setView] = useState<'org' | 'actors' | 'mgr'>('org');
  const T = model.total.agg;
  const cols: Col[] = [
    { key: 'pool', label: 'В пуле', hint: 'Сейчас: заказчики без открытой повторной сделки', sort: a => a.pool, render: a => rub.format(a.pool) },
    { key: 'actions', label: 'Действий', hint: 'Клики РОПов по заказчикам менеджера + задачи из Битрикса', sort: a => a.actions, render: a => <b>{rub.format(a.actions)}</b> },
    { key: 'per100', label: 'На 100 в пуле', hint: 'Действий на 100 заказчиков пула — интенсивность без эффекта размера', sort: per100, render: a => (per100(a) === null ? '—' : String(per100(a)).replace('.', ',')) },
    { key: 'tasks', label: 'Задач поставлено', hint: 'Задачи проекта за период (канбан и Битрикс)', sort: a => a.tasks, render: a => rub.format(a.tasks) },
    { key: 'closed', label: 'Принято', hint: 'Задачи завершены за период (в канбане и в Битриксе)', sort: a => a.closed, render: a => rub.format(a.closed) },
    { key: 'returned', label: 'Вернули', hint: 'На доработку из канбана (с 23.10; возвраты в Битриксе не видны)', sort: a => a.returned, render: a => a.returned || '—' },
    { key: 'reviews', label: 'Разобрано отказов', sort: a => a.reviews, render: a => a.reviews || '—' },
    { key: 'leak', label: 'Утечка', hint: 'Доля «скрыто + брак» среди действий: высокая — пул чистят, а не работают', sort: a => pct(a.leak, a.actions), render: a => { const v = pct(a.leak, a.actions); return <span style={v !== null && v > 25 ? { color: '#990000', fontWeight: 700 } : { color: 'var(--color-text-muted)' }}>{pctRu(v)}</span>; } },
    { key: 'worked', label: 'Проработано', hint: 'Сейчас: с задачей РОПа среди тех, у кого окно открыто', sort: worked, render: a => <Light v={worked(a)} /> },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <KpiRow>
        <Kpi label="Действий" value={rub.format(T.actions)} sub={`${per100(T) === null ? '—' : String(per100(T)).replace('.', ',')} на 100 в пуле`} />
        <Kpi label="Задач поставлено" value={rub.format(T.tasks)} />
        <Kpi label="Принято задач" value={rub.format(T.closed)} sub={`из канбана ${T.acceptedKanban}`} />
        <Kpi label="Вернули на доработку" value={rub.format(T.returned)} />
        <Kpi label="Разобрано отказов" value={rub.format(T.reviews)} />
        <Kpi label="Утечка" value={pctRu(pct(T.leak, T.actions))} sub={`${T.leak} скрыто/брак`} />
      </KpiRow>
      <div className="flex flex-wrap gap-2">
        <Btn on={view === 'org'} onClick={() => setView('org')}>По подразделениям</Btn>
        <Btn on={view === 'actors'} onClick={() => setView('actors')}>Кто работал</Btn>
        <Btn on={view === 'mgr'} onClick={() => setView('mgr')}>Менеджеры — рейтинг</Btn>
      </div>
      {view === 'org' && <TreeTable roots={model.roots} total={model.total} cols={cols} defaultSort="actions" minW={1080} />}
      {view === 'actors' && data && <Actors data={data} />}
      {view === 'mgr' && data && <MgrRating data={data} ai={ai} aiOk={aiOk} />}
    </div>
  );
}

function Actors({ data }: { data: KanbanAnalytics }) {
  const actors = useMemo(() => {
    type A = { actor: string; role: string | null; total: number; deals: number; reviews: number; accepted: number; leak: number; clients: Set<string>; bxStages: number; bxCalls: number; bxReached: number; bxTasks: number };
    const m = new Map<string, A>();
    const get = (actor: string, role: string | null) => {
      let a = m.get(actor);
      if (!a) { a = { actor, role, total: 0, deals: 0, reviews: 0, accepted: 0, leak: 0, clients: new Set<string>(), bxStages: 0, bxCalls: 0, bxReached: 0, bxTasks: 0 }; m.set(actor, a); }
      if (!a.role && role) a.role = role;
      return a;
    };
    for (const j of data.journal) {
      if (!isAction(j)) continue;
      const a = get(j.actor, j.actorRole);
      a.total++; if (sinkOf(j) === 'deal') a.deals++; if (j.type === 'reject_reviewed') a.reviews++; if (isAccept(j.type)) a.accepted++; if (KIND_OF[j.type] === 'leak') a.leak++;
      if (j.clientKey) a.clients.add(j.clientKey);
    }
    for (const [name, c] of Object.entries(data.bitrixCounts ?? {})) {
      if (c.stages + c.calls + c.submitted + c.closed === 0) continue;
      const a = get(name, null);
      a.bxStages = c.stages; a.bxCalls = c.calls; a.bxReached = c.reached; a.bxTasks = c.submitted + c.closed;
    }
    return [...m.values()].sort((a, b) => b.total - a.total || (b.bxStages + b.bxCalls + b.bxTasks) - (a.bxStages + a.bxCalls + a.bxTasks));
  }, [data]);
  if (!actors.length) return <Note>За период действий не было.</Note>;
  return (
    <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      <table className="w-full min-w-[980px] text-sm">
        <thead><tr className="border-b border-[var(--color-border)]">
          <th className={`${head} text-left`}>Кто</th><th className={head}>Действий</th><th className={head}>Заказчиков</th>
          <th className={head} title="Клики в канбане и задачи, поставленные прямо в Битриксе">Сделок + задач</th><th className={head}>Принято задач</th><th className={head}>Разобрано отказов</th>
          <th className={head} title="Доля «скрыто + сразу в брак» от всех действий">Утечка</th>
          <th className={head} title="Битрикс: смены стадий повторных сделок">Стадий</th>
          <th className={head} title="Битрикс: звонки по сделкам задач после постановки — всего / дозвон > 20 с">Звонков / дозвон</th>
          <th className={head} title="Битрикс: задачи сданы и завершены">Сдано / принято</th>
        </tr></thead>
        <tbody>{actors.map((a, i) => (
          <tr key={a.actor} className="border-b border-[var(--color-border)] last:border-0">
            <td className="px-2 py-1.5"><span className="mr-1">{i < 3 ? ['🥇', '🥈', '🥉'][i] : ''}</span><b>{a.actor}</b>{a.role && <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">{a.role}</span>}</td>
            <td className={`${cell} font-bold`}>{a.total}</td><td className={cell}>{a.clients.size}</td><td className={cell}>{a.deals}</td><td className={cell}>{a.accepted || '—'}</td><td className={cell}>{a.reviews || '—'}</td>
            <td className={cell} style={a.total && a.leak / a.total > 0.25 ? { color: '#990000', fontWeight: 700 } : { color: 'var(--color-text-muted)' }}>{a.total ? `${Math.round((a.leak / a.total) * 100)}%` : '—'}</td>
            <td className={cell}>{a.bxStages || '—'}</td>
            <td className={cell}>{a.bxCalls ? <>{a.bxCalls}<span className="ml-1 text-[11px] text-[var(--color-text-muted)]">/ {a.bxReached}</span></> : '—'}</td>
            <td className={cell}>{a.bxTasks || '—'}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function MgrRating({ data, ai, aiOk }: { data: KanbanAnalytics; ai: { managers: ManagerSummary[] } | undefined; aiOk: boolean }) {
  const aiByName = useMemo(() => new Map((ai?.managers ?? []).map(m => [m.manager.trim().toLowerCase(), m])), [ai]);
  const rows = useMemo(() => {
    if (!data.snapDate) return [];
    const acts = new Map<string, { total: number; leak: number }>();
    for (const j of data.journal) { if (!j.managerId || !isAction(j)) continue; const a = acts.get(j.managerId) ?? { total: 0, leak: 0 }; a.total++; if (KIND_OF[j.type] === 'leak') a.leak++; acts.set(j.managerId, a); }
    return data.mgr.filter((m: MgrDay) => m.date === data.snapDate && m.pool + m.inWork + m.funnel >= 20).map(m => {
      const a = acts.get(m.managerId) ?? { total: 0, leak: 0 };
      return { m, worked: pct(m.workedByTask, m.workedByTask + m.poolHot), per100: m.pool ? Math.round((a.total / m.pool) * 1000) / 10 : 0, acts: a.total, leakPct: a.total ? Math.round((a.leak / a.total) * 100) : 0 };
    }).sort((x, y) => (y.worked ?? 0) - (x.worked ?? 0));
  }, [data]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <table className="w-full min-w-[820px] text-sm">
          <thead><tr className="border-b border-[var(--color-border)]">
            <th className={`${head} text-left`}>Менеджер</th><th className={head}>Проработано</th><th className={head}>В пуле</th>
            <th className={head} title="Действий по его заказчикам на 100 заказчиков в пуле">На 100 в пуле</th>
            <th className={head}>Задач принято / просрочено</th><th className={head}>Утечка</th>
            {aiOk && <><th className={head} title="ИИ-анализ звонков: средний балл (последний отчёт заказчика за 90 дней) / заказчиков с отчётом">ИИ-оценка</th><th className={head}>ИИ: нарушения</th></>}
          </tr></thead>
          <tbody>{rows.map((r, i) => {
            const x = aiByName.get(r.m.name.trim().toLowerCase());
            const v = x?.avgScore ?? null, few = !x || x.analyses < 3;
            const viol = x ? Object.entries(x.violations) as [keyof typeof VIOLATION_LABELS, number][] : [];
            return (
              <tr key={r.m.managerId} className="border-b border-[var(--color-border)] last:border-0">
                <td className="px-2 py-1.5"><span className="mr-1">{i < 3 ? ['🥇', '🥈', '🥉'][i] : ''}</span><b>{r.m.name}</b><span className="ml-1 text-[11px] text-[var(--color-text-muted)]">{r.m.deptName}</span></td>
                <td className={cell}><Light v={r.worked} /></td><td className={cell}>{rub.format(r.m.pool)}</td><td className={cell}>{r.per100}</td>
                <td className={cell}>{r.m.tasksAccepted} / <span style={r.m.tasksOverdue ? { color: '#990000', fontWeight: 700 } : undefined}>{r.m.tasksOverdue}</span></td>
                <td className={cell} style={r.leakPct > 25 ? { color: '#990000', fontWeight: 700 } : { color: 'var(--color-text-muted)' }}>{r.acts ? `${r.leakPct}%` : '—'}</td>
                {aiOk && <>
                  <td className={cell} style={v === null || few ? { color: 'var(--color-text-muted)' } : v < 0.4 ? { color: '#990000', fontWeight: 700 } : v < 0.7 ? { color: '#b45f06' } : { color: '#38761d' }}>
                    {v === null ? '—' : `${Math.round(v * 100)}%`}{x && <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">/ {x.analyses}</span>}
                  </td>
                  <td className={cell} title={viol.map(([k, n]) => `${VIOLATION_LABELS[k]}: ${n}`).join('\n') || undefined} style={viol.length ? { color: '#990000', fontWeight: 700 } : { color: 'var(--color-text-muted)' }}>
                    {viol.length ? viol.reduce((s, [, n]) => s + n, 0) : '—'}
                  </td>
                </>}
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <Note>В рейтинге — менеджеры с 20+ заказчиками в работе и пуле. {aiOk && <Link href="/ai-analysis/managers" target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">ИИ-оценка подробно →</Link>}</Note>
    </div>
  );
}

// ── Результат ─────────────────────────────────────────────────────────────────
function Results({ model, matureDays }: { model: { roots: TreeNode[]; total: TreeNode }; matureDays: number }) {
  const T = model.total.agg;
  const steps = [
    { label: 'Взято из пула', n: T.base, sum: null as number | null },
    { label: 'Дозвонились', n: T.reached, sum: null },
    { label: 'Продано', n: T.soldN, sum: T.soldSum },
    { label: 'Отгружено', n: T.shippedN, sum: T.shippedSum },
  ];
  const cols: Col[] = [
    { key: 'base', label: 'Взято', hint: 'Задачи периода без перепоставленных', sort: a => a.base, render: a => rub.format(a.base) },
    { key: 'reached', label: 'Дозвон', hint: 'Разговор > 20 с по сделке задачи после постановки', sort: a => pct(a.reached, a.base), render: a => pctRu(pct(a.reached, a.base)) },
    { key: 'sold', label: 'Продано', sort: a => a.soldSum, render: a => <>{a.soldN}<span className="ml-1 text-[11px] text-[var(--color-text-muted)]">{a.soldSum ? moneyShort(a.soldSum) : ''}</span></> },
    { key: 'crSold', label: 'CR Взят → Продажа', sort: crSold, render: a => <Light v={crSold(a)} lo={10} hi={25} /> },
    { key: 'shipped', label: 'Отгружено', sort: a => a.shippedSum, render: a => <>{a.shippedN}<span className="ml-1 text-[11px] text-[var(--color-text-muted)]">{a.shippedSum ? moneyShort(a.shippedSum) : ''}</span></> },
    { key: 'crShip', label: 'CR Взят → Отгрузка', sort: crShipped, render: a => pctRu(crShipped(a)) },
    { key: 'mature', label: `CR за ${matureDays} дн.`, hint: `Только задачи старше ${matureDays} дней: продажа в первые ${matureDays} дней — честная когорта`, sort: a => pct(a.matureSold, a.mature), render: a => (a.mature ? `${pctRu(pct(a.matureSold, a.mature))} из ${a.mature}` : '—') },
    { key: 'progress', label: 'Ещё в работе', hint: `Задачи моложе ${matureDays} дней без отгрузки`, sort: a => a.inProgress, render: a => a.inProgress || '—' },
    { key: 'days', label: 'Дней до отгрузки', hint: 'Медиана от постановки задачи до отгрузки', sort: a => median(a.shipDays), render: a => median(a.shipDays) ?? '—' },
    { key: 'check', label: 'Средний чек', sort: a => (a.shippedN ? a.shippedSum / a.shippedN : null), render: a => (a.shippedN ? moneyShort(Math.round(a.shippedSum / a.shippedN)) : '—') },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <KpiRow>
        <Kpi label="Взято из пула" value={rub.format(T.base)} sub={`задач всего ${T.tasks}`} />
        <Kpi label="CR Взят → Продажа" value={pctRu(crSold(T))} sub={`${T.soldN} продаж`} />
        <Kpi label="Продано" value={moneyShort(T.soldSum)} />
        <Kpi label="CR Взят → Отгрузка" value={pctRu(crShipped(T))} sub={`${T.shippedN} отгрузок`} />
        <Kpi label="Отгружено" value={moneyShort(T.shippedSum)} sub={T.shippedN ? `чек ${moneyShort(Math.round(T.shippedSum / T.shippedN))}` : undefined} />
        <Kpi label="До отгрузки" value={median(T.shipDays) === null ? '—' : `${median(T.shipDays)} дн.`} sub="медиана от задачи" />
      </KpiRow>
      <section className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
        {steps.map((s, i) => (
          <div key={s.label} className="grid grid-cols-[110px_1fr] items-center gap-2 text-sm sm:grid-cols-[150px_1fr_160px]">
            <span className="text-[var(--color-text-secondary)]">{s.label}</span>
            <div className="h-6 overflow-hidden rounded bg-[var(--color-bg-hover)]">
              <div className="flex h-full items-center rounded px-2 text-[12px] font-bold text-white" style={{ width: `${Math.max(4, (s.n / Math.max(1, T.base)) * 100)}%`, background: ['#3d85c6', '#6fa8dc', '#6aa84f', '#38761d'][i] }}>
                {rub.format(s.n)}{i > 0 && T.base ? ` · ${pctRu(pct(s.n, T.base))}` : ''}
              </div>
            </div>
            <span className="col-span-2 text-right tabular-nums text-[var(--color-text-muted)] sm:col-span-1">{s.sum !== null ? moneyShort(s.sum) : ''}</span>
          </div>
        ))}
      </section>
      <Note>Задача → следующая отгрузка заказчика (продажа — любой его сделкой после задачи, до отгрузки). Перепоставленные до отгрузки задачи в базу не входят. Часть свежих задач ещё в работе, поэтому CR растёт со временем; честная когорта — «CR за {matureDays} дн.».</Note>
      <TreeTable roots={model.roots} total={model.total} cols={cols} defaultSort="sold" minW={1180} />
    </div>
  );
}

// ── Пул и скорость ────────────────────────────────────────────────────────────
function PoolSpeed({ model, data }: { model: { roots: TreeNode[]; total: TreeNode }; data: KanbanAnalytics | undefined }) {
  const T = model.total.agg;
  const cols: Col[] = [
    { key: 'pool', label: 'В пуле', sort: a => a.pool, render: a => <>{rub.format(a.pool)}{a.poolHot > 0 && <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">срочно {a.poolHot}</span>}</> },
    { key: 'potential', label: 'Потенциал', hint: 'Годовая выручка заказчиков пула, если их вернуть', sort: a => a.poolPotential, render: a => moneyShort(a.poolPotential) },
    { key: 'worked', label: 'Проработано', sort: worked, render: a => <Light v={worked(a)} /> },
    { key: 'control', label: 'Ждут приёмки', hint: 'Сдано менеджером, РОП ещё не принял (сейчас); рядом — медиана ожидания', sort: a => a.control, render: a => (a.control ? <>{a.control}<span className="ml-1 text-[11px] text-[var(--color-text-muted)]">≈{hours(median(a.controlWaitH))}</span></> : '—') },
    { key: 'overdue', label: 'Зависло', hint: 'Открытые задачи со сроком в прошлом (сейчас); красным — больше 7 дней', sort: a => a.overdue, render: a => (a.overdue ? <>{a.overdue}{a.overdue7 > 0 && <span className="ml-1 rounded bg-[#f4cccc] px-1 text-[11px] font-bold text-[#990000]">{a.overdue7} &gt;7 дн.</span>}</> : '—') },
    { key: 'noTask', label: 'В работе без задачи', hint: 'Сделка открыта, задачи РОПа нет (снимок)', sort: a => a.noTask, render: a => a.noTask || '—' },
    { key: 'review', label: 'Отказов на разборе', hint: 'Снимок: ждут решения РОПа', sort: a => a.review, render: a => a.review || '—' },
    { key: 'reviewH', label: 'Разбор отказа', hint: 'Медиана от закрытия сделки в отказ до решения РОПа (за период)', sort: a => median(a.reviewH), render: a => hours(median(a.reviewH)) },
    { key: 'queued', label: 'В очереди', sort: a => a.queued, render: a => a.queued || '—' },
  ];
  // Куда ушёл пул — по филиалам (верхний уровень дерева).
  const sinks = useMemo(() => {
    const branchOf = new Map<string, string>();
    const walk = (n: TreeNode, root: string) => { if (n.kind === 'mgr') branchOf.set(n.id.slice(2), root); n.children.forEach(c => walk(c, root)); };
    model.roots.forEach(r => walk(r, r.name));
    const by = new Map<string, Record<string, number>>();
    for (const j of data?.journal ?? []) {
      const s = sinkOf(j); if (!s) continue;
      const br = (j.managerId && branchOf.get(j.managerId)) || 'Без филиала';
      const r = by.get(br) ?? {}; r[s] = (r[s] ?? 0) + 1; by.set(br, r);
    }
    return [...by.entries()].map(([br, r]) => ({ br, r, total: Object.values(r).reduce((s, n) => s + n, 0) })).sort((a, b) => b.total - a.total);
  }, [data, model.roots]);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <KpiRow>
        <Kpi label="В пуле" value={rub.format(T.pool)} sub={`срочно ${T.poolHot} · ${moneyShort(T.poolPotential)}`} />
        <Kpi label="Проработано" value={pctRu(worked(T))} sub={`с задачей ${T.workedByTask}`} />
        <Kpi label="Ждут приёмки" value={rub.format(T.control)} sub={`ждут ≈${hours(median(T.controlWaitH))} (медиана)`} hint="Время ожидания — от последнего изменения задачи: истории статусов в копии Битрикса нет" />
        <Kpi label="Зависло задач" value={rub.format(T.overdue)} sub={`больше 7 дней — ${T.overdue7}`} />
        <Kpi label="Разбор отказа" value={hours(median(T.reviewH))} sub={`медиана · разобрано ${T.reviews}`} />
        <Kpi label="В очереди" value={rub.format(T.queued)} sub={`без задачи в работе ${T.noTask}`} />
      </KpiRow>
      <TreeTable roots={model.roots} total={model.total} cols={cols} defaultSort="pool" minW={1120} />
      <section className="flex min-w-0 flex-col gap-2">
        <h2 className="text-base font-semibold">Куда ушёл пул</h2>
        <div className="flex flex-wrap gap-3 text-[12px]">{SINKS.map(s => <span key={s.key} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}</div>
        {sinks.length === 0 ? <Note>За период из пула никого не брали.</Note> : (
          <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
            {sinks.map(s => (
              <div key={s.br} className="grid grid-cols-[110px_1fr_40px] items-center gap-2 text-sm sm:grid-cols-[180px_1fr_48px]">
                <span className="truncate" title={s.br}>{s.br}</span>
                <div className="flex h-4 overflow-hidden rounded">{SINKS.map(k => s.r[k.key] ? <div key={k.key} title={`${k.label}: ${s.r[k.key]}`} style={{ width: `${(s.r[k.key] / s.total) * 100}%`, background: k.color }} /> : null)}</div>
                <span className="text-right tabular-nums">{s.total}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <Note>Пул, проработано, ждут приёмки, зависло и очередь — текущее состояние (снимок {data?.snapDate ? fmtD(data.snapDate) : '—'} и Битрикс сейчас), от периода не зависят. Разбор отказа и «куда ушёл пул» — за период. Возвраты на доработку прямо в Битриксе не видны (нет истории статусов).</Note>
    </div>
  );
}

// ── ИИ-разборы ────────────────────────────────────────────────────────────────
const VERDICT_LABEL: Record<string, { t: string; c: string }> = {
  done: { t: 'выполнено', c: '#38761d' }, partial: { t: 'частично', c: '#b45f06' }, not_done: { t: 'не выполнено', c: '#990000' }, no_talk: { t: 'разговора нет', c: '#666666' },
};
function AiTab({ model, s }: { model: { roots: TreeNode[]; total: TreeNode }; s: AiStats }) {
  const score = (a: MAgg) => (a.aiScoreN ? Math.round((a.aiScoreSum / a.aiScoreN) * 100) : null);
  const cols: Col[] = [
    { key: 'aiAnalyses', label: 'Разборов', hint: 'Разборы заказчиков этого менеджера (основной менеджер разбора — у кого больше разговоров)', sort: a => a.aiAnalyses, render: a => a.aiAnalyses || '—' },
    { key: 'aiScore', label: 'Балл проработки', hint: 'Средний балл по 8 критериям разбора', sort: score, render: a => <Light v={score(a)} lo={40} hi={70} /> },
    { key: 'aiViol', label: 'Нарушений', sort: a => a.aiViolations, render: a => (a.aiViolations ? <span style={{ color: '#990000', fontWeight: 700 }}>{a.aiViolations}</span> : '—') },
    { key: 'aiReq', label: 'Запросов', hint: 'Менеджер нажал «Запросить разбор»', sort: a => a.aiRequests, render: a => a.aiRequests || '—' },
    { key: 'pool', label: 'В пуле', sort: a => a.pool, render: a => rub.format(a.pool) },
    { key: 'cover', label: 'Разобрано на 100 в пуле', hint: 'Сколько разборов на 100 заказчиков пула — охват', sort: a => (a.pool ? a.aiAnalyses / a.pool : null), render: a => (a.pool ? String(Math.round((a.aiAnalyses / a.pool) * 1000) / 10).replace('.', ',') : '—') },
  ];
  const maxDay = Math.max(1, ...s.days.map(d => d.analyses + d.checks));
  const verdicts = Object.entries(s.verdicts).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <KpiRow>
        <Kpi label="Разборов" value={rub.format(s.analyses)} sub={`заказчиков ${s.clients} · всего разобрано ${s.analysedEver}`} />
        <Kpi label="Балл проработки" value={s.avgScore === null ? '—' : `${Math.round(s.avgScore * 100)}%`} sub={`нарушений ${s.violations}`} hint="Средний балл менеджеров по 8 критериям разбора" />
        <Kpi label="Отзывы" value={`${s.useful} / ${s.inaccurate}`} sub="полезно / неточно" />
        <Kpi label="Памятка в задаче" value={rub.format(s.memoInTask)} sub={s.analyses ? `${pctRu(pct(s.memoInTask, s.analyses))} разборов` : undefined} hint="Разбор ушёл памяткой в задачу менеджеру" />
        <Kpi label="Запросы менеджеров" value={rub.format(s.requests)} sub={`ждут ${s.requestsPending} · выполнены за ${hours(median(s.requestHours))}`} />
        <Kpi label="Кандидаты" value={rub.format(s.candidates)} sub="разбора не было, 5+ звонков" hint="Сейчас: заказчики с 5 и больше звонками с расшифровкой, по которым разбора ещё не было" />
      </KpiRow>
      <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-[var(--color-text-muted)]">
          <span className="font-semibold text-[var(--color-text)]">По дням</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#3d85c6]" />разборы</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#93c47d]" />проверки звонка</span>
        </div>
        {s.days.length === 0 ? <Note>За период разборов не было.</Note> : (
          <div className="scroll-x"><div className="flex h-32 min-w-full items-end gap-1" style={{ width: Math.max(s.days.length * 22, 100) }}>
            {s.days.map(d => (
              <div key={d.date} className="flex h-full min-w-[18px] flex-1 flex-col items-center justify-end gap-0.5" title={`${fmtD(d.date)}: разборов ${d.analyses}, проверок ${d.checks}`}>
                <div className="w-full rounded-t bg-[#93c47d]" style={{ height: `${(d.checks / maxDay) * 100}%` }} />
                <div className="w-full bg-[#3d85c6]" style={{ height: `${(d.analyses / maxDay) * 100}%` }} />
                <span className="text-[9.5px] tabular-nums text-[var(--color-text-muted)]">{fmtD(d.date)}</span>
              </div>
            ))}
          </div></div>
        )}
      </section>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="text-base font-semibold">Кто запускает</h2>
          <div className="scroll-x rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <table className="w-full min-w-[420px] text-sm">
              <thead><tr className="border-b border-[var(--color-border)]"><th className={`${head} text-left`}>Кто</th><th className={head}>Разборов</th><th className={head}>Заказчиков</th><th className={head}>Проверок звонка</th></tr></thead>
              <tbody>{s.runners.map(r => (
                <tr key={r.name} className="border-b border-[var(--color-border)] last:border-0"><td className="px-2 py-1.5"><b>{r.name}</b></td><td className={cell}>{r.analyses || '—'}</td><td className={cell}>{r.clients || '—'}</td><td className={cell}>{r.checks || '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="text-base font-semibold">Проверки звонка по задаче · {s.checks}</h2>
          <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
            {verdicts.length === 0 ? <Note>Проверок за период не было.</Note> : verdicts.map(([k, n]) => (
              <div key={k} className="grid grid-cols-[120px_1fr_40px] items-center gap-2 text-sm">
                <span style={{ color: VERDICT_LABEL[k]?.c }}>{VERDICT_LABEL[k]?.t ?? k}</span>
                <div className="h-4 overflow-hidden rounded bg-[var(--color-bg-hover)]"><div className="h-full rounded" style={{ width: `${(n / s.checks) * 100}%`, background: VERDICT_LABEL[k]?.c ?? '#999' }} /></div>
                <span className="text-right tabular-nums">{n}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <TreeTable roots={model.roots} total={model.total} cols={cols} defaultSort="aiAnalyses" minW={860} />
      <Note>Менеджер разбора — у кого больше всего разговоров с заказчиком в разобранных звонках.{s.noManager ? ` Без менеджера в оргструктуре — ${s.noManager}.` : ''} Ошибок разбора за период: {s.errors}. Стоимость не показываем.</Note>
    </div>
  );
}

// ── Журнал ────────────────────────────────────────────────────────────────────
function Journal({ data }: { data: KanbanAnalytics }) {
  const [jKinds, setJKinds] = useState<Set<string>>(new Set());
  const [jSearch, setJSearch] = useState('');
  const [jSource, setJSource] = useState<'all' | 'kanban' | 'bitrix'>('all');
  const [openActors, setOpenActors] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const q = jSearch.trim().toLowerCase();
    const rows = data.journal.filter(j => (!jKinds.size || jKinds.has(KIND_OF[j.type] ?? 'aux')) && (jSource === 'all' || j.source === jSource)
      && (!q || `${j.clientName ?? ''} ${j.clientKey ?? ''} ${j.actor}`.toLowerCase().includes(q)));
    const g = new Map<string, JournalRow[]>();
    for (const r of rows) { const l = g.get(r.actor) ?? []; l.push(r); g.set(r.actor, l); }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data, jKinds, jSearch, jSource]);
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <Note>Клики в канбане и события Битрикса: задачи проекта, поставленные не из канбана, сдача и приёмка, смены стадий повторных сделок, звонки по сделкам задач. «Сдал на проверку» — по последнему изменению задачи.{data.bitrixTruncated && ' Стадий и звонков слишком много — в журнале последние 3000 каждого вида.'}</Note>
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map(k => (
          <Btn key={k} on={jKinds.has(k)} onClick={() => setJKinds(s => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; })}>{KIND_LABEL[k]}</Btn>
        ))}
        <div className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1" role="tablist" aria-label="Источник">
          {([['all', 'Все'], ['kanban', 'Канбан'], ['bitrix', 'Битрикс']] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={jSource === k} onClick={() => setJSource(k)}
              className={`min-h-9 rounded-md px-3 text-sm ${jSource === k ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{l}</button>
          ))}
        </div>
        <input value={jSearch} onChange={e => setJSearch(e.target.value)} placeholder="Поиск по заказчику или человеку"
          className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base sm:w-auto sm:max-w-xs sm:flex-1 sm:text-sm" />
      </div>
      {groups.length === 0 ? <Note>Пусто.</Note> : (
        <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          {groups.map(([actor, rows]) => {
            const isOpen = openActors.has(actor);
            const cnt = rows.reduce((m, r) => { m[r.type] = (m[r.type] ?? 0) + 1; return m; }, {} as Record<string, number>);
            return (
              <div key={actor}>
                <button type="button" onClick={() => setOpenActors(s => { const x = new Set(s); if (x.has(actor)) x.delete(actor); else x.add(actor); return x; })}
                  className="flex min-h-11 w-full flex-wrap items-center gap-x-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <b>{actor}</b><span className="text-[var(--color-text-muted)]">— {rows.length}:</span>
                  <span className="min-w-0 text-[var(--color-text-secondary)]">{Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${EVENT_LABEL[t] ?? t} ${n}`).join(', ')}</span>
                </button>
                {isOpen && rows.slice(0, 500).map((j, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--color-border)] px-3 py-1.5 pl-9 text-[12.5px]">
                    <span className="w-24 shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtTime(j.ts)}</span>
                    <span style={{ color: KIND_OF[j.type] === 'leak' ? '#b45f06' : KIND_OF[j.type] === 'undo' ? 'var(--color-text-muted)' : undefined }}>
                      {j.source === 'bitrix' && <span className="mr-1 rounded border border-[var(--color-border)] px-1 text-[10.5px] text-[var(--color-text-muted)]">Битрикс</span>}
                      {labelOf(j)}{j.type === 'reject_reviewed' && j.payload.decision ? ` · ${({ brak: 'брак', no_answer: 'недозвон', return: 'вернуть', postpone: 'отложить' } as Record<string, string>)[String(j.payload.decision)] ?? ''}` : ''}
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
  );
}

