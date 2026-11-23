'use client';
// Карточка задачи Задачника — одна на доску, неделю и «Сегодня».
// Строки по важности: тема (метрика) → менеджер → было/цель → срок/слот и сигналы.
import { AlertTriangle, CalendarClock, CloudOff, Target } from 'lucide-react';
import { TASKER_VERDICT_LABELS, type TaskerTask } from '../../types';
import { TASK_KIND_LABELS, VERDICT_CLS, fmtD, fmtDT, fmtValue, isOverdue, shortName } from './format';

export function TaskCard({ task: t, onOpen, draggable, dragging, onDragStart, onDragEnd, compact }: {
  task: TaskerTask;
  onOpen: (t: TaskerTask) => void;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (t: TaskerTask) => void;
  onDragEnd?: () => void;
  /** Короче — для ячеек недели. */
  compact?: boolean;
}) {
  const overdue = isOverdue(t);
  const { kind, assignee, doneNote } = t;
  return (
    <button
      type="button"
      onClick={() => onOpen(t)}
      draggable={draggable}
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); onDragStart?.(t); }}
      onDragEnd={() => onDragEnd?.()}
      data-task-id={t.id}
      title={`№ ${t.id} · ${t.title}`}
      className={`relative flex w-full min-w-0 shrink-0 flex-col gap-1 overflow-hidden rounded-lg border bg-[var(--color-bg)] p-2.5 pl-3 text-left text-xs shadow-sm outline-none transition hover:border-[var(--color-border-strong)] hover:shadow focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] active:scale-[0.99] ${overdue ? 'border-[var(--color-negative)]/50' : 'border-[var(--color-border)]'} ${dragging ? 'opacity-40' : ''} ${draggable ? 'cursor-grab' : 'cursor-pointer'}`}
    >
      {overdue && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-[var(--color-negative)]" />}
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-[var(--color-text)]">{t.metricLabel}</span>
        {t.syncState === 'failed' && <CloudOff size={14} className="mt-0.5 shrink-0 text-[var(--color-negative)]" aria-label="Не ушла в Битрикс" />}
        {t.syncState === 'pending' && <CloudOff size={14} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" aria-label="Отправляется в Битрикс" />}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[var(--color-text-secondary)]">
        <span className="min-w-0 truncate" title={`Менеджер: ${t.manager.name}`}>{shortName(t.manager.name)}</span>
        {kind && <span className={`shrink-0 rounded px-1.5 py-px text-[11px] font-medium ${kind === 'theory' ? 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'}`}>{TASK_KIND_LABELS[kind]}</span>}
        {!compact && (assignee ?? t.rop) && <>
          <span aria-hidden className="shrink-0 text-[var(--color-text-muted)]">·</span>
          {assignee
            ? <span className="min-w-0 truncate text-[var(--color-text-muted)]" title={`Исполнитель: ${assignee.name}`}>{shortName(assignee.name)}</span>
            : <span className="min-w-0 truncate text-[var(--color-text-muted)]" title={`РОП: ${t.rop!.name}`}>РОП {shortName(t.rop!.name)}</span>}
        </>}
      </div>
      {!compact && (
        <div className="flex min-w-0 items-center gap-1 tabular-nums text-[var(--color-text)]" title="Значение при постановке → цель">
          <Target size={12} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
          <span className="truncate">{fmtValue(t.snapshot.value, t.format)} → {fmtValue(t.target, t.format)}</span>
          {t.measuredValue != null && <span className="truncate text-[var(--color-text-muted)]">· замер {fmtValue(t.measuredValue, t.format)}</span>}
        </div>
      )}
      {doneNote && !compact && (
        <div className="line-clamp-2 min-w-0 break-words rounded bg-[var(--color-bg-surface)] px-1.5 py-1 text-[var(--color-text-secondary)]" title={doneNote}>
          <span className="font-medium text-[var(--color-text)]">Сделано: </span>{doneNote}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-text-muted)]">
        {t.verdict ? (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${VERDICT_CLS[t.verdict]}`}>{TASKER_VERDICT_LABELS[t.verdict]}</span>
        ) : t.status === 'measuring' ? (
          <span className="inline-flex items-center gap-1" title="Дата автозамера"><CalendarClock size={12} aria-hidden />замер {fmtD(t.controlDate)}</span>
        ) : (
          <span className={`inline-flex items-center gap-1 ${overdue ? 'font-medium text-[var(--color-negative)]' : ''}`} title="Срок">
            {overdue && <AlertTriangle size={12} aria-hidden />}срок {fmtD(t.deadline)}
          </span>
        )}
        {t.slotStart && !t.verdict && t.status !== 'measuring' && <span title="Слот сессии">сессия {fmtDT(t.slotStart)}</span>}
        {t.checklist.length > 0 && !compact && <span title="Заказчики в чек-листе">☑ {t.checklist.filter(c => c.done).length}/{t.checklist.length}</span>}
      </div>
    </button>
  );
}
