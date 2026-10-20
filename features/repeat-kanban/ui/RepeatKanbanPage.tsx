'use client';
// Канбан повторных продаж (решения владельца 20.10, ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md).
// Карточка = заказчик. Колонки двигаются только по данным (отгрузки, стадии сделки,
// звонки) — руками ничего не перетаскивается. Ручные действия: задача (+ сделка в
// Битриксе) от РОПа, «выполнено» от менеджера, разбор отказа РОПом.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Phone, PhoneMissed, ClipboardList, AlertTriangle, Plus } from 'lucide-react';
import { listParam, stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { DepartmentPicker } from '@/features/reports/ui/FilterBar';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { CustomerCardLoader } from '@/features/customers/ui/CustomerCardLoader';
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
const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—');
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} с`);
const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;
const cardName = (c: KanbanCard) => c.name ?? `${c.clientType === 'company' ? 'Компания' : 'Контакт'} #${c.clientId}`;

const GROUPS: { key: ColumnGroup; title: string; hint: string }[] = [
  { key: 'pool', title: 'Пул', hint: 'Нет открытой повторной сделки' },
  { key: 'touch', title: 'Дозвон', hint: `Взят в работу → до ${TOUCHES} попыток связаться (по дням)` },
  { key: 'stage', title: 'Повторная воронка', hint: 'Сделка в работе' },
  { key: 'review', title: 'Разбор', hint: 'Отказы и брак' },
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
  const poolGroups = useMemo(() => pg.split('|').filter(Boolean), [pg]);
  const [limits, setLimits] = useState<Partial<Record<ColumnKey, number>>>({});
  const [openCard, setOpenCard] = useState<KanbanCard | null>(null);
  const [taskFor, setTaskFor] = useState<KanbanCard | null>(null);
  const [reviewFor, setReviewFor] = useState<KanbanCard | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery<RepeatBoard, ApiError>({
    queryKey: ['repeat-kanban', mgrs, type, depts, pg, limits],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (mgrs.length) qs.set('managers', mgrs.join(','));
      if (type) qs.set('type', type);
      if (depts.length) qs.set('dept', depts.join(','));
      if (pg) qs.set('pg', pg);
      for (const [k, v] of Object.entries(limits)) qs.set(`n_${k}`, String(v));
      const r = await fetch(`/api/repeat-kanban?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j.error ?? `Ошибка ${r.status}`);
      return j as RepeatBoard;
    },
    refetchInterval: 120_000,
    retry: false,
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
            <button type="button" onClick={() => refetch()} aria-label="Обновить" title="Обновить"
              className={`${BTN_IDLE} min-w-11 px-0`}>
              <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        {/* Телефон: список вместо семи чипов — чипы занимали весь первый экран. */}
        <label className="sr-only" htmlFor="rpk-type">Тип клиента</label>
        <select id="rpk-type" value={type} onChange={e => { setType(e.target.value); setLimits({}); }}
          className={`${BTN_IDLE} w-full text-base sm:hidden`}>
          {typeChips.map(t => (
            <option key={t.key || 'all'} value={t.key}>{t.label} · {rub.format(t.key ? data?.typeCounts[t.key] ?? 0 : totalAll)}</option>
          ))}
        </select>
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

        <nav className="flex min-w-0 flex-wrap gap-2" aria-label="Перейти к группе колонок">
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

        {data?.kpi && <KpiStrip k={data.kpi} />}

        {error && error.status !== 403 && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
        {data?.notice && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">{data.notice}</div>}
        {isLoading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Собираю доску — первый раз по команде это до полуминуты…</div>}

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
                      onOpen={setOpenCard} onTask={setTaskFor} onReview={setReviewFor}
                      onUnbrak={async c => { if (confirm(`Снять брак с «${cardName(c)}»? Заказчик вернётся в пул.`)) { await post({ action: 'unbrak', clientKey: c.clientKey, managerId: c.managerId }).catch(e => alert(e.message)); refresh(); } }}
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
      {taskFor && <TaskModal card={taskFor} onClose={() => setTaskFor(null)} onSaved={refresh} />}
      {reviewFor && <ReviewModal card={reviewFor} onClose={() => setReviewFor(null)} onSaved={refresh} />}
    </div>
  );
}

function Column({ def, col, canManage, onMore, onOpen, onTask, onReview, onUnbrak }: {
  def: ColumnDef; col: KanbanColumn | undefined; canManage: boolean;
  onMore: () => void; onOpen: (c: KanbanCard) => void; onTask: (c: KanbanCard) => void;
  onReview: (c: KanbanCard) => void; onUnbrak: (c: KanbanCard) => void;
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
            onOpen={() => onOpen(c)} onTask={() => onTask(c)} onReview={() => onReview(c)} onUnbrak={() => onUnbrak(c)} />
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
function KpiStrip({ k }: { k: BoardKpi }) {
  const items: { label: string; value: string; hint: string; tone?: 'neg' | 'warn' }[] = [
    { label: 'Пул', value: `${rub.format(k.pool)} · ${moneyShort(k.poolPotential)}`, hint: 'Заказчиков без открытой повторной сделки и их потенциал на 12 мес. — сколько денег «лежит»' },
    { label: 'В дозвоне', value: `${rub.format(k.inWork)} · ${moneyShort(k.inWorkPotential)}`, hint: 'Взяты в работу и в попытках связаться — сколько денег «обрабатывается»' },
    { label: 'Дозвонились', value: k.inWork ? `${rub.format(k.reached)} из ${rub.format(k.inWork)} · ${Math.round((k.reached / k.inWork) * 100)}%` : '—', hint: 'Среди тех, кто в дозвоне: был разговор дольше 20 с или ручной контакт' },
    { label: 'В воронке', value: `${rub.format(k.funnel)} · ${moneyShort(k.funnelSum)}`, hint: 'Повторные сделки в работе и их сумма (реальные деньги сделок, не потенциал)' },
    { label: 'Задачи', value: `просрочено ${k.tasksOverdue} · ждут приёмки ${k.tasksControl}`, hint: 'Просроченные задачи проекта «Повторные продажи» и задачи, которые менеджер сдал, а постановщик не принял', tone: k.tasksOverdue ? 'neg' : undefined },
    { label: 'Без задачи', value: rub.format(k.noTaskInWork), hint: 'Сделки в дозвоне и воронке, по которым нет открытой задачи', tone: k.noTaskInWork ? 'warn' : undefined },
    { label: 'Отказы на проверке', value: `${rub.format(k.review)}${k.reviewEarly ? ` · ${k.reviewEarly} до 3 попыток` : ''}`, hint: 'Ждут решения РОПа; «до 3 попыток» — закрыты, не дозвонившись и не сделав трёх попыток', tone: k.reviewEarly ? 'neg' : undefined },
    { label: 'Брак', value: rub.format(k.brak), hint: 'Отказ подтверждён РОПом' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      {items.map(i => (
        <div key={i.label} title={i.hint} className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2.5 py-1.5">
          <div className="truncate text-[11px] text-[var(--color-text-muted)]">{i.label}</div>
          <div className="truncate text-[13px] font-semibold tabular-nums" style={i.tone === 'neg' ? { color: 'var(--color-negative)' } : i.tone === 'warn' ? { color: '#b45f06' } : undefined}>{i.value}</div>
        </div>
      ))}
    </div>
  );
}

const moneyShort = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} млн ₽` : n >= 1000 ? `${Math.round(n / 1000)} тыс. ₽` : `${rub.format(n)} ₽`);

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
          потенциал ~{moneyShort(p.value)}
        </button>
      }>
      <div className="flex flex-col gap-1.5 text-[var(--color-text)]">
        <div className="font-semibold">Потенциал на 12 месяцев ≈ {money(p.value)}</div>
        <div className="text-[var(--color-text-secondary)]">
          Сколько в среднем приносят за следующий год заказчики с {BUCKET_LABEL[p.bucket] ?? `${p.bucket} покупками`} ({p.b2b ? 'юрлица' : 'физлица'}) — по всей истории продаж, {rub.format(p.n)} таких случаев:
        </div>
        <div className="rounded-md bg-[var(--color-bg-surface)] px-2 py-1.5 tabular-nums">
          <div>вернулись и купили ещё в течение года — <b>{pct(p.conv)}</b></div>
          <div>средняя выручка вернувшегося за год — <b>{money(p.avgReturned)}</b></div>
          <div className="mt-1 border-t border-[var(--color-border)] pt-1"><b>{pct(p.conv)} × {moneyShort(p.avgReturned)} ≈ {moneyShort(p.value)}</b></div>
        </div>
        <div className="text-[11.5px] text-[var(--color-text-muted)]">
          Учтены и те, кто не вернулся (у них ноль). Покупки — склеенные по правилу повторной продажи; крупные выбросы срезаны по 95-му перцентилю сегмента.
          {c.repeatChance !== null && <> Шанс следующей отгрузки за 180 дн. — {pct(c.repeatChance)}{c.expectedValue !== null ? `, ожидаемая следующая покупка — ${moneyShort(Math.round(c.expectedValue))}` : ''}.</>}
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
  if (c.sleeping && col.startsWith('pool')) a.push({ text: 'Спит', red: false });
  return a;
}

function Card({ c, col, canManage, onOpen, onTask, onReview, onUnbrak }: {
  c: KanbanCard; col: ColumnKey; canManage: boolean;
  onOpen: () => void; onTask: () => void; onReview: () => void; onUnbrak: () => void;
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
        <TypeChip type={c.profileType} />
      </div>
      <div className="truncate text-[11.5px] text-[var(--color-text-muted)]">{c.managerName}</div>

      {/* 2. Деньги. */}
      <div className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
        <span>{c.purchases} {plural(c.purchases, 'отгрузка', 'отгрузки', 'отгрузок')} · {moneyShort(c.sumDelivered)}</span>
        {c.potentialInfo && <>· <PotentialBadge c={c} /></>}
      </div>

      {/* 3. Последняя покупка. */}
      <div className="text-[var(--color-text-secondary)]">
        {c.lastDeliveredAt ? <>{fmtDay(c.lastDeliveredAt)} · {c.lastDeliveredGroup ?? 'без группы'} · <span style={old !== null && old > 120 ? { color: '#b45f06', fontWeight: 600 } : undefined}>{old} дн.</span></> : 'Отгрузок не было'}
      </div>

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

      {/* Действие. */}
      <div className="flex flex-wrap gap-2 pt-0.5">
        {canManage && col !== 'review' && col !== 'brak' && col !== 'st_sold' && (
          <button type="button" onClick={onTask}
            className={`inline-flex min-h-11 items-center gap-1 rounded-md px-2.5 text-xs hover:opacity-90 ${c.task && c.task.state !== 'done' ? 'bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'}`}>
            <Plus size={13} /> {dealLabel}
          </button>
        )}
        {canManage && col === 'review' && (
          <button type="button" onClick={onReview}
            className="inline-flex min-h-11 items-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 text-xs text-white hover:opacity-90">
            Разобрать отказ
          </button>
        )}
        {canManage && col === 'brak' && (
          <button type="button" onClick={onUnbrak}
            className="inline-flex min-h-11 items-center rounded-md px-2.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
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
  const [result, setResult] = useState<{ taskId: number; dealId: number; dealMode: string } | null>(null);
  // Что произойдёт со сделкой — по правилам ТЗ (engine/createDeal.ts), заранее и честно.
  const what = card.deal ? `Задача в сделку #${card.deal.dealId}, в название — «ПОСМОТРИ ЗАДАЧУ».`
    : card.lastLost ? `Сделка #${card.lastLost.dealId} вернётся из отказа в первую стадию, в название — «ПОСМОТРИ ЗАДАЧУ».`
    : 'Будет создана новая повторная сделка «ПОСМОТРИ ЗАДАЧУ …» (как из контакта).';

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await post({ action: 'create_task', clientKey: card.clientKey, managerId: card.managerId, text });
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
            {' '}и задача в проекте «Повторные продажи».
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
            В текст сами добавятся отгрузки заказчика со ссылками и анкета последней отгрузки.
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
      await post({ action: 'review', clientKey: card.clientKey, managerId: card.managerId, dealId: card.deal?.dealId,
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
            <select value={reason} onChange={e => setReason(e.target.value)} className={`${fieldCls} min-h-11`}>
              {BRAK_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
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
