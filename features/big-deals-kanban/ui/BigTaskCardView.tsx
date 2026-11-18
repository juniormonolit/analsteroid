'use client';
// Карточка задачи большого чека (решение владельца 18.11: «информативнее битриксовой» — максимум
// без перехода в Битрикс). Порядок строк по важности: что и на сколько → стадия сделки →
// клиент и исполнитель → стадия сделки → сигналы одной строкой (статус, дни в колонке, звонки, ответ по связанным).
// Компоновка 18.11 (план Fable): 4 строки вместо 7, № и дата создания — в подсказке, полоса-сигнал слева.
import { Check, Clock, Link2, Phone, PhoneOff } from 'lucide-react';
import type { BigTaskCard } from '../engine/types';
import { STATE_META, cardAmount, fmtD, money, shortName } from './format';

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
      title={`№ ${card.id} · создана ${fmtD(card.createdAt)} · ${card.title}`}
      className={`group relative flex w-full flex-col gap-1.5 overflow-hidden rounded-lg border bg-[var(--color-bg)] p-2.5 pl-3 text-left text-xs shadow-sm outline-none transition hover:border-[var(--color-border-strong)] hover:shadow focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] active:scale-[0.99] ${selected ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : card.stuck ? 'border-[var(--color-negative)]/50' : 'border-[var(--color-border)]'} ${dragging ? 'opacity-40' : ''} ${draggable ? 'cursor-grab' : 'cursor-pointer'}`}
    >
      {/* Полоса-сигнал слева: застряла — красная, ждёт контроля — акцентная. */}
      {(card.stuck || card.state === 'control') && (
        <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${card.stuck ? 'bg-[var(--color-negative)]' : 'bg-[var(--color-accent)]'}`} />
      )}
      {/* Что и на сколько */}
      <div className="flex min-w-0 items-start justify-between gap-2">
        {selecting && (
          <span aria-hidden className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border-strong)] bg-[var(--color-bg)]'}`}>
            {selected && <Check size={12} strokeWidth={3} />}
          </span>
        )}
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-[var(--color-text)]">
          {card.productGroup ?? card.title}
        </span>
        {amount != null && (
          <span className="shrink-0 whitespace-nowrap text-sm font-bold tabular-nums text-[var(--color-text)]" title={card.deal ? 'Сумма сделки' : 'Сумма из задачи'}>
            {money(amount)}
          </span>
        )}
      </div>

      {/* Кто: клиент · исполнитель · проект */}
      <div className="flex min-w-0 items-center gap-1.5 text-[var(--color-text-secondary)]">
        {client && <span className="min-w-0 truncate" title={`Клиент: ${client}`}>{client}</span>}
        {client && <span aria-hidden className="shrink-0 text-[var(--color-text-muted)]">·</span>}
        <span className={`truncate ${client ? 'shrink-0 max-w-[45%]' : 'min-w-0'}`} title={`Исполнитель: ${card.responsible.name}`}>{shortName(card.responsible.name)}</span>
        <span className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]" title="Проект">{card.groupShort}</span>
      </div>

      {/* Стадия сделки и итог */}
      {(card.deal || closed) && (
        <div className="flex min-w-0 items-center gap-1">
          {closed === 'won' && <span className="rounded bg-[var(--color-positive)]/15 px-1.5 py-0.5 font-semibold text-[var(--color-positive)]">сделка выиграна</span>}
          {closed === 'lost' && <span className="rounded bg-[var(--color-negative-soft)] px-1.5 py-0.5 font-semibold text-[var(--color-negative)]">сделка проиграна</span>}
          {card.deal && !closed && (
            <span className="inline-flex min-w-0 items-center gap-1 text-[var(--color-text-secondary)]" title={`Стадия сделки: ${card.deal.stageName}`}>
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" /><span className="truncate">{card.deal.stageName}</span>
            </span>
          )}
        </div>
      )}

      {/* Сигналы одной строкой, порядок постоянный (глаз идёт по одной вертикали): статус · дни · звонки · ответ */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`rounded px-1.5 py-0.5 font-medium ${state.cls}`}>{state.label}</span>
        <span className={`inline-flex items-center gap-0.5 tabular-nums ${card.stuck ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}
          title={card.stuck ? `${card.daysInColumn} дн. в колонке — дольше нормы` : `${card.daysInColumn} дн. в этой колонке`}>
          <Clock size={11} aria-hidden />{card.daysInColumn} дн.
        </span>
        {calls && (calls.total > 0 ? (
          <span className="inline-flex items-center gap-0.5 tabular-nums text-[var(--color-text-muted)]" title={`Звонков по сделке после постановки задачи: ${calls.total}; разговоры длиннее 20 с — ${Math.round(calls.talkSeconds / 60)} мин`}>
            <Phone size={11} aria-hidden />{calls.total} · {Math.round(calls.talkSeconds / 60)} мин
          </span>
        ) : (
          <span className="inline-flex items-center gap-0.5 font-medium text-[var(--color-warning)]" title="После постановки задачи по сделке не звонили">
            <PhoneOff size={11} aria-hidden />0
          </span>
        ))}
        {card.related.length > 0 && (answered ? (
          <span className="inline-flex items-center gap-0.5 rounded bg-[var(--color-positive)]/15 px-1.5 py-0.5 font-medium text-[var(--color-positive)]"
            title={`Связанных задач (логист, снабжение): ${card.related.length}, с ответом: ${answered}`}>
            <Link2 size={11} aria-hidden />ответ{card.related.length > 1 ? ` ${answered}/${card.related.length}` : ''}
          </span>
        ) : (
          <span className="inline-flex items-center gap-0.5 text-[var(--color-text-muted)]" title={`Связанных задач: ${card.related.length}, ответа пока нет`}>
            <Link2 size={11} aria-hidden />ждём
          </span>
        ))}
      </div>
    </button>
  );
}
