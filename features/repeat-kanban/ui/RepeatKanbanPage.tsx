'use client';
// Канбан повторных продаж (решения владельца 20.10, ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md).
// Карточка = заказчик. Колонки двигаются только по данным (отгрузки, стадии сделки,
// звонки) — руками ничего не перетаскивается. Ручные действия: задача (+ сделка в
// Битриксе) от РОПа, «выполнено» от менеджера, разбор отказа РОПом.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import dynamic from 'next/dynamic';

// Карточка сделки — динамически: она сама открывает карточку клиента (цикл модулей).
const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });
import {
  BRAK_REASONS, CLIENT_TYPE_ORDER, CLIENT_TYPE_STYLE, taskUrl, CLIENT_TYPE_SHORT, COLUMNS, TOUCHES,
  type ColumnDef, type ColumnGroup, type ColumnKey,
} from '../engine/config';
import type { BoardKpi, KanbanCard, KanbanColumn, RepeatBoard } from '../engine/board';
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
] as const;

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
  const poolGroups = useMemo(() => pg.split('|').filter(Boolean), [pg]);
  const [limits, setLimits] = useState<Partial<Record<ColumnKey, number>>>({});
  const [openCard, setOpenCard] = useState<KanbanCard | null>(null);
  const [openDeal, setOpenDeal] = useState<number | null>(null);
  const [taskFor, setTaskFor] = useState<KanbanCard | null>(null);
  const [reviewFor, setReviewFor] = useState<KanbanCard | null>(null);
  const [hideFor, setHideFor] = useState<KanbanCard | null>(null);
  const [brakFor, setBrakFor] = useState<KanbanCard | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery<RepeatBoard, ApiError>({
    queryKey: ['repeat-kanban', mgrs, type, depts, pg, taskF, sort, limits],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (mgrs.length) qs.set('managers', mgrs.join(','));
      if (type) qs.set('type', type);
      if (depts.length) qs.set('dept', depts.join(','));
      if (pg) qs.set('pg', pg);
      if (taskF.length) qs.set('tasks', taskF.join(','));
      if (sort !== 'default') qs.set('sort', sort);
      for (const [k, v] of Object.entries(limits)) qs.set(`n_${k}`, String(v));
      const r = await fetch(`/api/repeat-kanban?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j.error ?? `Ошибка ${r.status}`);
      return j as RepeatBoard;
    },
    refetchInterval: 120_000,
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
  const { data: meta } = useQuery<{ managers: { id: string; name: string }[] }>({
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
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Отделы и менеджеры работают вместе: отделы сужают список менеджеров, внутри
                можно отметить нескольких; не отмечен никто — все менеджеры отделов/зоны. */}
            <DepartmentPicker departmentIds={depts} onDepartmentIdsChange={ids => { setDepts(ids); setMgrs([]); setLimits({}); }} triggerClassName={depts.length ? BTN_ACTIVE : BTN_IDLE} />
            {managerOptions.length > 0 && (
              <SearchMultiSelect ariaLabel="Менеджеры" allLabel={depts.length ? 'Все менеджеры отделов' : 'Все менеджеры зоны'}
                unitLabel="менеджеров" searchPlaceholder="Поиск менеджера"
                options={managerOptions.map(m => ({ value: m.id, label: m.name }))}
                value={mgrs} onChange={v => { setMgrs(v); setLimits({}); }}
                className={`${mgrs.length ? BTN_ACTIVE : BTN_IDLE} w-[60vw] max-w-xs justify-start sm:w-64`} />
            )}
            <Link href="/repeat-kanban/analytics" className={BTN_IDLE} title="Кто что делал, проработанность пула по отделам, журнал">
              <BarChart3 size={16} /> Аналитика
            </Link>
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
          {GROUPS.map(g => (
            <button key={g.key} type="button" onClick={() => jump(g.key)} title={g.hint}
              className={BTN_IDLE}>
              {g.title}
            </button>
          ))}
        </nav>

        {data?.kpi && <KpiStrip k={data.kpi} activeTask={taskF.length === 1 ? taskF[0] : null}
          onTask={tb => { const on = taskF.length === 1 && taskF[0] === tb; setTaskF(on ? [] : [tb]); setSort(on ? 'default' : 'task'); setLimits({}); }}
          onJump={jump} />}

        {error && error.status !== 403 && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
        {data?.notice && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">{data.notice}</div>}
        {(isLoading || (isFetching && !data && !error)) && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Собираю доску — первый раз по команде это до полуминуты…</div>}

      </div>

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
                    <Column key={def.key} def={def} col={byKey.get(def.key)} canManage={!!data?.canManage}
                      onMore={() => setLimits(l => ({ ...l, [def.key]: (l[def.key] ?? PAGE) + PAGE }))}
                      onOpen={setOpenCard} onTask={setTaskFor} onReview={setReviewFor} onDeal={setOpenDeal}
                      viewerId={data?.viewerBitrixId ?? null}
                      onAct={async (a, c) => {
                        if (a === 'hide') setHideFor(c);
                        else if (a === 'brak_now') setBrakFor(c);
                        else if (confirm(`Вернуть «${cardName(c)}» в пул раньше срока?`)) { await post({ action: 'unhide', clientKey: c.clientKey, managerId: c.managerId, column: c.column }).catch(e => alert(e.message)); refresh(); }
                      }}
                      onUnbrak={async c => { if (confirm(`Снять брак с «${cardName(c)}»? Заказчик вернётся в пул.`)) { await post({ action: 'unbrak', clientKey: c.clientKey, managerId: c.managerId, column: c.column }).catch(e => alert(e.message)); refresh(); } }}
                    />
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

      {openCard && (
        <CustomerCardLoader
          contactId={openCard.clientType === 'contact' ? openCard.clientId : null}
          companyId={openCard.clientType === 'company' ? openCard.clientId : null}
          onClose={() => setOpenCard(null)} />
      )}
      {openDeal !== null && <DealCard dealId={openDeal} onClose={() => setOpenDeal(null)} />}
      {taskFor && <TaskModal card={taskFor} onClose={() => setTaskFor(null)} onSaved={refresh} />}
      {reviewFor && <ReviewModal card={reviewFor} onClose={() => setReviewFor(null)} onSaved={refresh} />}
      {hideFor && <HideModal card={hideFor} onClose={() => setHideFor(null)} onSaved={refresh} />}
      {brakFor && <BrakNowModal card={brakFor} onClose={() => setBrakFor(null)} onSaved={refresh} />}
    </div>
  );
}

function Column({ def, col, canManage, viewerId, onMore, onOpen, onTask, onReview, onUnbrak, onDeal, onAct }: {
  def: ColumnDef; col: KanbanColumn | undefined; canManage: boolean; viewerId: string | null;
  onAct: (a: CardAction, c: KanbanCard) => void;
  onMore: () => void; onOpen: (c: KanbanCard) => void; onTask: (c: KanbanCard) => void;
  onReview: (c: KanbanCard) => void; onUnbrak: (c: KanbanCard) => void; onDeal: (dealId: number) => void;
}) {
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
      </div>
      {/* Карточки скроллятся внутри колонки — колонка на всю высоту экрана. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {col?.cards.map(c => (
          <Card key={c.clientKey} c={c} col={def.key} canManage={canManage}
            onOpen={() => onOpen(c)} onTask={() => onTask(c)} onReview={() => onReview(c)} onUnbrak={() => onUnbrak(c)} onDeal={onDeal}
            canHide={canManage || (!!viewerId && c.managerId === viewerId)} onAct={a => onAct(a, c)} />
        ))}
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
/** Проработанность канбана (владелец 20.10): доля заказчиков НЕ в пуле среди всех, кроме брака.
 *  Проработан = взят в работу / в воронке / отказ на проверке / скрыт с решением; 100 % — пул пуст. */
function WorkedRing({ k }: { k: BoardKpi }) {
  const total = k.pool + k.inWork + k.funnel + k.review + k.hidden;
  const worked = total - k.pool;
  const share = total ? worked / total : 0;
  const r = 26, c = 2 * Math.PI * r;
  return (
    <div className="flex shrink-0 flex-col items-center"
      title={`Проработано ${rub.format(worked)} из ${rub.format(total)} заказчиков (без брака): в дозвоне ${k.inWork}, в воронке ${k.funnel}, отказы на проверке ${k.review}, скрыты ${k.hidden}. В пуле осталось ${k.pool}. 100% — пул пуст, все в работе.`}>
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
const moneyShort = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')}\u00a0млн\u00a0₽` : n >= 1000 ? `${Math.round(n / 1000)}\u00a0тыс.\u00a0₽` : `${rub.format(n)}\u00a0₽`);

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

type CardAction = 'hide' | 'brak_now' | 'unhide';

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

function Card({ c, col, canManage, canHide, onOpen, onTask, onReview, onUnbrak, onDeal, onAct }: {
  c: KanbanCard; col: ColumnKey; canManage: boolean;
  /** «Скрыть из пула» — РОП или менеджер по своему заказчику. */
  canHide: boolean;
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

  return (
    <article className="flex shrink-0 flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[12.5px]">
      {/* 1. Шапка: имя + тип; менеджер. */}
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 text-left text-sm font-semibold text-[var(--color-text)] hover:text-[var(--color-accent)]">
          <span className="line-clamp-2">{cardName(c)}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <TypeChip type={c.profileType} />
          <CardMenu items={[
            ...(col.startsWith('pool') && canHide ? [{ label: 'Скрыть из пула', act: 'hide' as const }] : []),
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
            Разобрать отказ
          </button>
        )}
        {col === 'hidden' && canHide && (
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

function TaskModal({ card, onClose, onSaved }: { card: KanbanCard; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
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
      const j = await post({ action: 'create_task', clientKey: card.clientKey, managerId: card.managerId, column: card.column, text });
      setResult(j); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Задача · ${cardName(card)}`} desktopWidth="sm:max-w-lg">
      {result ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-text)]">
            {result.dealMode === 'created' ? `Создана сделка #${result.dealId}` : result.dealMode === 'reopened' ? `Сделка #${result.dealId} возвращена из отказа` : `Сделка #${result.dealId}`}
            {' '}и задача в проекте «Повторные продажи».{text.trim() ? (result.chatPosted ? ' Комментарий — в описании и первым сообщением в чате задачи.' : ' Комментарий — в описании задачи (в чат задачи отправить не удалось).') : ''}
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
            {what} Исполнитель — ответственный за сделку, срок 5 дней, закрыть задачу может только постановщик.
            В текст сами добавятся отгрузки заказчика со ссылками и анкета последней отгрузки; комментарий уйдёт и первым сообщением в чат задачи.
          </p>
          <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
            Комментарий менеджеру
            <textarea value={text} onChange={e => setText(e.target.value)} rows={4} autoFocus
              placeholder="У тебя дом без крыши — будет капать дождь — предложи металлочерепицу!" className={fieldCls} />
          </label>
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

function HideModal({ card, onClose, onSaved }: { card: KanbanCard; onClose: () => void; onSaved: () => void }) {
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
    try { await post({ action: 'hide', clientKey: card.clientKey, managerId: card.managerId, column: card.column, until, comment }); onSaved(); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Скрыть из пула · ${cardName(card)}`} desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-[var(--color-text-secondary)]">Заказчик уйдёт в колонку «Скрытые» и сам вернётся в пул в выбранный день.</div>
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
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">{busy ? 'Скрываю…' : 'Скрыть'}</button>
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

  const options = [
    { v: 'brak' as const, label: 'Брак', hint: 'Отказ подтверждён — заказчик уходит из пула' },
    { v: 'no_answer' as const, label: 'Недозвон', hint: 'Не брак — вернуть в пул' },
    { v: 'return' as const, label: 'Вернуть менеджеру', hint: 'Отработано плохо — пусть переоткроет сделку' },
  ];

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Разбор отказа · ${cardName(card)}`} desktopWidth="sm:max-w-lg">
      <div className="flex flex-col gap-3 text-sm">
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-3">
          {card.deal && (
            <a href={dealUrl(card.deal.dealId)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[var(--color-accent)] hover:underline">
              <ExternalLink size={13} /> Сделка #{card.deal.dealId} · {card.deal.stageName}
            </a>
          )}
          <div className="mt-1 text-[var(--color-text-secondary)]">{card.managerName} · закрыта {fmtDay(card.deal?.lostAt ?? null)}</div>
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
