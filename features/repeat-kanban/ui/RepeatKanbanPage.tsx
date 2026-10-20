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
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { CustomerCardLoader } from '@/features/customers/ui/CustomerCardLoader';
import {
  BRAK_REASONS, CLIENT_TYPE_ORDER, taskUrl, CLIENT_TYPE_SHORT, COLUMNS, TOUCHES, WINDOW_DAYS,
  type ColumnDef, type ColumnGroup, type ColumnKey,
} from '../engine/config';
import type { KanbanCard, KanbanColumn, RepeatBoard } from '../engine/board';
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
  { key: 'touch', title: `Окно ${WINDOW_DAYS} дня`, hint: `${TOUCHES} недели — по контакту на каждой` },
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
  const [limits, setLimits] = useState<Partial<Record<ColumnKey, number>>>({});
  const [openCard, setOpenCard] = useState<KanbanCard | null>(null);
  const [taskFor, setTaskFor] = useState<KanbanCard | null>(null);
  const [reviewFor, setReviewFor] = useState<KanbanCard | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery<RepeatBoard, ApiError>({
    queryKey: ['repeat-kanban', mgrs, type, depts, limits],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (mgrs.length) qs.set('managers', mgrs.join(','));
      if (type) qs.set('type', type);
      if (depts.length) qs.set('dept', depts.join(','));
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
          {GROUPS.map(g => (
            <button key={g.key} type="button" onClick={() => jump(g.key)} title={g.hint}
              className={BTN_IDLE}>
              {g.title}
            </button>
          ))}
        </nav>

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
  const tone = def.key === 'brak' ? 'var(--color-negative)' : def.key === 'review' ? '#d97706' : def.key === 'touch_3' ? 'var(--color-positive)' : 'var(--color-accent)';
  return (
    <div className="flex h-full w-72 max-w-[85vw] shrink-0 flex-col gap-2 rounded-xl bg-[var(--color-bg-surface)] p-2">
      <div className="rounded-lg px-2 py-1.5" style={{ borderLeft: `3px solid ${tone}` }} title={def.hint}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-[var(--color-text)]">{def.title}</span>
          <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{col ? rub.format(col.total) : '…'}</span>
        </div>
        {col && col.sum > 0 && <div className="text-xs text-[var(--color-text-muted)]">в сделках {money(col.sum)}</div>}
      </div>
      {/* Карточки скроллятся внутри колонки — колонка на всю высоту экрана. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      {col?.cards.map(c => (
        <Card key={c.clientKey} c={c} col={def.key} canManage={canManage}
          onOpen={() => onOpen(c)} onTask={() => onTask(c)} onReview={() => onReview(c)} onUnbrak={() => onUnbrak(c)} />
      ))}
      {col && col.total > col.cards.length && (
        <button type="button" onClick={onMore}
          className="min-h-11 rounded-lg text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          Показать ещё · осталось {rub.format(col.total - col.cards.length)}
        </button>
      )}
      </div>
      {col && col.total === 0 && <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">Пусто</div>}
    </div>
  );
}

function WeekDots({ w }: { w: NonNullable<KanbanCard['window']> }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
      {w.weeks.map((on, i) => {
        const current = w.weekNo === i + 1;
        return (
          <span key={i} title={`Неделя ${i + 1}: ${on ? 'контакт был' : 'контакта нет'}`}
            className={`inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[11px] ${on ? 'bg-[var(--color-positive)] text-white' : current ? 'border border-[var(--color-accent)] text-[var(--color-accent)]' : 'border border-[var(--color-border)]'}`}>
            {i + 1}
          </span>
        );
      })}
      <span>{w.closed ? 'окно закрыто' : `день ${Math.min(WINDOW_DAYS, daysAgo(w.startAt) + 1)} из ${WINDOW_DAYS}`}</span>
    </div>
  );
}

const TASK_STATE: Record<RepeatTask['state'], { label: string; tone: string }> = {
  unread: { label: 'не просмотрена', tone: 'var(--color-negative)' },
  pending: { label: 'просмотрена, не начата', tone: 'var(--color-text-muted)' },
  in_progress: { label: 'в работе', tone: 'var(--color-accent)' },
  control: { label: 'ждёт контроля', tone: '#d97706' },
  done: { label: 'принята', tone: 'var(--color-positive)' },
  deferred: { label: 'отложена', tone: 'var(--color-text-muted)' },
};

function TaskLine({ t, c }: { t: RepeatTask; c: KanbanCard }) {
  const callAfter = c.calls.some(x => !x.missed && x.sec > 20 && x.at > t.createdAt);
  const open = t.state !== 'done' && t.state !== 'control';
  const overdue = open && t.deadlineAt && new Date(t.deadlineAt).getTime() < Date.now();
  const controlDays = t.state === 'control' && t.changedAt ? daysAgo(t.changedAt) : null;
  const doneNoCall = (t.state === 'control' || t.state === 'done') && !callAfter;
  const st = TASK_STATE[t.state];
  return (
    <a href={taskUrl(t.id)} target="_blank" rel="noreferrer"
      className={`block rounded-md px-2 py-1 text-xs hover:opacity-90 ${overdue || doneNoCall || t.state === 'unread' ? 'bg-[var(--color-negative-soft)]' : 'bg-[var(--color-bg)]'}`}>
      <div className="flex items-center gap-1.5">
        <ClipboardList size={13} className="shrink-0" style={{ color: st.tone }} />
        <span style={{ color: st.tone }}>Задача {st.label}</span>
        <span title={callAfter ? 'Был звонок после постановки' : 'Звонка после постановки нет'}
          className={callAfter ? 'text-[var(--color-positive)]' : 'text-[var(--color-text-muted)] opacity-60'}><Phone size={12} /></span>
      </div>
      <div className="mt-0.5 text-[var(--color-text-muted)]">
        {fmtDay(t.createdAt)} · {t.createdByName ?? `#${t.createdById}`} → {t.responsibleName ?? `#${t.responsibleId}`}
        {t.deadlineAt && open ? ` · срок ${fmtDay(t.deadlineAt)}` : ''}
      </div>
      {overdue && <div className="text-[var(--color-negative)]">Просрочена</div>}
      {controlDays !== null && controlDays >= 1 && <div className="text-[#d97706]">Ждёт приёмки постановщиком {controlDays} дн.</div>}
      {doneNoCall && <div className="text-[var(--color-negative)]">Отмечена выполненной, но звонка нет</div>}
    </a>
  );
}

function Card({ c, col, canManage, onOpen, onTask, onReview, onUnbrak }: {
  c: KanbanCard; col: ColumnKey; canManage: boolean;
  onOpen: () => void; onTask: () => void; onReview: () => void; onUnbrak: () => void;
}) {
  const good = c.calls.filter(x => !x.missed && x.sec > 20);
  const isPool = col.startsWith('pool');
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 text-left font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]">
          <span className="line-clamp-2">{cardName(c)}</span>
        </button>
        {c.profileType && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${c.profileType === 'foreman' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'}`}>
            {CLIENT_TYPE_SHORT[c.profileType] ?? c.profileType}
          </span>
        )}
      </div>
      <div className="text-xs text-[var(--color-text-muted)]">{c.managerName}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--color-text-secondary)]">
        <span>{c.purchases} {c.purchases === 1 ? 'отгрузка' : c.purchases < 5 ? 'отгрузки' : 'отгрузок'} · {money(c.sumDelivered)}</span>
        {c.repeatChance !== null && <span title="Шанс следующей отгрузки за 180 дней">шанс {Math.round(c.repeatChance * 100)}%</span>}
      </div>
      {c.lastDeliveredAt && (
        <div className="text-xs text-[var(--color-text-muted)]">
          Последняя: {fmtDay(c.lastDeliveredAt)}{c.lastDeliveredGroup ? ` · ${c.lastDeliveredGroup}` : ''}
          {isPool && <> · {daysAgo(c.lastDeliveredAt)} дн. назад</>}
        </div>
      )}
      {c.sleeping && isPool && <div className="text-xs text-[var(--color-text-muted)]">Спит: давно без покупок</div>}
      {c.deal && (
        <a href={dealUrl(c.deal.dealId)} target="_blank" rel="noreferrer"
          className="flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline">
          <ExternalLink size={12} /> <span className="truncate">#{c.deal.dealId} · {c.deal.stageName ?? c.deal.stageId}</span>
        </a>
      )}
      {c.lastLost && (
        <a href={dealUrl(c.lastLost.dealId)} target="_blank" rel="noreferrer"
          className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:underline">
          <ExternalLink size={12} /> <span className="truncate">Последний отказ {fmtDay(c.lastLost.lostAt)} · {c.lastLost.stageName ?? c.lastLost.stageId}</span>
        </a>
      )}
      {c.window && <WeekDots w={c.window} />}
      {(good.length > 0 || c.missedCalls > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 text-xs text-[var(--color-text-secondary)]">
          {good.length > 0 && <span className="inline-flex items-center gap-1"><Phone size={12} /> {good.length} · последний {fmtDT(good[0].at)} ({fmtSec(good[0].sec)})</span>}
          {c.missedCalls > 0 && <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"><PhoneMissed size={12} /> недозвонов {c.missedCalls}</span>}
        </div>
      )}
      {c.task && <TaskLine t={c.task} c={c} />}
      {col === 'review' && c.lostEarly && (
        <div className="flex items-center gap-1 rounded-md bg-[var(--color-negative-soft)] px-2 py-1 text-xs text-[var(--color-negative)]">
          <AlertTriangle size={12} /> Закрыто после {c.window?.done ?? 0} из {TOUCHES} недель контакта
        </div>
      )}
      {c.review?.decision === 'return' && col === 'review' && (
        <div className="text-xs text-[#d97706]">Возвращено менеджеру {fmtDay(c.review.decidedAt)} · {c.review.decidedBy}</div>
      )}
      {c.brak && (
        <div className="text-xs text-[var(--color-negative)]">{c.brak.comment ?? 'Брак'} · {c.brak.by}, {fmtDay(c.brak.at)}</div>
      )}

      <div className="flex flex-wrap gap-2 pt-0.5">
        {canManage && col !== 'review' && col !== 'brak' && (
          <button type="button" onClick={onTask}
            className="inline-flex min-h-11 items-center gap-1 rounded-md bg-[var(--color-accent-soft)] px-2.5 text-xs text-[var(--color-accent)] hover:opacity-90">
            <Plus size={13} /> Задача
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
  const done = card.window?.done ?? 0;
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
          {card.window && <div className="mt-2"><WeekDots w={card.window} /></div>}
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
          {needComment ? `Комментарий (обязательно: контактов ${done} из ${TOUCHES})` : 'Комментарий'}
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
