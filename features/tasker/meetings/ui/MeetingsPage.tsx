'use client';
// «Собрания» Задачника (/tasker/meetings, TASKER_SPEC.md «Регулярные собрания»): серии планёрок/разборов,
// создание и правка серии (Drawer), ближайшие встречи с отменой одной встречи, отмена серии.
// Встречи видны и в «Неделе»/«Сегодня» Задачника (MeetingBlock). Открытая серия — в URL (?meeting=).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarCheck, MapPin, Plus, Repeat, RotateCcw, Users } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import type { TaskerMeeting, TaskerMeetingInput } from '../../types';
import { TaskerTabs } from '../../ui/shared/TaskerPage';
import { TASKS_KEY } from '../../ui/shared/api';
import { fmtDayLong, fmtTime, plural, shortName } from '../../ui/shared/format';
import { MEETINGS_KEY, cancelMeeting, createMeeting, resyncMeeting, setOccurrence, updateMeeting, useMeetingOptions, useMeetings } from './api';
import { MeetingForm } from './MeetingForm';

const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';

function CalendarBadge({ m }: { m: TaskerMeeting }) {
  if (m.cancelledAt) return <span className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">отменено</span>;
  if (m.calendar.state === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-[var(--color-negative)]/10 px-1.5 py-0.5 text-[11px] text-[var(--color-negative)]" title={m.calendar.error ?? undefined}>
        <AlertTriangle size={11} aria-hidden /> не в календаре
      </span>
    );
  }
  if (m.calendar.state === 'pending') return <span className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">синхронизируется…</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-[var(--color-positive)]/10 px-1.5 py-0.5 text-[11px] text-[var(--color-positive)]">
      <CalendarCheck size={11} aria-hidden /> в календаре
    </span>
  );
}

function MeetingCard({ m, onOpen }: { m: TaskerMeeting; onOpen: () => void }) {
  const next = m.upcoming.find(u => !u.cancelled);
  return (
    <button type="button" onClick={onOpen}
      className={`flex min-w-0 flex-col gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 text-left hover:border-[var(--color-border-strong)] ${m.cancelledAt ? 'opacity-60' : ''}`}>
      <div className="flex min-w-0 items-center gap-2">
        <Repeat size={16} className="shrink-0 text-[var(--color-positive)]" aria-hidden />
        <span className="min-w-0 truncate font-semibold text-[var(--color-text)]">{m.title}</span>
        <span className="ml-auto shrink-0"><CalendarBadge m={m} /></span>
      </div>
      <div className="text-sm text-[var(--color-text-secondary)] first-letter:uppercase">{m.recurrenceLabel} · {m.durationMin} мин</div>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
        <span>Организатор: {shortName(m.organizer.name)}</span>
        <span className="inline-flex items-center gap-1"><Users size={12} aria-hidden />{m.participants.length} {plural(m.participants.length, 'участник', 'участника', 'участников')}</span>
        {next && !m.cancelledAt && <span>Ближайшая: {fmtDayLong(next.date)}, {fmtTime(next.startsAt)}</span>}
      </div>
    </button>
  );
}

