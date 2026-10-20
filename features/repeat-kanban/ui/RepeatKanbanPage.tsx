'use client';
// Канбан повторных продаж (решения владельца 20.10, ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md).
// Карточка = заказчик. Колонки двигаются только по данным (отгрузки, стадии сделки,
// звонки) — руками ничего не перетаскивается. Ручные действия: задача (+ сделка в
// Битриксе) от РОПа, «выполнено» от менеджера, разбор отказа РОПом.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, Phone, PhoneMissed, ClipboardList, Eye, CheckCircle2, AlertTriangle, Plus } from 'lucide-react';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Modal } from '@/components/ui/Modal';
import { CustomerCardLoader } from '@/features/customers/ui/CustomerCardLoader';
import {
  BRAK_REASONS, CLIENT_TYPE_ORDER, CLIENT_TYPE_SHORT, COLUMNS, TOUCHES, WINDOW_DAYS,
  type ColumnDef, type ColumnGroup, type ColumnKey,
} from '../engine/config';
import type { KanbanCard, KanbanColumn, RepeatBoard } from '../engine/board';
import type { RepeatTask } from '../engine/tasks';

const PAGE = 40;
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
  const [manager, setManager] = useUrlState('manager', stringParam(''));
  const [type, setType] = useUrlState('type', stringParam(''));
  const [taskParam, setTaskParam] = useUrlState('task', stringParam(''));
  const [limits, setLimits] = useState<Partial<Record<ColumnKey, number>>>({});
  const [openCard, setOpenCard] = useState<KanbanCard | null>(null);
  const [taskFor, setTaskFor] = useState<KanbanCard | null>(null);
  const [reviewFor, setReviewFor] = useState<KanbanCard | null>(null);
  const [viewTask, setViewTask] = useState<{ task: RepeatTask; own: boolean } | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery<RepeatBoard, ApiError>({
    queryKey: ['repeat-kanban', manager, type, limits],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (manager) qs.set('manager', manager);
      if (type) qs.set('type', type);
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

  // Заход по ссылке из бота (?task=ID): исполнитель — «прочитано» и окно задачи.
  useEffect(() => {
    if (!/^\d+$/.test(taskParam)) return;
    let alive = true;
    post({ action: 'task_read', id: Number(taskParam) })
      .then(j => { if (alive) setViewTask({ task: j.task, own: j.own }); qc.invalidateQueries({ queryKey: ['repeat-kanban'] }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [taskParam, qc]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['repeat-kanban'] });
  const byKey = useMemo(() => new Map<string, KanbanColumn>((data?.columns ?? []).map(c => [c.key, c])), [data]);
  const boardRef = useRef<HTMLDivElement>(null);
  const jump = (g: ColumnGroup) => {
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-group="${g}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };

  if (error?.status === 403) return <AccessDenied reason="Канбан повторных продаж открыт ролям продаж." />;

  const typeChips = [
    { key: '', label: 'Все' },
    ...Object.keys(CLIENT_TYPE_ORDER).sort((a, b) => CLIENT_TYPE_ORDER[a] - CLIENT_TYPE_ORDER[b]).map(k => ({ key: k, label: CLIENT_TYPE_SHORT[k] })),
    { key: 'none', label: 'Тип не указан' },
  ];
  const totalAll = Object.values(data?.typeCounts ?? {}).reduce((s, n) => s + n, 0);

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex min-w-0 max-w-[2400px] flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-[var(--color-text)]">Канбан повторных продаж</h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Карточки двигаются сами — по отгрузкам, стадиям сделки и звонкам.
              {data ? ` Обновлено ${fmtDT(data.generatedAt)}.` : ''}
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            {(data?.managers.length ?? 0) > 1 && (
              <>
                <label className="sr-only" htmlFor="rpk-manager">Менеджер</label>
                <select id="rpk-manager" value={manager} onChange={e => { setManager(e.target.value); setLimits({}); }}
                  className="min-h-11 min-w-0 max-w-[60vw] rounded-lg bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] sm:max-w-xs sm:text-sm">
                  <option value="">Все менеджеры зоны</option>
                  {data!.managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </>
            )}
            <button type="button" onClick={() => refetch()} aria-label="Обновить" title="Обновить"
              className="tap-target flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
              <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        {/* Телефон: список вместо семи чипов — чипы занимали весь первый экран. */}
        <label className="sr-only" htmlFor="rpk-type">Тип клиента</label>
        <select id="rpk-type" value={type} onChange={e => { setType(e.target.value); setLimits({}); }}
          className="min-h-11 w-full rounded-lg bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] sm:hidden">
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
                className={`min-h-11 rounded-lg px-3 text-sm ${active ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                {t.label} <span className={active ? 'opacity-80' : 'text-[var(--color-text-muted)]'}>· {rub.format(n)}</span>
              </button>
            );
          })}
        </div>

        <nav className="flex min-w-0 flex-wrap gap-2" aria-label="Перейти к группе колонок">
          {GROUPS.map(g => (
            <button key={g.key} type="button" onClick={() => jump(g.key)} title={g.hint}
              className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] sm:text-sm">
              {g.title}
            </button>
          ))}
        </nav>

        {error && error.status !== 403 && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
        {data?.notice && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">{data.notice}</div>}
        {isLoading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Собираю доску — первый раз по команде это до полуминуты…</div>}

        <div className="min-w-0">
          <div ref={boardRef} className="scroll-x flex items-start gap-4 pb-4">
            {GROUPS.map(g => (
              <section key={g.key} data-group={g.key} className="flex shrink-0 flex-col gap-2">
                <div className="px-1">
                  <div className="text-sm font-semibold text-[var(--color-text)]">{g.title}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{g.hint}</div>
                </div>
                <div className="flex items-start gap-3">
                  {COLUMNS.filter(c => c.group === g.key).map(def => (
                    <Column key={def.key} def={def} col={byKey.get(def.key)} canManage={!!data?.canManage}
                      onMore={() => setLimits(l => ({ ...l, [def.key]: (l[def.key] ?? PAGE) + PAGE }))}
                      onOpen={setOpenCard} onTask={setTaskFor} onReview={setReviewFor}
                      onUnbrak={async c => { if (confirm(`Снять брак с «${cardName(c)}»? Заказчик вернётся в пул.`)) { await post({ action: 'unbrak', clientKey: c.clientKey, managerId: c.managerId }).catch(e => alert(e.message)); refresh(); } }}
                      onDone={async t => { const comment = prompt('Что сделано? (необязательно)') ?? null; await post({ action: 'task_done', id: t.id, comment }).catch(e => alert(e.message)); refresh(); }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      {openCard && (
        <CustomerCardLoader
          contactId={openCard.clientType === 'contact' ? openCard.clientId : null}
          companyId={openCard.clientType === 'company' ? openCard.clientId : null}
          onClose={() => setOpenCard(null)} />
      )}
      {taskFor && data && <TaskModal card={taskFor} managers={data.managers} onClose={() => setTaskFor(null)} onSaved={refresh} />}
      {reviewFor && <ReviewModal card={reviewFor} onClose={() => setReviewFor(null)} onSaved={refresh} />}
      {viewTask && (
        <TaskViewModal data={viewTask} onClose={() => { setViewTask(null); setTaskParam(''); }}
          onDone={async comment => { await post({ action: 'task_done', id: viewTask.task.id, comment }); setViewTask(null); setTaskParam(''); refresh(); }} />
      )}
    </div>
  );
}

function Column({ def, col, canManage, onMore, onOpen, onTask, onReview, onUnbrak, onDone }: {
  def: ColumnDef; col: KanbanColumn | undefined; canManage: boolean;
  onMore: () => void; onOpen: (c: KanbanCard) => void; onTask: (c: KanbanCard) => void;
  onReview: (c: KanbanCard) => void; onUnbrak: (c: KanbanCard) => void; onDone: (t: RepeatTask) => void;
}) {
  const tone = def.key === 'brak' ? 'var(--color-negative)' : def.key === 'review' ? '#d97706' : def.key === 'touch_3' ? 'var(--color-positive)' : 'var(--color-accent)';
  return (
    <div className="flex w-72 max-w-[85vw] shrink-0 flex-col gap-2 rounded-xl bg-[var(--color-bg-surface)] p-2">
      <div className="rounded-lg px-2 py-1.5" style={{ borderLeft: `3px solid ${tone}` }} title={def.hint}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-[var(--color-text)]">{def.title}</span>
          <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{col ? rub.format(col.total) : '…'}</span>
        </div>
        {col && col.sum > 0 && <div className="text-xs text-[var(--color-text-muted)]">в сделках {money(col.sum)}</div>}
      </div>
      {col?.cards.map(c => (
        <Card key={c.clientKey} c={c} col={def.key} canManage={canManage}
          onOpen={() => onOpen(c)} onTask={() => onTask(c)} onReview={() => onReview(c)} onUnbrak={() => onUnbrak(c)} onDone={onDone} />
      ))}
      {col && col.total > col.cards.length && (
        <button type="button" onClick={onMore}
          className="min-h-11 rounded-lg text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          Показать ещё · осталось {rub.format(col.total - col.cards.length)}
        </button>
      )}
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

function TaskLine({ t, c }: { t: RepeatTask; c: KanbanCard }) {
  const callAfter = c.calls.some(x => !x.missed && x.sec > 20 && x.at > t.createdAt);
  const overdue = !t.doneAt && t.dueAt && new Date(t.dueAt).getTime() < Date.now();
  const doneNoCall = !!t.doneAt && !callAfter;
  const step = (ok: boolean, icon: React.ReactNode, label: string, bad = false) => (
    <span title={label} className={`inline-flex items-center gap-0.5 ${bad ? 'text-[var(--color-negative)]' : ok ? 'text-[var(--color-positive)]' : 'text-[var(--color-text-muted)] opacity-60'}`}>{icon}</span>
  );
  return (
    <div className={`rounded-md px-2 py-1 text-xs ${overdue || doneNoCall ? 'bg-[var(--color-negative-soft)]' : 'bg-[var(--color-bg)]'}`}>
      <div className="flex items-center gap-2">
        {step(true, <ClipboardList size={13} />, `Поставлена ${fmtDT(t.createdAt)} · ${t.createdBy}`)}
        {step(!!t.readAt, <Eye size={13} />, t.readAt ? `Прочитана ${fmtDT(t.readAt)}` : 'Не прочитана')}
        {step(!!t.doneAt, <CheckCircle2 size={13} />, t.doneAt ? `Отмечена выполненной ${fmtDT(t.doneAt)}` : 'Не выполнена')}
        {step(callAfter, <Phone size={13} />, callAfter ? 'Был звонок после постановки' : 'Звонка после постановки нет', doneNoCall)}
        <span className="truncate text-[var(--color-text-secondary)]" title={t.text}>{t.text}</span>
      </div>
      {overdue && <div className="mt-0.5 text-[var(--color-negative)]">Просрочена: срок {fmtDay(t.dueAt)}</div>}
      {doneNoCall && <div className="mt-0.5 text-[var(--color-negative)]">Отмечена выполненной, но звонка нет</div>}
      {t.doneComment && <div className="mt-0.5 text-[var(--color-text-secondary)]">«{t.doneComment}»</div>}
    </div>
  );
}

function Card({ c, col, canManage, onOpen, onTask, onReview, onUnbrak, onDone }: {
  c: KanbanCard; col: ColumnKey; canManage: boolean;
  onOpen: () => void; onTask: () => void; onReview: () => void; onUnbrak: () => void; onDone: (t: RepeatTask) => void;
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
            <Plus size={13} /> {c.deal ? 'Задача' : 'Сделка + задача'}
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
        {c.task && !c.task.doneAt && !canManage && (
          <button type="button" onClick={() => onDone(c.task!)}
            className="inline-flex min-h-11 items-center gap-1 rounded-md bg-[var(--color-positive)] px-2.5 text-xs text-white hover:opacity-90">
            <CheckCircle2 size={13} /> Выполнено
          </button>
        )}
      </div>
    </article>
  );
}

const fieldCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-text)] sm:text-sm';

function TaskModal({ card, managers, onClose, onSaved }: {
  card: KanbanCard; managers: { id: string; name: string }[]; onClose: () => void; onSaved: () => void;
}) {
  const [text, setText] = useState('');
  const [due, setDue] = useState(() => new Date(Date.now() + 3 * 3600_000 + 86_400_000).toISOString().slice(0, 10));
  const [assignee, setAssignee] = useState(card.managerId);
  const [createDeal, setCreateDeal] = useState(!card.deal);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await post({
        action: 'create_task', clientKey: card.clientKey, managerId: card.managerId, assigneeId: assignee,
        text, dueAt: due || null, createDeal, dealId: card.deal?.dealId ?? null,
      });
      setResult(j.dealCreated ? `Сделка #${j.dealId} создана в Битриксе, задача отправлена менеджеру.`
        : j.dealId && createDeal ? `Открытая повторная сделка #${j.dealId} уже была — задача привязана к ней.`
        : 'Задача отправлена менеджеру.');
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Задача · ${cardName(card)}`} desktopWidth="sm:max-w-lg">
      {result ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--color-text)]">{result}</p>
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm text-white">Готово</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
            Что сделать
            <textarea value={text} onChange={e => setText(e.target.value)} rows={4} autoFocus
              placeholder="Позвонить, узнать, как идёт стройка, предложить кровлю…" className={fieldCls} />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
              Исполнитель
              <select value={assignee} onChange={e => setAssignee(e.target.value)} className={`${fieldCls} min-h-11`}>
                {managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
              Срок
              <input type="date" value={due} onChange={e => setDue(e.target.value)} className={`${fieldCls} min-h-11`} />
            </label>
          </div>
          {!card.deal && (
            <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--color-text)]">
              <input type="checkbox" checked={createDeal} onChange={e => setCreateDeal(e.target.checked)} className="h-5 w-5" />
              Создать повторную сделку в Битриксе (как из контакта, на исполнителя)
            </label>
          )}
          {err && <p className="text-sm text-[var(--color-negative)]">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
            <button type="button" disabled={busy || text.trim().length < 3} onClick={submit}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm text-white disabled:opacity-50">
              {busy ? 'Отправляю…' : createDeal && !card.deal ? 'Создать сделку и задачу' : 'Поставить задачу'}
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

function TaskViewModal({ data, onClose, onDone }: { data: { task: RepeatTask; own: boolean }; onClose: () => void; onDone: (comment: string | null) => Promise<void> }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const t = data.task;
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title="Задача по заказчику" desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        <p className="whitespace-pre-wrap text-[var(--color-text)]">{t.text}</p>
        <div className="text-xs text-[var(--color-text-muted)]">
          От {t.createdBy}, {fmtDT(t.createdAt)}{t.dueAt ? ` · срок ${fmtDay(t.dueAt)}` : ''}
        </div>
        {t.dealId && (
          <a href={dealUrl(t.dealId)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[var(--color-accent)] hover:underline">
            <ExternalLink size={13} /> Сделка #{t.dealId}
          </a>
        )}
        {t.doneAt ? (
          <div className="text-[var(--color-positive)]">Выполнена {fmtDT(t.doneAt)}</div>
        ) : data.own ? (
          <>
            <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
              Что сделано (необязательно)
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} className={fieldCls} />
            </label>
            <button type="button" disabled={busy} onClick={async () => { setBusy(true); await onDone(comment || null).catch(e => alert(e.message)); setBusy(false); }}
              className="min-h-11 rounded-lg bg-[var(--color-positive)] px-4 text-white disabled:opacity-50">
              Отметить выполненной
            </button>
          </>
        ) : (
          <div className="text-[var(--color-text-muted)]">Задача другого менеджера — отметить может только исполнитель.</div>
        )}
      </div>
    </Modal>
  );
}
