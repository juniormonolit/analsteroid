'use client';
// Карточка задачи большого чека (решение владельца 18.11: «информативнее битриксовой» — максимум
// без перехода в Битрикс). Порядок строк по важности: что и на сколько → стадия сделки →
// кто и чей проект → статус задачи и сколько стоит в колонке → звонки и связанные задачи.
import { Clock, Link2, Phone, PhoneOff } from 'lucide-react';
import type { BigTaskCard } from '../engine/types';
import { STATE_META, cardAmount, money, plural, shortName } from './format';

export function BigTaskCardView({ card, onOpen, draggable, onDragStart, onDragEnd, dragging }: {
  card: BigTaskCard;
  onOpen: (card: BigTaskCard) => void;
  draggable?: boolean;
  onDragStart?: (card: BigTaskCard) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}) {
  const amount = cardAmount(card);
  const state = STATE_META[card.state];
  const calls = card.calls;
  const answered = card.related.filter(r => r.state === 'control' || r.state === 'done').length;
  const closed = card.deal?.closed ?? null;

  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      draggable={draggable}
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(card.id)); onDragStart?.(card); }}
      onDragEnd={() => onDragEnd?.()}
      data-task-id={card.id}
      className={`group flex w-full flex-col gap-1.5 rounded-lg border bg-[var(--color-bg)] p-2.5 text-left text-xs shadow-sm outline-none transition hover:border-[var(--color-border-strong)] hover:shadow focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] active:scale-[0.99] ${card.stuck ? 'border-[var(--color-negative)]/50' : 'border-[var(--color-border)]'} ${dragging ? 'opacity-40' : ''} ${draggable ? 'cursor-grab' : 'cursor-pointer'}`}
    >
      {/* Что и на сколько */}
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-semibold leading-snug text-[var(--color-text)]" title={card.title}>
          {card.productGroup ?? card.title}
        </span>
        {amount != null && (
          <span className="shrink-0 whitespace-nowrap text-sm font-bold tabular-nums text-[var(--color-text)]" title={card.deal ? 'Сумма сделки' : 'Сумма из задачи'}>
            {money(amount)}
          </span>
        )}
      </div>

      {/* Стадия сделки и итог */}
      {(card.deal || closed) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {closed === 'won' && <span className="rounded bg-[var(--color-positive)]/15 px-1.5 py-0.5 font-semibold text-[var(--color-positive)]">сделка выиграна</span>}
          {closed === 'lost' && <span className="rounded bg-[var(--color-negative-soft)] px-1.5 py-0.5 font-semibold text-[var(--color-negative)]">сделка проиграна</span>}
          {card.deal && !closed && <span className="min-w-0 truncate text-[var(--color-text-secondary)]" title={`Стадия сделки: ${card.deal.stageName}`}>{card.deal.stageName}</span>}
        </div>
      )}

      {/* Кто и чей проект */}
      <div className="flex min-w-0 items-center gap-1.5 text-[var(--color-text-secondary)]">
        <span className="min-w-0 truncate" title={card.responsible.name}>{shortName(card.responsible.name)}</span>
        <span className="shrink-0 rounded border border-[var(--color-border)] px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{card.groupShort}</span>
      </div>

      {/* Статус задачи и время в колонке */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 font-medium ${state.cls}`}>{state.label}</span>
        <span className={`inline-flex items-center gap-0.5 ${card.stuck ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}
          title={card.stuck ? 'Стоит в колонке дольше нормы' : 'Сколько дней задача в этой колонке'}>
          <Clock size={11} aria-hidden />{card.daysInColumn} дн. в колонке
        </span>
      </div>

      {/* Звонки после постановки и связанные задачи */}
      {(calls || card.related.length > 0) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[var(--color-text-muted)]">
          {calls && (calls.total > 0 ? (
            <span className="inline-flex items-center gap-0.5" title="Звонков по сделке после постановки задачи; минуты — разговоры длиннее 20 с">
              <Phone size={11} aria-hidden />{calls.total} {plural(calls.total, 'звонок', 'звонка', 'звонков')} · {Math.round(calls.talkSeconds / 60)} мин
            </span>
          ) : (
            <span className="inline-flex items-center gap-0.5 text-[var(--color-warning)]" title="После постановки задачи по сделке не звонили">
              <PhoneOff size={11} aria-hidden />звонков не было
            </span>
          ))}
          {card.related.length > 0 && (
            <span className={`inline-flex items-center gap-0.5 ${answered ? 'text-[var(--color-positive)]' : ''}`}
              title={`Связанных задач по сделке: ${card.related.length}${answered ? `, с ответом: ${answered}` : ', ответа пока нет'}`}>
              <Link2 size={11} aria-hidden />{card.related.length}{answered ? ` · ответ ${answered}` : ''}
            </span>
          )}
        </div>
      )}
      <span className="text-[10px] text-[var(--color-text-muted)]">№ {card.id}</span>
    </button>
  );
}
