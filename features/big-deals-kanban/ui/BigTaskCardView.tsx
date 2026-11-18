'use client';
// Карточка задачи большого чека (решение владельца 18.11: «информативнее битриксовой» — максимум
// без перехода в Битрикс). Порядок строк по важности: что и на сколько → стадия сделки →
// кто и чей проект → статус задачи и сколько стоит в колонке → звонки и связанные задачи.
import { Check, Clock, Link2, Phone, PhoneOff } from 'lucide-react';
import type { BigTaskCard } from '../engine/types';
import { STATE_META, cardAmount, fmtD, money, plural, shortName } from './format';

/** Клиент сделки, если движок его отдаёт (поле может прийти позже контракта: строка или { name }). */
function clientName(card: BigTaskCard): string | null {
  const c = (card as BigTaskCard & { client?: unknown }).client;
  if (typeof c === 'string') return c.trim() || null;
  if (c && typeof c === 'object' && 'name' in c && typeof (c as { name: unknown }).name === 'string') return (c as { name: string }).name.trim() || null;
  return null;
}

export function BigTaskCardView({ card, onOpen, draggable, onDragStart, onDragEnd, dragging, selected = null, onSelect }: {
  card: BigTaskCard;
  onOpen: (card: BigTaskCard) => void;
  /** Режим выделения: null — выключен; нажатие по карточке отмечает её, а не открывает. */
  selected?: boolean | null;
  onSelect?: () => void;
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
  const client = clientName(card);
  const selecting = selected !== null && !!onSelect;

  return (
    <button
      type="button"
      onClick={() => (selecting ? onSelect!() : onOpen(card))}
      aria-pressed={selecting ? !!selected : undefined}
      draggable={draggable && !selecting}
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(card.id)); onDragStart?.(card); }}
      onDragEnd={() => onDragEnd?.()}
      data-task-id={card.id}
      className={`group flex w-full flex-col gap-1.5 rounded-lg border bg-[var(--color-bg)] p-2.5 text-left text-xs shadow-sm outline-none transition hover:border-[var(--color-border-strong)] hover:shadow focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] active:scale-[0.99] ${selected ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : card.stuck ? 'border-[var(--color-negative)]/50' : 'border-[var(--color-border)]'} ${dragging ? 'opacity-40' : ''} ${draggable ? 'cursor-grab' : 'cursor-pointer'}`}
    >
      {/* Что и на сколько */}
      <div className="flex min-w-0 items-start justify-between gap-2">
        {selecting && (
          <span aria-hidden className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border-strong)] bg-[var(--color-bg)]'}`}>
            {selected && <Check size={12} strokeWidth={3} />}
          </span>
        )}
        <span className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-[var(--color-text)]" title={card.title}>
          {card.productGroup ?? card.title}
        </span>
        {amount != null && (
          <span className="shrink-0 whitespace-nowrap text-sm font-bold tabular-nums text-[var(--color-text)]" title={card.deal ? 'Сумма сделки' : 'Сумма из задачи'}>
            {money(amount)}
          </span>
        )}
      </div>

      {client && <span className="min-w-0 truncate text-[var(--color-text-muted)]" title={`Клиент: ${client}`}>{client}</span>}

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
      <span className="text-[10px] text-[var(--color-text-muted)]">№ {card.id} · <span title="Дата создания задачи">созд. {fmtD(card.createdAt)}</span></span>
    </button>
  );
}
