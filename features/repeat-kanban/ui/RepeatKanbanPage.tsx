'use client';
// Канбан повторных продаж (решения владельца 20.10, ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md).
// Карточка = заказчик. Колонки двигаются только по данным (отгрузки, стадии сделки,
// звонки) — руками ничего не перетаскивается. Ручные действия: задача (+ сделка в
// Битриксе) от РОПа, «выполнено» от менеджера, разбор отказа РОПом.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, ChevronLeft, ChevronRight, ExternalLink, MoreHorizontal, RefreshCw, Phone, PhoneMissed, ClipboardList, AlertTriangle, Plus } from 'lucide-react';
import { listParam, stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { DepartmentPicker } from '@/features/reports/ui/FilterBar';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { CustomerCardLoader } from '@/features/customers/ui/CustomerCardLoader';
import { RepeatKanbanSettingsButton, TemplatePicker } from './RepeatKanbanSettings';
import dynamic from 'next/dynamic';

// Карточка сделки — динамически: она сама открывает карточку клиента (цикл модулей).
const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });
import {
  BRAK_REASONS, CLIENT_TYPE_ORDER, CLIENT_TYPE_STYLE, taskUrl, CLIENT_TYPE_SHORT, COLUMNS, TOUCHES, WINDOW_DAYS,
  type ColumnDef, type ColumnGroup, type ColumnKey,
} from '../engine/config';
import type { BoardKpi, KanbanCard, KanbanColumn, RepeatBoard, TodaySection } from '../engine/board';
import type { TaskNote } from '../engine/taskNotes';
import type { RepeatTask } from '../engine/tasks';

const PAGE = 40;
// Все кнопки шапки — одного вида (правка владельца 20.10: «кнопочки приведи к одному виду»).
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors';
const BTN_IDLE = `${BTN} border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`;
const BTN_ACTIVE = `${BTN} border-[var(--color-accent)] bg-[var(--color-accent)] text-white`;
const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (n: number) => `${rub.format(n)} ₽`;
const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' }) : '—');
const fmtDayYear = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Europe/Moscow' });
const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—');
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} с`);
const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;
const cardName = (c: KanbanCard) => c.name ?? `${c.clientType === 'company' ? 'Компания' : 'Контакт'} #${c.clientId}`;

const TASK_FILTERS = [
  { value: 'none', label: 'Без задачи', hint: 'не ставили или прошлую приняли' },
  { value: 'unread', label: 'Не просмотрена', hint: 'менеджер ещё не открыл' },
  { value: 'work', label: 'В работе', hint: 'открыл или начал' },
  { value: 'overdue', label: 'Просрочена', hint: 'срок прошёл' },
  { value: 'control', label: 'Ждёт приёмки', hint: 'менеджер сдал, постановщик не принял' },
  { value: 'done', label: 'Принята', hint: 'постановщик принял' },
] as const;
const SORT_OPTIONS = [
  { value: 'default', label: 'Сортировка: тип клиента и потенциал' },
  { value: 'ltv', label: 'Сортировка: LTV — больше сверху' },
  { value: 'potential', label: 'Сортировка: потенциал — больше сверху' },
  { value: 'fresh', label: 'Сортировка: свежие отгрузки сверху' },
  { value: 'task', label: 'Сортировка: по задачам — что разобрать' },
  { value: 'ev', label: 'Сортировка: ожидаемые деньги (шанс × чек)' },
] as const;
const OUTCOME_OPTIONS = [
  { value: '', label: 'Последняя сделка: любая' },
  { value: 'won', label: 'Последняя сделка: успешная', hint: 'после последней отгрузки отказов не было' },
  { value: 'lost', label: 'Последняя сделка: проигранная', hint: 'повторная сделка после отгрузки закрыта в отказ' },
] as const;

/** Последние комментарии задач видимых карточек — грузятся отдельно от доски (идут в Битрикс). */
const TaskNotesCtx = createContext<Record<string, TaskNote>>({});

