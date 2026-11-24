'use client';
// Карточка задачи Задачника — одна на доску, неделю и «Сегодня».
// Строки по важности (правка владельца 24.11 «не видно инфы»): ФИО менеджера целиком + тип → тема → цифры →
// «Ведёт: роль Фамилия И.», срок, сессия. Переносы вместо многоточия; обрезается только длинное название сделки.
import { AlertTriangle, CalendarClock, CloudOff, Handshake, Target } from 'lucide-react';
import { TASKER_VERDICT_LABELS, type TaskerTask } from '../../types';
import { TASK_KIND_LABELS, VERDICT_CLS, cleanName, executorOf, fmtD, fmtDT, fmtValue, isOverdue, shortName } from './format';

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
  const { kind, doneNote } = t;
  // Кто ведёт — то же поле и та же роль, что в карточке задачи (executorOf; аудит 23.11, раунд 2).
  // Исполнитель = сам менеджер (старые задачи) — «ведёт сам», без повтора фамилии.
  const executor = executorOf(t);
  // Задача по сделке (289): вместо темы — сделка, вместо «было → цель» — стадия и дни в ней.
  const deal = kind === 'deal' ? t.deal ?? null : null;
  // «Сейчас» (снимок, посчитанный сервером) или итог замера — с цветом направления относительно «было».
  const now = t.measuredValue != null ? { label: 'замер', value: t.measuredValue }
    : t.current?.value != null ? { label: 'сейчас', value: t.current.value } : null;
  const tone = (v: number) => {
    const b = t.snapshot.value;
    if (b == null || v === b) return 'text-[var(--color-text-muted)]';
    return (v > b) === t.higherIsBetter ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]';
  };
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
      {/* 1. Менеджер — ключевой идентификатор: целиком, с переносом, без многоточия (правка владельца 24.11). */}
      <div className="flex min-w-0 items-start justify-between gap-2">
        {/* Узкая колонка (неделя): русские переносы с дефисом вместо разрыва посреди слова. */}
        <span lang="ru" className={`min-w-0 flex-1 break-words font-semibold leading-snug text-[var(--color-text)] [hyphens:auto] ${compact ? 'text-[13px]' : 'text-sm'}`}>{cleanName(t.manager.name)}</span>
        {t.syncState === 'failed' && <CloudOff size={14} className="mt-0.5 shrink-0 text-[var(--color-negative)]" aria-label="Не ушла в Битрикс" />}
        {t.syncState === 'pending' && <CloudOff size={14} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" aria-label="Отправляется в Битрикс" />}
        {kind && !compact && <span className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[11px] font-medium ${kind === 'theory' ? 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]' : kind === 'deal' ? 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'}`}>{TASK_KIND_LABELS[kind]}</span>}
      </div>
      {/* Неделя: бейдж типа — отдельной строкой, чтобы ФИО занимало всю ширину узкой колонки. */}
      {kind && compact && <span className={`self-start rounded px-1.5 py-px text-[11px] font-medium ${kind === 'theory' ? 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]' : kind === 'deal' ? 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]' : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'}`}>{TASK_KIND_LABELS[kind]}</span>}
      {/* 2. Тема — с переносом; название сделки — до 2 строк (длиннее — многоточие + title). */}
      {kind === 'deal' ? (
        <span className="line-clamp-2 min-w-0 break-words text-[13px] leading-snug text-[var(--color-text)]" title={deal?.title ?? undefined}>
          {deal?.title ? `«${deal.title}»` : `Сделка #${t.dealId ?? '?'}`}
        </span>
      ) : (
        <span className="min-w-0 break-words text-[13px] leading-snug text-[var(--color-text)]">{t.metricLabel}</span>
      )}
      {/* 3. Цифры */}
      {!compact && kind === 'deal' && (
        <div className="flex min-w-0 items-start gap-1 text-[var(--color-text-secondary)]" title="Стадия сделки при постановке (дней в стадии)">
          <Handshake size={12} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
          <span className="min-w-0 break-words">
            {deal ? `${deal.stage ?? '—'}${deal.daysInStage != null ? ` · ${deal.daysInStage} дн.` : ''}` : `#${t.dealId ?? '?'}`}
            {t.dealResult && t.dealResult.stageId !== deal?.stageId && <span className="text-[var(--color-text-muted)]"> → {t.dealResult.stage ?? '—'}</span>}
          </span>
        </div>
      )}
      {!compact && kind !== 'deal' && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 tabular-nums text-[var(--color-text)]" title="Значение при постановке → цель">
          <Target size={12} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
          <span><span className="text-[var(--color-text-muted)]">было</span> {fmtValue(t.snapshot.value, t.format)}</span>
          <span aria-hidden className="text-[var(--color-text-muted)]">→</span>
          <span><span className="text-[var(--color-text-muted)]">цель</span> <b className="font-semibold">{fmtValue(t.target, t.format)}</b></span>
          {now && <span className={tone(now.value)}>· {now.label} {fmtValue(now.value, t.format)}</span>}
        </div>
      )}
      {doneNote && !compact && (
        <div className="line-clamp-2 min-w-0 break-words rounded bg-[var(--color-bg-surface)] px-1.5 py-1 text-[var(--color-text-secondary)]" title={doneNote}>
          <span className="font-medium text-[var(--color-text)]">Сделано: </span>{doneNote}
        </div>
      )}
      {/* 4. Кто ведёт (роль словом), срок, сессия — переносом, без обрезки. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[var(--color-text-muted)]">
        {!compact && executor && (
          <span className="min-w-0 break-words text-[var(--color-text-secondary)]">
            Ведёт: {executor.role === 'менеджер' ? 'сам менеджер' : `${executor.role ? `${executor.role} ` : ''}${shortName(executor.person.name)}`}
          </span>
        )}
        {t.verdict ? (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${VERDICT_CLS[t.verdict]}`}>{TASKER_VERDICT_LABELS[t.verdict]}</span>
        ) : t.status === 'measuring' ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap" title={kind === 'deal' ? 'Проверка сделки к сроку' : 'Дата автозамера'}><CalendarClock size={12} aria-hidden />{kind === 'deal' ? 'проверка' : 'замер'} {fmtD(t.controlDate)}</span>
        ) : (
          <span className={`inline-flex items-center gap-1 whitespace-nowrap ${overdue ? 'font-medium text-[var(--color-negative)]' : ''}`} title="Срок">
            {overdue && <AlertTriangle size={12} aria-hidden />}срок {fmtD(t.deadline)}
          </span>
        )}
        {t.slotStart && !t.verdict && t.status !== 'measuring' && <span className="whitespace-nowrap" title="Слот сессии">сессия {fmtDT(t.slotStart)}</span>}
        {t.checklist.length > 0 && !compact && <span className="whitespace-nowrap" title="Заказчики в чек-листе">☑ {t.checklist.filter(c => c.done).length}/{t.checklist.length}</span>}
      </div>
    </button>
  );
}