function MeetingDetails({ m, busy, onEdit, onCancelSeries, onToggle, onResync }: {
  m: TaskerMeeting;
  busy: boolean;
  onEdit: () => void;
  onCancelSeries: () => void;
  onToggle: (date: string, cancelled: boolean) => void;
  onResync: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[var(--color-text-secondary)] first-letter:uppercase">{m.recurrenceLabel} · {m.durationMin} мин</span>
        <CalendarBadge m={m} />
      </div>
      {m.calendar.state === 'failed' && !m.cancelledAt && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-[var(--color-negative)]/10 p-3 text-[var(--color-negative)]">
          <span className="min-w-0 break-words">Календарь Битрикса: {m.calendar.error ?? 'ошибка'}. Повторим автоматически.</span>
          {m.canEdit && <button type="button" onClick={onResync} disabled={busy} className={BTN}><RotateCcw size={14} aria-hidden /> Повторить сейчас</button>}
        </div>
      )}
      {m.calendar.mode === 'rolling' && !m.cancelledAt && (
        <p className="text-xs text-[var(--color-text-muted)]">В календаре Битрикса стоит ближайшая встреча — после неё событие переедет на следующую (такой повтор Битрикс через REST не принимает).</p>
      )}
      <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="text-xs text-[var(--color-text-muted)]">Организатор</dt><dd className="min-w-0 break-words">{m.organizer.name}</dd>
        <dt className="text-xs text-[var(--color-text-muted)]">С даты</dt><dd>{fmtDayLong(m.startDate)}{m.untilDate ? ` по ${fmtDayLong(m.untilDate)}` : ', без окончания'}</dd>
        {m.place && <><dt className="text-xs text-[var(--color-text-muted)]">Место</dt><dd className="inline-flex min-w-0 items-center gap-1 break-words"><MapPin size={13} aria-hidden className="shrink-0" />{m.place}</dd></>}
        {m.departments.length > 0 && <><dt className="text-xs text-[var(--color-text-muted)]">Отделы</dt><dd className="min-w-0 break-words">{m.departments.map(d => d.name).join(', ')}</dd></>}
        {m.people.length > 0 && <><dt className="text-xs text-[var(--color-text-muted)]">Люди</dt><dd className="min-w-0 break-words">{m.people.map(p => shortName(p.name)).join(', ')}</dd></>}
        <dt className="text-xs text-[var(--color-text-muted)]">Состав</dt>
        <dd className="min-w-0">
          <details>
            <summary className="min-h-9 cursor-pointer select-none">{m.participants.length} {plural(m.participants.length, 'участник', 'участника', 'участников')}</summary>
            <div className="mt-1 break-words text-xs text-[var(--color-text-secondary)]">{m.participants.map(p => p.name).join(', ') || '—'}</div>
          </details>
        </dd>
      </dl>
      {m.agenda.trim() && (
        <section className="min-w-0">
          <h3 className="mb-1 text-xs font-semibold text-[var(--color-text-muted)]">Повестка</h3>
          <p className="whitespace-pre-wrap break-words">{m.agenda}</p>
        </section>
      )}
      {!m.cancelledAt && m.upcoming.length > 0 && (
        <section className="min-w-0">
          <h3 className="mb-1 text-xs font-semibold text-[var(--color-text-muted)]">Ближайшие встречи</h3>
          <ul className="flex min-w-0 flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {m.upcoming.map(u => (
              <li key={u.date} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                <span className={`min-w-0 flex-1 truncate first-letter:uppercase ${u.cancelled ? 'text-[var(--color-text-muted)] line-through' : ''}`}>
                  {fmtDayLong(u.date)}, {fmtTime(u.startsAt)}
                </span>
                {m.canEdit && (
                  <button type="button" disabled={busy} onClick={() => onToggle(u.date, !u.cancelled)}
                    className="min-h-9 shrink-0 rounded-md px-2 text-xs text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
                    {u.cancelled ? 'Вернуть' : 'Отменить'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            Отмена одной встречи — только в Монолитике: Битрикс через REST не даёт исключить дату из серии, в календаре участников она останется.
          </p>
        </section>
      )}
      {m.canEdit && !m.cancelledAt && (
        <div className="flex min-w-0 flex-wrap gap-2">
          <button type="button" onClick={onEdit} disabled={busy} className={BTN}>Изменить серию</button>
          <button type="button" onClick={onCancelSeries} disabled={busy} className={`${BTN} text-[var(--color-negative)]`}>Отменить серию</button>
        </div>
      )}
      {m.createdBy && <div className="text-xs text-[var(--color-text-muted)]">Создал: {m.createdBy}</div>}
    </div>
  );
}

export function MeetingsPage({ canAssign }: { canAssign: boolean }) {
  const qc = useQueryClient();
  const [showCancelled, setShowCancelled] = useState(false);
  const [openParam, setOpenParam] = useUrlState('meeting', { ...stringParam(''), mode: 'push' });
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [creating, setCreating] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = useMeetings(showCancelled);
  const options = useMeetingOptions(canAssign && (creating || mode === 'edit'));
  const meetings = q.data?.meetings ?? [];
  const current = meetings.find(m => String(m.id) === openParam) ?? null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: [MEETINGS_KEY] });
    qc.invalidateQueries({ queryKey: [TASKS_KEY] });
  };
  const mut = useMutation({
    mutationFn: (fn: () => Promise<{ meeting: TaskerMeeting }>) => fn(),
    onMutate: () => setErr(null),
    onSuccess: r => { refresh(); return r; },
    onError: (e: Error) => setErr(e.message),
  });

  const save = (input: TaskerMeetingInput) => {
    if (creating) {
      mut.mutate(() => createMeeting(input), { onSuccess: r => { setCreating(false); setMode('view'); setOpenParam(String(r.meeting.id)); } });
    } else if (current) {
      mut.mutate(() => updateMeeting(current.id, input), { onSuccess: () => setMode('view') });
    }
  };
  const close = () => { setOpenParam(''); setCreating(false); setMode('view'); setErr(null); };
  const drawerOpen = creating || !!current;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Задачник</h1>
          {canAssign && (
            <button type="button" onClick={() => { setErr(null); setOpenParam(''); setCreating(true); }}
              className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]">
              <Plus size={16} aria-hidden /> Новое собрание
            </button>
          )}
        </header>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TaskerTabs active="meetings" />
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <input type="checkbox" checked={showCancelled} onChange={e => setShowCancelled(e.target.checked)} className="size-4" />
            показать отменённые
          </label>
        </div>
        <p className="text-sm text-[var(--color-text-muted)]">
          Регулярные планёрки и разборы: серия встаёт одним повторяющимся событием в календарь организатора в Битриксе, встречи видны в «Неделе» и «Сегодня».
        </p>

        {q.error && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{q.error.message}</div>}
        {q.isLoading && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Загружаю собрания…</div>}
        {q.data && meetings.length === 0 && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">
            {canAssign ? 'Собраний пока нет — создайте первое кнопкой «Новое собрание».' : 'Собраний с вашим участием пока нет.'}
          </div>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {meetings.map(m => <MeetingCard key={m.id} m={m} onOpen={() => { setErr(null); setCreating(false); setMode('view'); setOpenParam(String(m.id)); }} />)}
        </div>
      </div>

      <Drawer open={drawerOpen} onOpenChange={o => { if (!o) close(); }} desktopWidth="sm:max-w-xl"
        title={creating ? 'Новое собрание' : current ? (mode === 'edit' ? `Правка: ${current.title}` : current.title) : ''}>
        <div className="min-w-0 p-4">
          {creating || (current && mode === 'edit') ? (
            <MeetingForm key={creating ? 'new' : `e${current?.id}`} initial={creating ? null : current} options={options.data}
              pending={mut.isPending} error={err ?? (options.error ? options.error.message : null)}
              onSubmit={save} onCancel={() => (creating ? close() : setMode('view'))} />
          ) : current ? (
            <>
              {err && <div role="alert" className="mb-3 rounded-lg bg-[var(--color-negative)]/10 p-3 text-sm text-[var(--color-negative)]">{err}</div>}
              <MeetingDetails m={current} busy={mut.isPending}
                onEdit={() => { setErr(null); setMode('edit'); }}
                onCancelSeries={() => setConfirmCancel(true)}
                onToggle={(date, cancelled) => mut.mutate(() => setOccurrence(current.id, date, cancelled))}
                onResync={() => mut.mutate(() => resyncMeeting(current.id))} />
            </>
          ) : null}
        </div>
      </Drawer>

      <ConfirmDialog open={confirmCancel} tone="danger" pending={mut.isPending}
        title="Отменить серию собраний?"
        description="Все будущие встречи пропадут из Задачника, событие удалится из календаря Битрикса у организатора и участников."
        confirmLabel="Отменить серию" cancelLabel="Не отменять"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => current && mut.mutate(() => cancelMeeting(current.id), { onSuccess: () => setConfirmCancel(false) })} />
    </div>
  );
}