const GROUPS: { key: ColumnGroup; title: string; hint: string }[] = [
  { key: 'pool', title: 'Пул', hint: 'Нет открытой повторной сделки' },
  { key: 'touch', title: 'Дозвон', hint: `Взят в работу → до ${TOUCHES} попыток связаться (по дням)` },
  { key: 'stage', title: 'Повторная воронка', hint: 'Сделка в работе' },
  { key: 'review', title: 'Разбор', hint: 'Отказы и брак' },
  { key: 'hidden', title: 'Скрытые', hint: 'Скрыты из пула до даты' },
];

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function post(body: Record<string, unknown>) {
  const r = await fetch('/api/repeat-kanban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j;
}

export function RepeatKanbanPage() {
  const qc = useQueryClient();
  const [mgrs, setMgrs] = useUrlState('managers', listParam([]));
  const [type, setType] = useUrlState('type', stringParam(''));
  const [depts, setDepts] = useUrlState('dept', listParam([]));
  const [pg, setPg] = useUrlState('pg', stringParam(''));
  const [taskF, setTaskF] = useUrlState('tasks', listParam([]));
  const [sort, setSort] = useUrlState('sort', stringParam('default'));
  const [outcome, setOutcome] = useUrlState('outcome', stringParam(''));
  const [view, setView] = useUrlState('view', stringParam('board'));
  const poolGroups = useMemo(() => pg.split('|').filter(Boolean), [pg]);
  const [limits, setLimits] = useState<Partial<Record<ColumnKey, number>>>({});
  const [openCard, setOpenCard] = useState<KanbanCard | null>(null);
  const [openDeal, setOpenDeal] = useState<number | null>(null);
  const [taskFor, setTaskFor] = useState<KanbanCard | null>(null);
  const [reviewFor, setReviewFor] = useState<KanbanCard | null>(null);
  const [hideFor, setHideFor] = useState<KanbanCard | null>(null);
  const [brakFor, setBrakFor] = useState<KanbanCard | null>(null);
  const [hideReqFor, setHideReqFor] = useState<KanbanCard | null>(null);
  // Массовая постановка задач (аудит 21.10: «в работе без задачи» — разом): режим выбора.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Map<string, KanbanCard>>(new Map());
  const [bulkOpen, setBulkOpen] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery<RepeatBoard, ApiError>({
    queryKey: ['repeat-kanban', mgrs, type, depts, pg, taskF, sort, outcome, limits],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (mgrs.length) qs.set('managers', mgrs.join(','));
      if (type) qs.set('type', type);
      if (depts.length) qs.set('dept', depts.join(','));
      if (pg) qs.set('pg', pg);
      if (taskF.length) qs.set('tasks', taskF.join(','));
      if (sort !== 'default') qs.set('sort', sort);
      if (outcome) qs.set('outcome', outcome);
      for (const [k, v] of Object.entries(limits)) qs.set(`n_${k}`, String(v));
      const r = await fetch(`/api/repeat-kanban?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j.error ?? `Ошибка ${r.status}`);
      return j as RepeatBoard;
    },
    // Общий список заказчиков компании ещё считается (первый запуск) — спрашиваем чаще.
    refetchInterval: q => (q.state.data?.warming ? 5_000 : 120_000),
    // Сразу после перезапуска сервера (выкатка) Redis ещё подключается, а пул SA занят —
    // первый запрос может упасть по таймауту соединения. Повторяем 5xx до трёх раз с паузой,
    // вместо красного «Не удалось собрать канбан» (живой случай 20.10).
    retry: (n, e) => e.status >= 500 && n < 3,
    retryDelay: n => 3000 * (n + 1),
    placeholderData: prev => prev,
  });


  const refresh = () => qc.invalidateQueries({ queryKey: ['repeat-kanban'] });
  const byKey = useMemo(() => new Map<string, KanbanColumn>((data?.columns ?? []).map(c => [c.key, c])), [data]);
  const boardRef = useRef<HTMLDivElement>(null);
  const jump = (g: ColumnGroup) => {
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-group="${g}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };
  // Менеджеры для пикера — отдельным лёгким запросом: кнопка видна сразу, а не после
  // сборки доски (иначе «выбор менеджера пропадает», пока доска грузится).
  const { data: meta } = useQuery<{ managers: { id: string; name: string; load?: number }[] }>({
    queryKey: ['repeat-kanban-managers', depts],
    queryFn: async () => {
      const qs = new URLSearchParams({ meta: '1' });
      if (depts.length) qs.set('dept', depts.join(','));
      const r = await fetch(`/api/repeat-kanban?${qs}`);
      return r.ok ? r.json() : { managers: [] };
    },
    staleTime: 5 * 60_000,
  });
  const managerOptions = meta?.managers ?? data?.managers ?? [];
  const taskLimit = data?.taskLimit ?? 10;
  const loadOf = (id: string) => data?.managerLoad?.[id] ?? meta?.managers.find(m => m.id === id)?.load ?? 0;

  // Комментарии задач — для всех видимых карточек (доска + «Сегодня»).
  const visibleTaskIds = useMemo(() => {
    const cards = [...(data?.columns ?? []).flatMap(c => c.cards), ...(data?.today ?? []).flatMap(t => t.cards)];
    return [...new Set(cards.map(c => c.task?.id).filter((x): x is number => !!x))].sort((a, b) => a - b);
  }, [data]);
  const { data: notes } = useQuery<Record<string, TaskNote>>({
    queryKey: ['repeat-kanban-notes', visibleTaskIds.join(',')],
    enabled: visibleTaskIds.length > 0,
    queryFn: async () => {
      const out: Record<string, TaskNote> = {};
      // Порциями по 200 — длина адреса.
      for (let i = 0; i < visibleTaskIds.length; i += 200) {
        const r = await fetch(`/api/repeat-kanban/task-notes?ids=${visibleTaskIds.slice(i, i + 200).join(',')}`);
        if (r.ok) Object.assign(out, (await r.json()).notes ?? {});
      }
      return out;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });
  const todayTotal = (data?.today ?? []).reduce((s, t) => s + t.total, 0);
  const canManage = !!data?.canManage;
  const viewerId = data?.viewerBitrixId ?? null;
  const toggleSel = (c: KanbanCard) => setSelected(m => { const n = new Map(m); if (n.has(c.clientKey)) n.delete(c.clientKey); else n.set(c.clientKey, c); return n; });
  const handlers: CardHandlers = {
    canManage, viewerId,
    select: selectMode ? { has: k => selected.has(k), toggle: toggleSel, addAll: cs => setSelected(m => { const n = new Map(m); for (const c of cs) if (canTaskCol(c.column)) n.set(c.clientKey, c); return n; }) } : null,
    onOpen: setOpenCard, onTask: setTaskFor, onReview: setReviewFor, onDeal: setOpenDeal,
    onAct: async (a, c) => {
      if (a === 'hide') setHideFor(c);
      else if (a === 'request_hide') setHideReqFor(c);
      else if (a === 'brak_now') setBrakFor(c);
      else if (a === 'accept_hide' || a === 'decline_hide') {
        const ok = a === 'accept_hide'
          ? confirm(`Скрыть «${cardName(c)}» до ${c.hideRequest?.until.split('-').reverse().join('.')}, как предлагает менеджер?`)
          : confirm(`Отклонить предложение скрыть «${cardName(c)}»? Заказчик останется в пуле.`);
        if (ok) { await post({ action: 'decide_hide', accept: a === 'accept_hide', clientKey: c.clientKey, managerId: c.managerId, column: c.column }).catch(e => alert(e.message)); refresh(); }
      }
      else if (confirm(`Вернуть «${cardName(c)}» в пул раньше срока?`)) { await post({ action: 'unhide', clientKey: c.clientKey, managerId: c.managerId, column: c.column }).catch(e => alert(e.message)); refresh(); }
    },
    onUnbrak: async c => { if (confirm(`Снять брак с «${cardName(c)}»? Заказчик вернётся в пул.`)) { await post({ action: 'unbrak', clientKey: c.clientKey, managerId: c.managerId, column: c.column }).catch(e => alert(e.message)); refresh(); } },
  };

  // Конвейер — горизонтальный (правка владельца 20.10). Края показывают, что доска
  // продолжается: затухание и стрелки только когда правда есть куда листать.
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = boardRef.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, data]);
  const page = (dir: 1 | -1) => boardRef.current?.scrollBy({ left: dir * boardRef.current.clientWidth * 0.8, behavior: 'smooth' });

  if (error?.status === 403) return <AccessDenied reason="Канбан повторных продаж открыт ролям продаж." />;

  const typeChips = [
    { key: '', label: 'Все' },
    ...Object.keys(CLIENT_TYPE_ORDER).sort((a, b) => CLIENT_TYPE_ORDER[a] - CLIENT_TYPE_ORDER[b]).map(k => ({ key: k, label: CLIENT_TYPE_SHORT[k] })),
    { key: 'none', label: 'Тип не указан' },
  ];
  const totalAll = Object.values(data?.typeCounts ?? {}).reduce((s, n) => s + n, 0);

  return (
    // Экран: шапка сверху, конвейер — на всю оставшуюся высоту, колонки скроллятся внутри
    // (как в канбане Битрикса). На телефоне страница скроллится целиком, доске — 75dvh.
    <div className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden sm:overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-col gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <header className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-[var(--color-text)]">Канбан повторных продаж</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Карточки двигаются сами — по отгрузкам, стадиям сделки и звонкам.
              {data ? ` Обновлено ${fmtDT(data.generatedAt)}.` : ''}
              {data?.dataAt ? ` Стадии, звонки и задачи — сейчас, список заказчиков — на ${fmtDT(data.dataAt)}.` : ''}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Отделы и менеджеры работают вместе: отделы сужают список менеджеров, внутри
                можно отметить нескольких; не отмечен никто — все менеджеры отделов/зоны. */}
            <DepartmentPicker departmentIds={depts} onDepartmentIdsChange={ids => { setDepts(ids); setMgrs([]); setLimits({}); }} triggerClassName={depts.length ? BTN_ACTIVE : BTN_IDLE} />
            {managerOptions.length > 0 && (
              <SearchMultiSelect ariaLabel="Менеджеры" allLabel={depts.length ? 'Все менеджеры отделов' : 'Все менеджеры зоны'}
                unitLabel="менеджеров" searchPlaceholder="Поиск менеджера"
                options={managerOptions.map(m => {
                  const n = loadOf(m.id);
                  return { value: m.id, label: m.name, hint: `${n} из ${taskLimit} активных задач${n >= taskLimit ? ' — перегружен' : ''}` };
                })}
                value={mgrs} onChange={v => { setMgrs(v); setLimits({}); }}
                className={`${mgrs.length ? BTN_ACTIVE : BTN_IDLE} w-[60vw] max-w-xs justify-start sm:w-64`} />
            )}
            {data?.canManage && (
              <div className="flex min-w-0 gap-1 rounded-lg border border-[var(--color-border)] p-0.5" role="tablist" aria-label="Вид">
                <button type="button" role="tab" aria-selected={view !== 'today'} onClick={() => setView('board')}
                  className={`inline-flex min-h-10 items-center rounded-md px-3 text-sm ${view !== 'today' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>Доска</button>
                <button type="button" role="tab" aria-selected={view === 'today'} onClick={() => setView('today')}
                  title="Что решить сегодня: приёмка задач, просрочки, разбор, окно закрывается"
                  className={`inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-sm ${view === 'today' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                  Сегодня{data ? <span className={view === 'today' ? 'opacity-80' : 'text-[var(--color-text-muted)]'}>· {rub.format(todayTotal)}</span> : null}
                </button>
              </div>
            )}
            {data?.canSeeAnalytics && (
              <Link href="/repeat-kanban/analytics" className={BTN_IDLE} title="Кто что делал, проработанность пула по отделам, журнал">
                <BarChart3 size={16} /> Аналитика
              </Link>
            )}
            {data?.canManageSettings && <RepeatKanbanSettingsButton className={BTN_IDLE} />}
            <button type="button" onClick={() => refetch()} aria-label="Обновить" title="Обновить"
              className={`${BTN_IDLE} min-w-11 px-0`}>
              <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        {/* Телефон: список вместо семи чипов — чипы занимали весь первый экран. */}
        <div className="sm:hidden">
          <SearchSelect ariaLabel="Тип клиента" value={type} onChange={v => { setType(v); setLimits({}); }}
            options={typeChips.map(t => ({ value: t.key, label: `${t.label} · ${rub.format(t.key ? data?.typeCounts[t.key] ?? 0 : totalAll)}` }))}
            className={`${type ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
        </div>
        <div className="hidden min-w-0 flex-wrap gap-2 sm:flex" aria-label="Тип клиента">
          {typeChips.map(t => {
            const n = t.key ? data?.typeCounts[t.key] ?? 0 : totalAll;
            const active = type === t.key;
            return (
              <button key={t.key || 'all'} type="button" onClick={() => { setType(t.key); setLimits({}); }}
                className={active ? BTN_ACTIVE : BTN_IDLE}>
                {t.label} <span className={active ? 'opacity-80' : 'text-[var(--color-text-muted)]'}>· {rub.format(n)}</span>
              </button>
            );
          })}
        </div>

        <nav className="flex min-w-0 flex-wrap gap-2" aria-label="Фильтры и переход к группам колонок">
          {/* Фильтр по задачам (владелец 20.10): РОП разбирает задачи прямо на канбане —
              «ждёт приёмки», «просрочена», «без задачи» и т.д.; рядом — сколько заказчиков. */}
          <SearchMultiSelect ariaLabel="Задачи" allLabel="Задачи: все" unitLabel="состояния задач" searchPlaceholder="Поиск"
            options={TASK_FILTERS.map(f => ({ value: f.value, label: f.label, hint: `${rub.format(data?.taskCounts?.[f.value] ?? 0)} заказчиков · ${f.hint}` }))}
            value={taskF} onChange={v => { setTaskF(v); setLimits({}); }}
            className={`${taskF.length ? BTN_ACTIVE : BTN_IDLE} w-[60vw] max-w-xs justify-start sm:w-56`} />
          <SearchSelect ariaLabel="Сортировка" value={sort} onChange={v => { setSort(v); setLimits({}); }}
            options={SORT_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
            className={`${sort !== 'default' ? BTN_ACTIVE : BTN_IDLE} w-[60vw] max-w-xs justify-start sm:w-auto`} />
          {/* Последняя сделка (владелец 21.10): в приоритете — у кого предыдущая успешная;
              проигранная — та, что на карточке даёт кнопку «Вернуть сделку». Действует на пул. */}
          <SearchSelect ariaLabel="Последняя сделка" value={outcome} onChange={v => { setOutcome(v); setLimits({}); }}
            options={OUTCOME_OPTIONS.map(o => ({ value: o.value, label: o.value ? `${o.label} · ${rub.format(data?.outcomeCounts?.[o.value] ?? 0)}` : o.label, hint: 'hint' in o ? `${o.hint} (в пуле)` : undefined }))}
            className={`${outcome ? BTN_ACTIVE : BTN_IDLE} w-[60vw] max-w-xs justify-start sm:w-auto`} />
          {/* Фильтр пула (владелец 20.10): последняя отгрузка — в выбранных группах, после неё
              ничего («отгружали газобетон, а после газобетона ничего»). Группа сделки — по
              наибольшему (head_group_name). Действует только на колонки пула. */}
          <SearchMultiSelect ariaLabel="Пул: последняя отгрузка" allLabel="Пул: любая последняя отгрузка"
            unitLabel="групп в пуле" searchPlaceholder="Поиск товарной группы"
            options={Object.entries(data?.poolGroupCounts ?? {}).sort((a, b) => b[1] - a[1])
              .map(([g, n]) => ({ value: g, label: g, hint: `${rub.format(n)} в пуле — последняя отгрузка` }))
              .concat(poolGroups.filter(g => !(data?.poolGroupCounts ?? {})[g]).map(g => ({ value: g, label: g, hint: 'сейчас 0 в пуле' })))}
            value={poolGroups} onChange={v => { setPg(v.join('|')); setLimits({}); }}
            className={`${poolGroups.length ? BTN_ACTIVE : BTN_IDLE} w-[60vw] max-w-xs justify-start sm:w-72`} />
          {view !== 'today' && GROUPS.map(g => (
            <button key={g.key} type="button" onClick={() => jump(g.key)} title={g.hint}
              className={BTN_IDLE}>
              {g.title}
            </button>
          ))}
          {canManage && view !== 'today' && (
            <button type="button" onClick={() => { setSelectMode(v => !v); setSelected(new Map()); }}
              title="Отметить карточки галочками и поставить задачи всем разом"
              className={selectMode ? BTN_ACTIVE : BTN_IDLE}>
              {selectMode ? 'Отменить выбор' : 'Выбрать карточки'}
            </button>
          )}
        </nav>

        {data?.kpi && <KpiStrip k={data.kpi} activeTask={taskF.length === 1 ? taskF[0] : null}
          onTask={tb => { const on = taskF.length === 1 && taskF[0] === tb; setTaskF(on ? [] : [tb]); setSort(on ? 'default' : 'task'); setLimits({}); }}
          onJump={jump} />}

        {error && error.status !== 403 && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
        {data?.notice && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">{data.notice}</div>}
        {(isLoading || (isFetching && !data && !error)) && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Собираю доску — первый раз по команде это до полуминуты…</div>}

      </div>

      <TaskNotesCtx.Provider value={notes ?? {}}>
      {view === 'today' && data?.canManage ? (
        <TodayView sections={data?.today ?? []} h={handlers} />
      ) : (
      <div className="relative min-h-[75dvh] min-w-0 flex-1 px-4 pb-4 pt-3 sm:min-h-0 sm:px-6">
          <div ref={boardRef} onScroll={measure} className="scroll-x h-full">
            <div className="flex h-full items-stretch gap-5">
              {GROUPS.map(g => (
                <section key={g.key} data-group={g.key} className="flex h-full shrink-0 flex-col gap-2">
                  <div className="px-1">
                    <div className="text-sm font-semibold text-[var(--color-text)]">{g.title}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">{g.hint}</div>
                  </div>
                  <div className="flex min-h-0 flex-1 items-stretch gap-3">
                    {COLUMNS.filter(c => c.group === g.key).map(def => (
                      <Column key={def.key} def={def} col={byKey.get(def.key)} h={handlers}
                        onMore={() => setLimits(l => ({ ...l, [def.key]: (l[def.key] ?? PAGE) + PAGE }))} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
          {edges.left && (
            <>
              <div aria-hidden className="pointer-events-none absolute inset-y-0 left-4 w-10 bg-gradient-to-r from-[var(--color-bg)] to-transparent sm:left-6" />
              <button type="button" onClick={() => page(-1)} aria-label="Листать влево"
                className={`${BTN_IDLE} absolute left-5 top-1/2 hidden min-w-11 -translate-y-1/2 px-0 shadow-md sm:inline-flex`}><ChevronLeft size={18} /></button>
            </>
          )}
          {edges.right && (
            <>
              <div aria-hidden className="pointer-events-none absolute inset-y-0 right-4 w-10 bg-gradient-to-l from-[var(--color-bg)] to-transparent sm:right-6" />
              <button type="button" onClick={() => page(1)} aria-label="Листать вправо"
                className={`${BTN_IDLE} absolute right-5 top-1/2 hidden min-w-11 -translate-y-1/2 px-0 shadow-md sm:inline-flex`}><ChevronRight size={18} /></button>
            </>
          )}
        </div>
      )}
      </TaskNotesCtx.Provider>

      {selectMode && selected.size > 0 && (
        <div className="sticky bottom-0 z-20 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 sm:px-6">
          <span className="text-sm text-[var(--color-text)]">Выбрано {rub.format(selected.size)}</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSelected(new Map())} className={BTN_IDLE}>Снять выбор</button>
            <button type="button" onClick={() => setBulkOpen(true)} className={BTN_ACTIVE}><Plus size={14} /> Поставить задачи · {rub.format(selected.size)}</button>
          </div>
        </div>
      )}
      {bulkOpen && <BulkTaskModal cards={[...selected.values()]} loadOf={loadOf} limit={taskLimit}
        onClose={() => setBulkOpen(false)} onDone={() => { setSelected(new Map()); setSelectMode(false); refresh(); }} />}
      {openCard && (
        <CustomerCardLoader
          contactId={openCard.clientType === 'contact' ? openCard.clientId : null}
          companyId={openCard.clientType === 'company' ? openCard.clientId : null}
          onClose={() => setOpenCard(null)} />
      )}
      {openDeal !== null && <DealCard dealId={openDeal} onClose={() => setOpenDeal(null)} />}
      {taskFor && <TaskModal card={taskFor} load={loadOf(taskFor.managerId)} limit={taskLimit} onClose={() => setTaskFor(null)} onSaved={refresh} />}
      {reviewFor && <ReviewModal card={reviewFor} onClose={() => setReviewFor(null)} onSaved={refresh} />}
      {hideFor && <HideModal card={hideFor} onClose={() => setHideFor(null)} onSaved={refresh} />}
      {hideReqFor && <HideModal card={hideReqFor} request onClose={() => setHideReqFor(null)} onSaved={refresh} />}
      {brakFor && <BrakNowModal card={brakFor} onClose={() => setBrakFor(null)} onSaved={refresh} />}
    </div>
  );
}

/** Колонки, где у карточки есть кнопка задачи (и куда можно поставить массово). */
const canTaskCol = (col: ColumnKey) => col !== 'review' && col !== 'brak' && col !== 'st_sold' && col !== 'hidden';

interface CardHandlers {
  canManage: boolean; viewerId: string | null;
  /** Режим выбора карточек для массовой постановки задач. */
  select: { has: (clientKey: string) => boolean; toggle: (c: KanbanCard) => void; addAll: (cs: KanbanCard[]) => void } | null;
  onAct: (a: CardAction, c: KanbanCard) => void;
  onOpen: (c: KanbanCard) => void; onTask: (c: KanbanCard) => void;
  onReview: (c: KanbanCard) => void; onUnbrak: (c: KanbanCard) => void; onDeal: (dealId: number) => void;
}

function CardFor({ c, h }: { c: KanbanCard; h: CardHandlers }) {
  const sel = h.select && canTaskCol(c.column) ? h.select : null;
  return (
    <Card c={c} col={c.column} canManage={h.canManage}
      selected={sel ? sel.has(c.clientKey) : null} onSelect={sel ? () => sel.toggle(c) : undefined}
      onOpen={() => h.onOpen(c)} onTask={() => h.onTask(c)} onReview={() => h.onReview(c)} onUnbrak={() => h.onUnbrak(c)} onDeal={h.onDeal}
      isOwn={!!h.viewerId && c.managerId === h.viewerId} onAct={a => h.onAct(a, c)} />
  );
}

/** «Сегодня» (аудит 21.10): одна лента того, что РОПу решить сегодня, вместо 20 тыс. карточек. */
function TodayView({ sections, h }: { sections: TodaySection[]; h: CardHandlers }) {
  const filled = sections.filter(s => s.total > 0);
  return (
    // На телефоне прокручивается вся страница: у ленты своей прокрутки нет и она не сжимается
    // (overflow-x-hidden сам включает overflow-y:auto — так лента схлопывалась до 36 px).
    <div className="flex min-w-0 flex-none flex-col gap-5 px-4 pb-6 pt-3 sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:overflow-x-hidden sm:px-6">
      {filled.length === 0 && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">На сегодня решать нечего — всё разобрано.</div>}
      {filled.map(sec => (
        <section key={sec.key} className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-base font-semibold text-[var(--color-text)]">{sec.title} · {rub.format(sec.total)}</h2>
            <span className="text-xs text-[var(--color-text-muted)]">{sec.hint}{sec.total > sec.cards.length ? ` · показаны первые ${sec.cards.length}` : ''}</span>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {sec.cards.map(c => <CardFor key={`${sec.key}:${c.clientKey}`} c={c} h={h} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function Column({ def, col, h, onMore }: { def: ColumnDef; col: KanbanColumn | undefined; h: CardHandlers; onMore: () => void }) {
  const tone = def.key === 'brak' ? 'var(--color-negative)' : def.key === 'review' ? '#e69138' : def.key === 'touch_3' ? '#6aa84f' : 'var(--color-accent)';
  // В воронке итог — сумма сделок (реальные деньги), в пуле и попытках — потенциал (ожидание).
  const moneyLine = def.group === 'stage' ? (col && col.sum > 0 ? `сделки ${money(col.sum)}` : null)
    : col && col.potential > 0 ? `потенциал ${moneyShort(col.potential)}` : null;
  return (
    <div className="flex h-full w-72 max-w-[85vw] shrink-0 flex-col gap-2 rounded-xl bg-[var(--color-bg-surface)] p-2">
      <div className="rounded-lg px-2 py-1.5" style={{ borderLeft: `3px solid ${tone}` }} title={def.hint}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-[var(--color-text)]">{def.title}</span>
          <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{col ? rub.format(col.total) : '…'}</span>
        </div>
        {moneyLine && <div className="text-xs text-[var(--color-text-muted)]" title={def.group === 'stage' ? 'Сумма открытых сделок колонки' : 'Сумма потенциалов (12 мес.) всех заказчиков колонки — как считается, видно по наведению на потенциал карточки'}>{moneyLine}</div>}
        {h.select && canTaskCol(def.key) && col && col.cards.length > 0 && (
          <button type="button" onClick={() => h.select!.addAll(col.cards)} className="mt-1 min-h-8 text-xs text-[var(--color-accent)] hover:underline">
            Выбрать показанные · {rub.format(col.cards.length)}
          </button>
        )}
      </div>
      {/* Карточки скроллятся внутри колонки — колонка на всю высоту экрана. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {col?.cards.map(c => <CardFor key={c.clientKey} c={c} h={h} />)}
        {col && col.total > col.cards.length && (
          <button type="button" onClick={onMore}
            className="min-h-11 shrink-0 rounded-lg text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
            Показать ещё · осталось {rub.format(col.total - col.cards.length)}
          </button>
        )}
        {col && col.total === 0 && <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">Пусто</div>}
      </div>
      {/* «Итого» под колонкой (владелец 20.10): одна строка в одном порядке у всех колонок. */}
      {col && col.total > 0 && (
        <div className="shrink-0 rounded-lg border-t border-[var(--color-border)] px-2 pt-1.5 text-[11px] leading-snug text-[var(--color-text-muted)]">
          <span className="font-semibold text-[var(--color-text)]">Итого {rub.format(col.total)}</span>
          {moneyLine && <> · {moneyLine}</>}
          {col.avgAgeDays !== null && <> · ср. {col.avgAgeDays} дн.</>}
          {col.overdue > 0 && <> · <span className="text-[var(--color-negative)]">просрочено {col.overdue}</span></>}
          {col.noTask > 0 && <> · без задачи {col.noTask}</>}
          {col.sleeping > 0 && <> · спит {col.sleeping}</>}
        </div>
      )}
    </div>
  );
}

/** Показатели канбана для РОПа — снимок текущей доски (аудит Fable 20.10). Исторические
 *  (скорость взятия из пула, конверсия пул → продано за 90 дн.) — в BACKLOG. */
/** Проработанность (владелец 21.10: «кольцо тоже должно мотивировать»). Считается не от всей
 *  базы (там всегда ~5 %), а от РАБОЧЕЙ части: у кого окно открыто, плюс кого уже взяли в работу.
 *  100 % — ни одного заказчика с открытым окном без сделки. */
function WorkedRing({ k }: { k: BoardKpi }) {
  const worked = k.inWork + k.funnel + k.review;
  const total = worked + k.hot;
  const share = total ? worked / total : 0;
  const r = 26, c = 2 * Math.PI * r;
  return (
    <div className="flex shrink-0 flex-col items-center"
      title={`Проработано ${rub.format(worked)} из ${rub.format(total)}: в работе ${worked} (дозвон ${k.inWork}, воронка ${k.funnel}, разбор ${k.review}) против ${k.hot} с открытым окном без сделки. 100% — окно не горит ни у кого.`}>
      <svg width="64" height="64" viewBox="0 0 64 64" aria-label={`Проработано ${Math.round(share * 100)}%`}>
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke="#ffffff" strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${c * share} ${c}`} transform="rotate(-90 32 32)" />
        <text x="32" y="36" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="700">{Math.round(share * 100)}%</text>
      </svg>
      <div className="mt-0.5 whitespace-nowrap text-[11px] opacity-85">проработано</div>
    </div>
  );
}

function KpiStrip({ k, activeTask, onTask, onJump }: {
  k: BoardKpi; activeTask: string | null;
  /** Клик по плитке задач — фильтр этого состояния + сортировка «по задачам» (владелец 20.10). */
  onTask: (tb: 'control' | 'none' | 'overdue') => void;
  /** Клик по плитке группы — перемотка доски к ней. */
  onJump: (g: ColumnGroup) => void;
}) {
  // Одна плитка — одна цифра крупно + подпись мелко (владелец 20.10: «показатели с
  // диапазонами — хуета»: «414 · 36,8 млн» читалось как диапазон).
  const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const tiles: { label: string; value: string; sub?: string; hint: string; tone?: 'neg' | 'warn'; task?: 'control' | 'none' | 'overdue'; jump?: ColumnGroup }[] = [
    { label: 'В пуле', jump: 'pool', value: rub.format(k.pool), sub: 'заказчиков', hint: 'Без открытой повторной сделки — кого можно брать в работу' },
    { label: 'В дозвоне', jump: 'touch', value: rub.format(k.inWork), sub: `на ${moneyShort(k.inWorkPotential)}`, hint: 'Взяты в работу и в попытках связаться' },
    { label: 'Дозвон', jump: 'touch', value: pctOf(k.reached, k.inWork), sub: `${rub.format(k.reached)} из ${rub.format(k.inWork)}`, hint: 'Среди тех, кто в дозвоне: был разговор дольше 20 с или ручной контакт' },
    { label: 'В воронке', jump: 'stage', value: rub.format(k.funnel), sub: `на ${moneyShort(k.funnelSum)}`, hint: 'Повторные сделки в работе и их сумма' },
    { label: 'Просрочено', task: 'overdue', value: rub.format(k.tasksOverdue), sub: 'задач', hint: 'Открытые задачи проекта «Повторные продажи» с прошедшим сроком', tone: k.tasksOverdue ? 'neg' : undefined },
    { label: 'Ждут приёмки', task: 'control', value: rub.format(k.tasksControl), sub: 'задач', hint: 'Менеджер сдал задачу, постановщик не принял', tone: k.tasksControl ? 'warn' : undefined },
    { label: 'Без задачи', task: 'none', value: rub.format(k.noTaskInWork), sub: 'сделок', hint: 'В дозвоне и воронке, по которым нет открытой задачи', tone: k.noTaskInWork ? 'warn' : undefined },
    { label: 'Отказы', jump: 'review', value: rub.format(k.review), sub: k.reviewEarly ? `${k.reviewEarly} рано закрыты` : 'на проверке', hint: 'Ждут решения РОПа; «до 3 попыток» — закрыты, не дозвонившись и не сделав трёх попыток', tone: k.reviewEarly ? 'neg' : undefined },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-stretch">
      {/* Главная цифра — сколько денег лежит в пуле, если вернуть заказчиков. */}
      <div className="flex shrink-0 items-center gap-3 rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-white lg:w-[340px]">
        {/* Потенциал ВСЕЙ базы (кроме брака) — не тает от работы (владелец 20.10: «при проработанном
            канбане потенциал будет 0?»); под ним — сколько из него ещё лежит нетронутым в пуле. */}
        <div className="min-w-0 flex-1"
          title="Сумма потенциалов всех заказчиков, кроме брака: сколько они принесут за год, если работать с повторкой. Потенциал заказчика — средняя годовая выручка вернувшихся таких же заказчиков (по числу покупок, физ/юр). «В пуле» — та часть, по которой ещё никто не работает.">
          <div className="text-[12px] opacity-85">Потенциал за год</div>
          <div className="text-[26px] font-bold leading-tight tabular-nums">{moneyShort(k.totalPotential)}</div>
          <div className="text-[12px] opacity-85">если работать с повторкой</div>
          <div className="mt-0.5 text-[11.5px] font-semibold">в пуле, не тронуто: {moneyShort(k.poolPotential)}</div>
          {/* Деньги под риском (владелец 21.10: «прикольно»): окно повторной продажи открыто,
              сделки нет — через ≤ 22 дня заказчик «остынет». */}
          <button type="button" onClick={() => onJump('pool')} className="mt-1 inline-flex min-h-6 max-w-full items-center whitespace-nowrap rounded bg-white/15 px-1.5 text-left text-[11.5px] font-semibold hover:bg-white/25"
            title={`У ${k.hot} заказчиков открыто окно повторной продажи (отгрузка ≤ 22 дней назад, сделки нет); у ${k.hotClosing} закрывается в ближайшие 3 дня. Сумма — их потенциал за год.`}>
            под риском: {moneyShort(k.hotPotential)} · {rub.format(k.hot)} зак.
          </button>
        </div>
        <WorkedRing k={k} />
      </div>
      {/* Плитки — одной высоты с главной, всё по центру; подпись сверху, цифра крупно, пояснение
          мелко — без обрезанных «Заказчиков в п…» (правка владельца 20.10). */}
      <div className="grid min-w-0 flex-1 auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {tiles.map(t => (
          // Жёсткая сетка из трёх строк фиксированной высоты — подпись / цифра / пояснение:
          // цифры всех плиток на одной линии, сколько бы строк ни занял текст (правка 20.10:
          // «все цифры прыгают»). Пояснение — одна строка с многоточием, полный текст в title.
          <button type="button" key={t.label} title={`${t.hint}${t.sub ? `\n${t.sub}` : ''}\n${t.task ? (activeTask === t.task ? 'Нажмите, чтобы снять фильтр' : 'Нажмите — показать только их') : 'Нажмите — перейти к колонкам'}`}
            onClick={() => (t.task ? onTask(t.task) : t.jump && onJump(t.jump))}
            className={`grid min-w-0 grid-rows-[16px_30px_16px] content-center items-center justify-items-center gap-1 rounded-xl border px-2 py-2 text-center transition-colors hover:bg-[var(--color-bg-hover)] ${t.task && activeTask === t.task ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'}`}>
            <div className="w-full truncate text-[11.5px] font-medium leading-4 text-[var(--color-text-muted)]">{t.label}</div>
            <div className="text-[24px] font-bold leading-[30px] tabular-nums" style={t.tone === 'neg' ? { color: 'var(--color-negative)' } : t.tone === 'warn' ? { color: '#b45f06' } : undefined}>{t.value}</div>
            <div className="w-full truncate text-[11px] leading-4 text-[var(--color-text-muted)]">{t.sub ?? '\u00a0'}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// Неразрывные пробелы: «127 тыс. ₽» не рвётся по строкам (правка владельца 20.10).
// От миллиарда — «млрд» (владелец 21.10: «5057,1 млн» → «5,1 млрд»).
const moneyShort = (n: number) => (n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1).replace('.', ',')}\u00a0млрд\u00a0₽` : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')}\u00a0млн\u00a0₽` : n >= 1000 ? `${Math.round(n / 1000)}\u00a0тыс.\u00a0₽` : `${rub.format(n)}\u00a0₽`);

const TASK_STATE: Record<RepeatTask['state'], { label: string; bg: string; fg: string }> = {
  unread: { label: 'не просмотрена', bg: '#f4cccc', fg: '#990000' },
  pending: { label: 'не начата', bg: '#efefef', fg: '#434343' },
  in_progress: { label: 'в работе', bg: '#cfe2f3', fg: '#0b5394' },
  control: { label: 'ждёт контроля', bg: '#fce5cd', fg: '#b45f06' },
  done: { label: 'принята', bg: '#d9ead3', fg: '#38761d' },
  deferred: { label: 'отложена', bg: '#efefef', fg: '#666666' },
};

const BUCKET_LABEL: Record<string, string> = { '1': '1 покупкой', '2': '2 покупками', '3': '3 покупками', '4-5': '4–5 покупками', '6+': '6 и более покупками' };

/** Потенциал с объяснением (владелец 20.10: «наводя на потенциал — понятно, как считается»).
 *  На компьютере — по наведению, на телефоне — по нажатию (Popover, не голый title). */
function PotentialBadge({ c }: { c: KanbanCard }) {
  const [open, setOpen] = useState(false);
  const p = c.potentialInfo!;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <Popover open={open} onOpenChange={setOpen} side="top" align="start" className="w-[320px] max-w-[calc(100vw-16px)] p-3 text-[12.5px] leading-snug"
      trigger={
        // Клик только ОТКРЫВАЕТ (preventDefault глушит переключатель Radix): иначе наведение
        // открывало, а клик тут же закрывал. Закрытие — уход мыши, клик мимо, Esc.
        <button type="button" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
          onClick={e => { e.preventDefault(); setOpen(true); }}
          className="font-semibold text-[var(--color-text)] underline decoration-dotted underline-offset-2">
          потенциал {moneyShort(p.value)}
        </button>
      }>
      <div className="flex flex-col gap-1.5 text-[var(--color-text)]">
        <div className="text-[15px] font-bold">Потенциал ≈ {money(p.value)} за год</div>
        <div className="text-[var(--color-text-secondary)]">
          Столько в среднем приносят за год заказчики с {BUCKET_LABEL[p.bucket] ?? `${p.bucket} покупками`} ({p.b2b ? 'юрлица' : 'физлица'}), <b>когда возвращаются</b>. Посчитано по всей истории продаж — {rub.format(p.n)} таких заказчиков.
        </div>
        <div className="rounded-md bg-[var(--color-accent-soft)] px-2 py-1.5 text-[var(--color-accent)]">
          Сейчас возвращается {pct(p.conv)} — каждый возвращённый сверх этого даёт +{moneyShort(p.value)} выручки за год.
        </div>
        <div className="text-[11.5px] text-[var(--color-text-muted)]">
          Покупки склеены по правилу повторной продажи, крупные выбросы срезаны по 95-му перцентилю.
        </div>
      </div>
    </Popover>
  );
}

function TypeChip({ type }: { type: string | null }) {
  const key = type ?? 'none';
  const st = CLIENT_TYPE_STYLE[key] ?? CLIENT_TYPE_STYLE.none;
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
      style={{ background: st.bg, color: st.fg, border: `1px ${st.dashed ? 'dashed' : 'solid'} ${st.border}` }}
      title={type ? undefined : 'Тип клиента не указан — заполните в карточке клиента'}>
      {type ? CLIENT_TYPE_SHORT[type] ?? type : 'Тип?'}
    </span>
  );
}

/** Тревоги карточки — одна зона, максимум два чипа по приоритету (аудит Fable 20.10). */
function alertsOf(c: KanbanCard, col: ColumnKey): { text: string; red: boolean }[] {
  const a: { text: string; red: boolean }[] = [];
  const t = c.task;
  const open = t && t.state !== 'done' && t.state !== 'control';
  if (t && open && t.deadlineAt && new Date(t.deadlineAt).getTime() < Date.now()) a.push({ text: 'Задача просрочена', red: true });
  if (col === 'review' && c.lostEarly) a.push({ text: `Отказ после ${c.attempts?.count ?? 0} из ${TOUCHES} попыток`, red: true });
  if (col === 'review' && c.dozvonFail) a.push({ text: `${TOUCHES} попытки без дозвона`, red: true });
  if (col === 'touch_3' && !c.attempts?.reached) a.push({ text: '3 попытки без дозвона', red: true });
  if (t?.state === 'unread') a.push({ text: 'Задача не просмотрена', red: true });
  const callAfter = t && c.calls.some(x => !x.missed && x.sec > 20 && x.at > t.createdAt);
  if (t && (t.state === 'control' || t.state === 'done') && !callAfter) a.push({ text: 'Выполнено без звонка', red: true });
  if (c.deal && !t && (col.startsWith('touch') || col.startsWith('st_'))) a.push({ text: 'Сделка без задачи', red: false });
  if (t?.state === 'control' && t.changedAt && daysAgo(t.changedAt) >= 1) a.push({ text: `Ждёт приёмки ${daysAgo(t.changedAt)} дн.`, red: false });
  if (c.attempts?.reached && col.startsWith('touch')) a.push({ text: 'Дозвонились — переведите стадию', red: false });
  if (c.freshDays !== null && col === 'pool_hot') a.push({ text: `Окно: осталось ${Math.max(0, 22 - c.freshDays)} дн.`, red: 22 - c.freshDays <= 3 });
  if (c.sleeping && col.startsWith('pool')) a.push({ text: 'Спит', red: false });
  return a;
}

type CardAction = 'hide' | 'request_hide' | 'accept_hide' | 'decline_hide' | 'brak_now' | 'unhide';

/** Редкие действия карточки — в меню «⋯» (владелец 20.10: «глупо, когда висят прямо на лице»). */
function CardMenu({ items, onAct }: { items: { label: string; act: CardAction; danger?: boolean }[]; onAct: (a: CardAction) => void }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen} align="end" className="w-48 p-1"
      trigger={
        <button type="button" aria-label="Ещё действия" title="Ещё действия"
          className="tap-target inline-flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
          <MoreHorizontal size={16} />
        </button>
      }>
      {items.map(i => (
        <button key={i.act} type="button" onClick={() => { setOpen(false); onAct(i.act); }}
          className={`flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)] ${i.danger ? 'text-[#990000]' : 'text-[var(--color-text)]'}`}>
          {i.label}
        </button>
      ))}
    </Popover>
  );
}

function Card({ c, col, canManage, isOwn, selected, onSelect, onOpen, onTask, onReview, onUnbrak, onDeal, onAct }: {
  c: KanbanCard; col: ColumnKey; canManage: boolean;
  /** null — не в режиме выбора (или карточку нельзя выбрать). */
  selected: boolean | null; onSelect?: () => void;
  /** Заказчик смотрящего менеджера: «Скрыть» — только РОП, менеджер ПРЕДЛАГАЕТ (владелец 21.10). */
  isOwn: boolean;
  onAct: (a: CardAction) => void;
  onOpen: () => void; onTask: () => void; onReview: () => void; onUnbrak: () => void;
  onDeal: (dealId: number) => void;
}) {
  const isPool = col.startsWith('pool') || col === 'brak';
  const good = c.calls.filter(x => !x.missed && x.sec > 20);
  const alerts = alertsOf(c, col);
  const shownAlerts = alerts.slice(0, 2);
  const old = c.lastDeliveredAt ? daysAgo(c.lastDeliveredAt) : null;
  const dealLabel = c.deal ? 'Задача' : c.lastLost ? 'Вернуть сделку + задача' : 'Сделка + задача';
  const note = useContext(TaskNotesCtx)[String(c.task?.id ?? '')];

  return (
    <article className={`flex shrink-0 flex-col gap-1 rounded-lg border bg-[var(--color-bg)] p-2.5 text-[12.5px] ${selected ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
      {/* 1. Шапка: имя + тип; менеджер. */}
      <div className="flex items-start justify-between gap-2">
        {selected !== null && (
          <label className="tap-target -ml-0.5 mt-0.5 inline-flex shrink-0 cursor-pointer items-center" aria-label="Выбрать заказчика">
            <input type="checkbox" checked={selected} onChange={onSelect} className="h-4 w-4 accent-[var(--color-accent)]" />
          </label>
        )}
        <button type="button" onClick={onOpen} className="min-w-0 text-left text-sm font-semibold text-[var(--color-text)] hover:text-[var(--color-accent)]">
          <span className="line-clamp-2">{cardName(c)}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <TypeChip type={c.profileType} />
          <CardMenu items={[
            ...(col.startsWith('pool') && canManage ? [{ label: 'Скрыть из пула', act: 'hide' as const }] : []),
            ...(col.startsWith('pool') && !canManage && isOwn && !c.hideRequest ? [{ label: 'Предложить скрыть', act: 'request_hide' as const }] : []),
            ...(canManage && (col.startsWith('pool') || col.startsWith('touch') || (col.startsWith('st_') && col !== 'st_sold')) ? [{ label: 'Сразу в брак', act: 'brak_now' as const, danger: true }] : []),
          ]} onAct={onAct} />
        </div>
      </div>
      <div className="truncate text-[11.5px] text-[var(--color-text-muted)]">{c.managerName}</div>

      {/* 2. Деньги. */}
      <div className="min-w-0 tabular-nums">
        <div className="whitespace-nowrap">{c.purchases}{'\u00a0'}{plural(c.purchases, 'отгрузка', 'отгрузки', 'отгрузок')} на {moneyShort(c.sumDelivered)}</div>
      </div>

      {/* 3. Последняя отгрузка — две строки: «Отгрузка дд.мм.гг · N дн. назад» (без переноса,
          дата открывает сделку) и товарная группа (обрезается многоточием). */}
      {c.lastDeliveredAt ? (
        <div className="min-w-0 text-[var(--color-text-secondary)]">
          <div className="whitespace-nowrap">
            {c.lastDeliveredDealId ? (
              <button type="button" onClick={() => onDeal(c.lastDeliveredDealId!)} className="text-[var(--color-accent)] hover:underline" title="Открыть сделку последней отгрузки">
                Отгрузка {fmtDayYear(c.lastDeliveredAt)}
              </button>
            ) : <>Отгрузка {fmtDayYear(c.lastDeliveredAt)}</>}
            {' · '}<span style={old !== null && old > 120 ? { color: '#b45f06', fontWeight: 600 } : undefined}>{old}{'\u00a0'}дн. назад</span>
          </div>
          <div className="truncate" title={c.lastDeliveredGroup ?? undefined}>{c.lastDeliveredGroup ?? 'без товарной группы'}</div>
        </div>
      ) : <div className="text-[var(--color-text-muted)]">Отгрузок не было</div>}

      {/* 4. Сделка — строка есть всегда. */}
      <div className="truncate">
        {c.deal ? (
          <a href={dealUrl(c.deal.dealId)} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-[var(--color-accent)] hover:underline">
            <ExternalLink size={12} className="shrink-0" /><span className="truncate">#{c.deal.dealId} · {c.deal.stageName ?? c.deal.stageId}</span>
          </a>
        ) : c.lastLost ? (
          <a href={dealUrl(c.lastLost.dealId)} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-[var(--color-text-muted)] hover:underline">
            <ExternalLink size={12} className="shrink-0" /><span className="truncate">Нет активной сделки · отказ {fmtDay(c.lastLost.lostAt)} · {c.lastLost.stageName}</span>
          </a>
        ) : <span className="text-[var(--color-text-muted)]">Нет активной сделки</span>}
      </div>

      {/* 5. Контакт: попытки по порядку (●●○), последний звонок, недозвоны. */}
      {!isPool && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--color-text-secondary)]">
          {c.attempts && (
            <span className="inline-flex items-center gap-1" title={c.attempts.days.map((d, i) => `${i + 1}-я попытка: ${d.split('-').reverse().slice(0, 2).join('.')}`).join('\n') || 'Попыток ещё не было'}>
              {[0, 1, 2].map(i => (
                <span key={i} className={`inline-block h-2.5 w-2.5 rounded-full ${i < Math.min(c.attempts!.count, TOUCHES) ? (c.attempts!.reached ? 'bg-[#6aa84f]' : 'bg-[var(--color-accent)]') : 'border border-[var(--color-border-strong)]'}`} />
              ))}
              <span className="tabular-nums">{Math.min(c.attempts.count, TOUCHES)}/{TOUCHES}</span>
              {c.attempts.reached && <span className="font-semibold text-[#38761d]">дозвон</span>}
            </span>
          )}
          {good[0] && <span className="inline-flex items-center gap-0.5"><Phone size={11} /> {fmtDT(good[0].at)} ({fmtSec(good[0].sec)})</span>}
          {c.missedCalls > 0 && <span className="inline-flex items-center gap-0.5 text-[var(--color-text-muted)]"><PhoneMissed size={11} /> {c.missedCalls}</span>}
        </div>
      )}

      {/* 6. Задача + тревоги (одна зона, максимум два чипа). */}
      {c.task && (
        <a href={taskUrl(c.task.id)} target="_blank" rel="noreferrer" className="flex flex-wrap items-center gap-1.5 text-[11.5px] hover:opacity-90"
          title={`Задача от ${fmtDT(c.task.createdAt)}${c.task.deadlineAt ? `, срок ${fmtDay(c.task.deadlineAt)}` : ''}`}>
          <span className="rounded px-1.5 py-0.5 font-semibold" style={{ background: TASK_STATE[c.task.state].bg, color: TASK_STATE[c.task.state].fg }}>
            <ClipboardList size={11} className="mr-0.5 inline" />{TASK_STATE[c.task.state].label}
          </span>
          <span className="min-w-0 truncate text-[var(--color-text-muted)]">{shortName(c.task.createdByName)} → {shortName(c.task.responsibleName)}</span>
        </a>
      )}
      {/* Последний комментарий по задаче (владелец 21.10): что ответил менеджер — видно сразу,
          принимать задачу РОП ходит в Битрикс. */}
      {note && (
        <div className="rounded-md border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-surface)] px-2 py-1 text-[11.5px] leading-snug" title={note.text}>
          <div className="text-[var(--color-text-muted)]">
            {note.isResult ? 'Результат' : 'Комментарий'} · {shortName(note.author)} · {fmtDT(note.at)}
          </div>
          <div className="line-clamp-3 whitespace-pre-line text-[var(--color-text)]">{note.text}</div>
        </div>
      )}
      {shownAlerts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shownAlerts.map(a => (
            <span key={a.text} className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
              style={a.red ? { background: '#f4cccc', color: '#990000' } : { background: '#fff2cc', color: '#7f6000' }}>
              {a.red && <AlertTriangle size={10} className="mr-0.5 inline" />}{a.text}
            </span>
          ))}
          {alerts.length > 2 && <span className="text-[11px] text-[var(--color-text-muted)]" title={alerts.slice(2).map(a => a.text).join('\n')}>+{alerts.length - 2}</span>}
        </div>
      )}
      {c.review?.decision === 'return' && col === 'review' && (
        <div className="text-[11px] text-[#b45f06]">Возвращено менеджеру {fmtDay(c.review.decidedAt)} · {c.review.decidedBy}</div>
      )}
      {c.brak && <div className="text-[11px] text-[var(--color-negative)]">{c.brak.comment ?? 'Брак'} · {c.brak.by}, {fmtDay(c.brak.at)}</div>}
      {c.hidden && (
        <div className="rounded-md bg-[var(--color-bg-surface)] px-2 py-1 text-[11.5px]">
          <div className="font-semibold text-[var(--color-text)]">Скрыт до {c.hidden.until.split('-').reverse().join('.')}</div>
          {c.hidden.comment && <div className="text-[var(--color-text-secondary)]">«{c.hidden.comment}»</div>}
          <div className="text-[var(--color-text-muted)]">{c.hidden.by}, {fmtDay(c.hidden.at)}</div>
        </div>
      )}

      {c.hideRequest && (
        <div className="rounded-md bg-[#fff2cc] px-2 py-1 text-[11.5px] text-[#7f6000]">
          <div className="font-semibold">Предлагает скрыть до {c.hideRequest.until.split('-').reverse().join('.')}</div>
          <div>«{c.hideRequest.comment}»</div>
          <div className="opacity-80">{c.hideRequest.by}, {fmtDay(c.hideRequest.at)}</div>
          {canManage && (
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              <button type="button" onClick={() => onAct('accept_hide')} className="min-h-11 rounded-md bg-[#7f6000] px-2 text-xs font-medium text-white hover:opacity-90">Скрыть</button>
              <button type="button" onClick={() => onAct('decline_hide')} className="min-h-11 rounded-md border border-[#bf9000] px-2 text-xs font-medium hover:bg-[#ffe599]">Отклонить</button>
            </div>
          )}
        </div>
      )}

      {/* Действие. */}
      {/* Кнопки — на всю ширину карточки (правка владельца 20.10). */}
      <div className="flex flex-col gap-2 pt-0.5">
        {canManage && col !== 'review' && col !== 'brak' && col !== 'st_sold' && (
          <button type="button" onClick={onTask}
            className={`inline-flex min-h-11 w-full items-center justify-center gap-1 rounded-md px-2.5 text-xs font-medium hover:opacity-90 ${c.task && c.task.state !== 'done' ? 'bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'}`}>
            <Plus size={13} /> {dealLabel}
          </button>
        )}
        {canManage && col === 'review' && (
          <button type="button" onClick={onReview}
            className="inline-flex min-h-11 w-full items-center justify-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 text-xs font-medium text-white hover:opacity-90">
            {c.dozvonFail ? 'Разобрать: 3 попытки без дозвона' : 'Разобрать отказ'}
          </button>
        )}
        {col === 'hidden' && canManage && (
          <button type="button" onClick={() => onAct('unhide')}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
            Вернуть в пул
          </button>
        )}
        {canManage && col === 'brak' && (
          <button type="button" onClick={onUnbrak}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
            Снять брак
          </button>
        )}
      </div>
    </article>
  );
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
};
const shortName = (full: string | null) => {
  if (!full) return '—';
  const parts = full.trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1][0]}.` : full;
};

const fieldCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-text)] sm:text-sm';

/** Дата по Москве (YYYY-MM-DD) через n дней от ms. */
const mskYmd = (ms: number, plusDays = 0) => new Date(ms + 3 * 3600_000 + plusDays * 86_400_000).toISOString().slice(0, 10);
/** Срок «до конца окна» (владелец 21.10): окно открыто — последняя отгрузка + 22 дня (не раньше
 *  чем через 2 дня); закрыто — новое окно с сегодняшнего дня, +22 дня. */
function windowEnd(c: KanbanCard): string {
  const now = Date.now();
  if (c.lastDeliveredAt) {
    const end = new Date(c.lastDeliveredAt).getTime() + WINDOW_DAYS * 86_400_000;
    if (end >= now + 2 * 86_400_000) return mskYmd(end);
  }
  return mskYmd(now, WINDOW_DAYS);
}
const fmtYmd = (ymd: string) => ymd.split('-').reverse().join('.');

function DeadlinePicker({ card, value, onChange }: { card: KanbanCard; value: string; onChange: (v: string) => void }) {
  const presets = [
    { label: 'До конца окна', v: windowEnd(card) },
    { label: '+3 дня', v: mskYmd(Date.now(), 3) },
    { label: '+7 дней', v: mskYmd(Date.now(), 7) },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[var(--color-text-secondary)]">Срок задачи (до 19:00)</span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_auto_auto_minmax(0,1fr)]">
        {presets.map(p => (
          <button key={p.label} type="button" onClick={() => onChange(p.v)} className={`${value === p.v ? BTN_ACTIVE : BTN_IDLE} whitespace-nowrap px-2`}>
            {p.label} <span className="opacity-75">· {fmtYmd(p.v).slice(0, 5)}</span>
          </button>
        ))}
        <input type="date" value={value} min={mskYmd(Date.now(), 1)} onChange={e => e.target.value && onChange(e.target.value)} aria-label="Срок задачи" className={`${fieldCls} min-h-11`} />
      </div>
    </div>
  );
}

function OverloadNote({ name, load, limit }: { name: string; load: number; limit: number }) {
  if (load < limit) return <p className="text-xs text-[var(--color-text-muted)]">У {shortName(name)} {load} из {limit} активных задач.</p>;
  return (
    <p className="rounded-lg bg-[#fff2cc] p-2 text-[#7f6000]">
      <AlertTriangle size={13} className="mr-1 inline" />У {shortName(name)} уже {load} активных задач при норме {limit} — менеджер перегружен. Поставить всё равно можно.
    </p>
  );
}

function TaskModal({ card, load, limit, onClose, onSaved }: { card: KanbanCard; load: number; limit: number; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [deadline, setDeadline] = useState(() => windowEnd(card));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ taskId: number; dealId: number; dealMode: string; chatPosted?: boolean } | null>(null);
  // Что произойдёт со сделкой — по правилам ТЗ (engine/createDeal.ts), заранее и честно.
  const what = card.deal ? `Задача в сделку #${card.deal.dealId}, в название — «ПОСМОТРИ ЗАДАЧУ».`
    : card.lastLost ? `Сделка #${card.lastLost.dealId} вернётся из отказа в первую стадию, в название — «ПОСМОТРИ ЗАДАЧУ».`
    : 'Будет создана новая повторная сделка «ПОСМОТРИ ЗАДАЧУ …» (как из контакта).';

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await post({ action: 'create_task', clientKey: card.clientKey, managerId: card.managerId, column: card.column, text, deadline });
      setResult(j); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Задача · ${cardName(card)}`} desktopWidth="sm:max-w-2xl">
      {result ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-text)]">
            {result.dealMode === 'created' ? `Создана сделка #${result.dealId}` : result.dealMode === 'reopened' ? `Сделка #${result.dealId} возвращена из отказа` : `Сделка #${result.dealId}`}
            {' '}и задача в проекте «Повторные продажи», срок {fmtYmd(deadline)}.{text.trim() ? (result.chatPosted ? ' Сообщение — в описании и первым сообщением в чате задачи.' : ' Сообщение — в описании задачи (в чат задачи отправить не удалось).') : ''}
          </p>
          <div className="flex flex-wrap gap-3">
            <a href={taskUrl(result.taskId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"><ExternalLink size={13} /> Задача #{result.taskId}</a>
            <a href={dealUrl(result.dealId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"><ExternalLink size={13} /> Сделка #{result.dealId}</a>
          </div>
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white">Готово</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="rounded-lg bg-[var(--color-bg-surface)] p-3 text-[var(--color-text-secondary)]">
            {what} Исполнитель — ответственный за сделку, закрыть задачу может только постановщик.
            В описание сами добавятся отгрузки заказчика со ссылками и анкета последней отгрузки; сообщение ниже уйдёт и первым сообщением в чат задачи.
          </p>
          <OverloadNote name={card.managerName} load={load} limit={limit} />
          {/* Шаблон (настройки канбана): по умолчанию подставляется отмеченный «по умолчанию»,
              уже заполненный данными заказчика; текст можно править. */}
          <TemplatePicker clientKey={card.clientKey} managerId={card.managerId} value={text} onChange={setText} />
          <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
            Сообщение менеджеру
            <textarea value={text} onChange={e => setText(e.target.value)} rows={10}
              placeholder="У тебя дом без крыши — будет капать дождь — предложи металлочерепицу!" className={`${fieldCls} min-h-[30dvh] resize-y sm:min-h-[240px]`} />
          </label>
          <DeadlinePicker card={card} value={deadline} onChange={setDeadline} />
          {err && <p className="text-[var(--color-negative)]">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
            <button type="button" disabled={busy} onClick={submit}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">
              {busy ? 'Создаю…' : 'Поставить задачу'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Массовая постановка (аудит 21.10): одна задача на каждого выбранного заказчика, сообщение —
 *  выбранный шаблон, заполненный по каждому заказчику на сервере. По одной, с прогрессом: каждая
 *  задача — несколько вызовов Битрикса, пачкой запрос упёрся бы в таймаут прокси. */
function BulkTaskModal({ cards, loadOf, limit, onClose, onDone }: {
  cards: KanbanCard[]; loadOf: (managerId: string) => number; limit: number; onClose: () => void; onDone: () => void;
}) {
  const { data: tpl } = useQuery<{ templates: { id: number; name: string; isDefault: boolean }[] }>({
    queryKey: ['repeat-kanban-templates'],
    queryFn: async () => { const r = await fetch('/api/repeat-kanban/settings'); return r.ok ? r.json() : { templates: [] }; },
    staleTime: 60_000,
  });
  const templates = tpl?.templates ?? [];
  const [templateId, setTemplateId] = useState<string>('');
  const tid = templateId || String(templates.find(t => t.isDefault)?.id ?? templates[0]?.id ?? '');
  const [deadlineMode, setDeadlineMode] = useState<'window' | '3' | '7'>('window');
  const [results, setResults] = useState<Map<string, { ok: boolean; text: string }>>(new Map());
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  // Перегрузка: сколько задач у менеджера станет после постановки.
  const perMgr = new Map<string, { name: string; n: number }>();
  for (const c of cards) { const m = perMgr.get(c.managerId) ?? { name: c.managerName, n: 0 }; m.n++; perMgr.set(c.managerId, m); }
  const over = [...perMgr].filter(([id, m]) => loadOf(id) + m.n > limit);
  const done = results.size;

  const run = async () => {
    setRunning(true); stop.current = false;
    for (const c of cards) {
      if (stop.current) break;
      if (results.get(c.clientKey)?.ok) continue;
      const deadline = deadlineMode === 'window' ? windowEnd(c) : mskYmd(Date.now(), Number(deadlineMode));
      try {
        const j = await post({ action: 'create_task', clientKey: c.clientKey, managerId: c.managerId, column: c.column, text: '', templateId: tid ? Number(tid) : undefined, deadline });
        setResults(m => new Map(m).set(c.clientKey, { ok: true, text: `задача #${j.taskId}` }));
      } catch (e) {
        setResults(m => new Map(m).set(c.clientKey, { ok: false, text: e instanceof Error ? e.message : String(e) }));
      }
    }
    setRunning(false);
  };
  const okCount = [...results.values()].filter(r => r.ok).length;
  const finished = !running && done > 0;

  return (
    <Modal open onOpenChange={o => { if (!o && !running) { if (okCount) onDone(); onClose(); } }} title={`Задачи · ${rub.format(cards.length)} заказчиков`} desktopWidth="sm:max-w-2xl">
      <div className="flex flex-col gap-3 text-sm">
        <p className="rounded-lg bg-[var(--color-bg-surface)] p-3 text-[var(--color-text-secondary)]">
          Каждому заказчику — своя задача в проекте «Повторные продажи» по тем же правилам, что у кнопки на карточке
          (сделка создаётся, возвращается из отказа или берётся текущая). Сообщение — шаблон, заполненный данными каждого заказчика.
        </p>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Шаблон сообщения
          <SearchSelect ariaLabel="Шаблон сообщения" value={tid} onChange={setTemplateId}
            options={templates.length ? templates.map(t => ({ value: String(t.id), label: `${t.name}${t.isDefault ? ' · по умолчанию' : ''}` })) : [{ value: '', label: 'Шаблонов нет — задачи без сообщения' }]}
            className="w-full justify-start bg-[var(--color-bg)]" />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[var(--color-text-secondary)]">Срок задач (до 19:00)</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {([['window', 'До конца окна — у каждого свой'], ['3', '+3 дня'], ['7', '+7 дней']] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => setDeadlineMode(v)} className={deadlineMode === v ? BTN_ACTIVE : BTN_IDLE}>{l}</button>
            ))}
          </div>
        </div>
        {over.length > 0 && (
          <div className="rounded-lg bg-[#fff2cc] p-2 text-[#7f6000]">
            <AlertTriangle size={13} className="mr-1 inline" />Станут перегружены (норма {limit}):{' '}
            {over.map(([id, m]) => `${shortName(m.name)} — ${loadOf(id) + m.n}`).join(', ')}. Поставить всё равно можно.
          </div>
        )}
        {done > 0 && (
          <div className="flex flex-col gap-1">
            <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg-surface)]">
              <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${(done / cards.length) * 100}%` }} />
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">Готово {done} из {cards.length}{okCount < done ? ` · с ошибкой ${done - okCount}` : ''}</div>
            <ul className="max-h-48 overflow-y-auto text-xs">
              {cards.filter(c => results.has(c.clientKey)).map(c => {
                const r = results.get(c.clientKey)!;
                return <li key={c.clientKey} className={r.ok ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-negative)]'}>{cardName(c)} — {r.text}</li>;
              })}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {running ? (
            <button type="button" onClick={() => { stop.current = true; }} className="min-h-11 rounded-lg border border-[var(--color-border)] px-4">Остановить</button>
          ) : (
            <>
              <button type="button" onClick={() => { if (okCount) onDone(); onClose(); }} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{finished ? 'Закрыть' : 'Отмена'}</button>
              {(!finished || okCount < cards.length) && (
                <button type="button" onClick={run} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white">
                  {finished ? 'Повторить ошибочные' : `Поставить ${rub.format(cards.length)} задач`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function HideModal({ card, request = false, onClose, onSaved }: { card: KanbanCard; request?: boolean; onClose: () => void; onSaved: () => void }) {
  const plus = (m: number) => { const d = new Date(Date.now() + 3 * 3600_000); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
  const nextMarch = () => { const d = new Date(Date.now() + 3 * 3600_000); const y = d.getUTCMonth() >= 2 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(); return `${y}-03-01`; };
  const presets = [
    { label: '1 месяц', v: plus(1) }, { label: '3 месяца', v: plus(3) },
    { label: 'До марта', v: nextMarch() }, { label: 'Полгода', v: plus(6) },
  ];
  const [until, setUntil] = useState(presets[1].v);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await post({ action: request ? 'request_hide' : 'hide', clientKey: card.clientKey, managerId: card.managerId, column: card.column, until, comment }); onSaved(); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`${request ? 'Предложить скрыть' : 'Скрыть из пула'} · ${cardName(card)}`} desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-[var(--color-text-secondary)]">{request
          ? 'Предложение уйдёт РОПу: если он согласится, заказчик уйдёт в «Скрытые» и сам вернётся в пул в выбранный день.'
          : 'Заказчик уйдёт в колонку «Скрытые» и сам вернётся в пул в выбранный день.'}</div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[var(--color-text-secondary)]">До какого числа</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {presets.map(p => (
              <button key={p.label} type="button" onClick={() => setUntil(p.v)}
                className={until === p.v ? BTN_ACTIVE : BTN_IDLE}>{p.label}</button>
            ))}
          </div>
          <input type="date" value={until} min={plus(0)} onChange={e => setUntil(e.target.value)} className={`${fieldCls} min-h-11`} />
        </div>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Почему скрываем (обязательно)
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} autoFocus
            placeholder="Вернётся к стройке в следующем году" className={fieldCls} />
        </label>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || comment.trim().length < 3 || !until} onClick={submit}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">{busy ? 'Сохраняю…' : request ? 'Предложить' : 'Скрыть'}</button>
        </div>
      </div>
    </Modal>
  );
}

function BrakNowModal({ card, onClose, onSaved }: { card: KanbanCard; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState<string>('nothing_needed');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await post({ action: 'brak_now', clientKey: card.clientKey, managerId: card.managerId, column: card.column, reason, comment }); onSaved(); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Сразу в брак · ${cardName(card)}`} desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-[var(--color-text-secondary)]">Заказчик уйдёт в «Брак» без разбора отказа. Вернуть можно кнопкой «Снять брак».</div>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Причина
          <SearchSelect ariaLabel="Причина брака" value={reason} onChange={setReason}
            options={BRAK_REASONS.map(r => ({ value: r.value, label: r.label }))} className="w-full justify-start bg-[var(--color-bg)]" />
        </label>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Комментарий
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Подвели с отгрузкой, разовая штукатурка на 10 тыс." className={fieldCls} />
        </label>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy} onClick={submit}
            className="min-h-11 rounded-lg bg-[var(--color-negative)] px-4 text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'В брак'}</button>
        </div>
      </div>
    </Modal>
  );
}

function ReviewModal({ card, onClose, onSaved }: { card: KanbanCard; onClose: () => void; onSaved: () => void }) {
  const [decision, setDecision] = useState<'brak' | 'no_answer' | 'return'>('brak');
  const [reason, setReason] = useState<string>('nothing_needed');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Правило: брак без дозвона и до трёх попыток — только с комментарием РОПа.
  const done = card.attempts?.reached ? TOUCHES : Math.min(card.attempts?.count ?? 0, TOUCHES);
  const needComment = decision === 'brak' && done < TOUCHES;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await post({ action: 'review', clientKey: card.clientKey, managerId: card.managerId, column: card.column, dealId: card.deal?.dealId,
        decision, reason: decision === 'brak' ? reason : null, comment, touchesDone: done });
      onSaved(); onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  const options = card.dozvonFail ? [
    // Выход из дозвона: сделка ещё открыта — «недозвон» оставляет её в дозвоне (ещё попытки).
    { v: 'brak' as const, label: 'Брак', hint: 'Не дозвониться — заказчик уходит из пула (сделку закройте в Битриксе)' },
    { v: 'no_answer' as const, label: 'Ещё попытки', hint: 'Оставить в дозвоне — менеджер звонит дальше' },
    { v: 'return' as const, label: 'Вернуть менеджеру', hint: 'Попытки формальные — пусть отработает заново' },
  ] : [
    { v: 'brak' as const, label: 'Брак', hint: 'Отказ подтверждён — заказчик уходит из пула' },
    { v: 'no_answer' as const, label: 'Недозвон', hint: 'Не брак — вернуть в пул' },
    { v: 'return' as const, label: 'Вернуть менеджеру', hint: 'Отработано плохо — пусть переоткроет сделку' },
  ];

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`${card.dozvonFail ? 'Разбор дозвона' : 'Разбор отказа'} · ${cardName(card)}`} desktopWidth="sm:max-w-lg">
      <div className="flex flex-col gap-3 text-sm">
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-3">
          {card.deal && (
            <a href={dealUrl(card.deal.dealId)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[var(--color-accent)] hover:underline">
              <ExternalLink size={13} /> Сделка #{card.deal.dealId} · {card.deal.stageName}
            </a>
          )}
          <div className="mt-1 text-[var(--color-text-secondary)]">{card.managerName} · {card.dozvonFail ? `${TOUCHES} попытки в разные дни, дозвона нет` : `закрыта ${fmtDay(card.deal?.lostAt ?? null)}`}</div>
          {card.attempts && <div className="mt-2">Попыток связаться: <b>{card.attempts.count}</b>{card.attempts.reached ? ' · дозвонились' : ' · не дозвонились'}{card.attempts.days.length ? ` (${card.attempts.days.map(d => d.split('-').reverse().slice(0, 2).join('.')).join(', ')})` : ''}</div>}
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">Звонки по сделке:</div>
          {card.calls.length === 0 ? <div className="text-[var(--color-negative)]">Звонков нет</div> : (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs">
              {card.calls.map((x, i) => (
                <li key={i} className={x.missed ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]'}>
                  {fmtDT(x.at)} · {x.missed ? 'недозвон' : fmtSec(x.sec)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-2" role="radiogroup">
          {options.map(o => (
            <label key={o.v} className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border p-2 ${decision === o.v ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
              <input type="radio" name="decision" checked={decision === o.v} onChange={() => setDecision(o.v)} className="mt-0.5 h-4 w-4" />
              <span><span className="font-medium text-[var(--color-text)]">{o.label}</span><br /><span className="text-xs text-[var(--color-text-muted)]">{o.hint}</span></span>
            </label>
          ))}
        </div>
        {decision === 'brak' && (
          <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
            Причина
            <SearchSelect ariaLabel="Причина брака" value={reason} onChange={setReason}
              options={BRAK_REASONS.map(r => ({ value: r.value, label: r.label }))}
              className="w-full justify-start bg-[var(--color-bg)]" />
          </label>
        )}
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          {needComment ? `Комментарий (обязательно: попыток ${done} из ${TOUCHES}, без дозвона)` : 'Комментарий'}
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} className={fieldCls} />
        </label>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || (needComment && comment.trim().length < 3)} onClick={submit}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">
            {busy ? 'Сохраняю…' : 'Сохранить решение'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
