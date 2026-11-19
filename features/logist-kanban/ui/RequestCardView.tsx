'use client';
// Карточка запроса на доске: тип чипом, огонёк приоритета с причинами, заказчик, позиции, сумма, SLA, кто.
import { Flame, MessageCircle, RotateCcw } from 'lucide-react';
import type { RequestCard } from '../engine/requests/contract';
import { SLA_CLS, TYPE_META, cardTitle, fmtDT, money, shortName, slaText } from './format';

export function RequestCardView({ card: c, onOpen }: { card: RequestCard; onOpen: (c: RequestCard) => void }) {
  const t = TYPE_META[c.type];
  const sla = slaText(c.sla);
  return (
    <button type="button" onClick={() => onOpen(c)} data-request-id={c.id}
      className={`flex w-full min-w-0 flex-col gap-1.5 rounded-lg border bg-[var(--color-bg)] p-2.5 text-left text-[13px] text-[var(--color-text)] transition-colors hover:border-[var(--color-border-focus)] ${c.priority.hot ? 'border-[var(--color-warning)]' : 'border-[var(--color-border)]'}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`shrink-0 rounded px-1.5 py-px text-[11px] font-semibold ${t.cls}`}>{t.short}</span>
        {c.priority.hot && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-[var(--color-warning)]" title={`Приоритет ${Math.round(c.priority.score)}`}>
            <Flame size={13} aria-hidden />{Math.round(c.priority.score)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-[var(--color-text-muted)]">№ {c.id}{c.deal ? ` · сд. ${c.deal.id}` : ''}</span>
      </div>
      <div className="line-clamp-2 break-words font-semibold">{cardTitle(c)}</div>
      {c.itemsPreview && (
        <div className="line-clamp-2 break-words text-[12px] text-[var(--color-text-secondary)]">
          {c.itemsPreview}{c.itemsCount > 1 && <span className="text-[var(--color-text-muted)]"> · {c.itemsCount} поз.</span>}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {c.amount > 0 && <span className="font-semibold tabular-nums">{money(c.amount)}</span>}
        {c.type === 'cheaper' && c.competitorTotal != null && (
          <span className="text-[12px] tabular-nums text-[var(--color-warning)]" title="Цена конкурента">конк. {money(c.competitorTotal)}</span>
        )}
      </div>
      {c.priority.hot && c.priority.reasons.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-0.5 text-[11.5px] text-[var(--color-warning)]" aria-label="Почему горячий">
          {c.priority.reasons.slice(0, 3).map(r => <li key={r} className="truncate">• {r}</li>)}
        </ul>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--color-text-muted)]">
        {sla && <span className={SLA_CLS[c.sla.state]}>{sla}</span>}
        {c.returnsCount > 0 && <span className="inline-flex items-center gap-0.5 text-[var(--color-negative)]" title="Возвратов на доработку"><RotateCcw size={11} aria-hidden />{c.returnsCount}</span>}
        {c.offersCount > 0 && <span title="Вариантов ответа">вар. {c.offersCount}</span>}
        {c.unread > 0 && <span className="inline-flex items-center gap-0.5 font-semibold text-[var(--color-accent)]" title="Непрочитанные сообщения"><MessageCircle size={11} aria-hidden />{c.unread}</span>}
        {c.dealOutcome && <span className={c.dealOutcome === 'sold' ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}>{c.dealOutcome === 'sold' ? 'сделка продана' : 'сделка забракована'}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-[var(--color-text-secondary)]">
        <span className="min-w-0 truncate" title="Менеджер">{shortName(c.manager.name)}</span>
        <span aria-hidden>→</span>
        <span className={`min-w-0 truncate ${c.logist ? '' : 'italic text-[var(--color-text-muted)]'}`} title="Логист">{c.logist ? shortName(c.logist.name) : 'не взят'}</span>
        <span className="ml-auto shrink-0 text-[var(--color-text-muted)]">{fmtDT(c.sentAt ?? c.createdAt)}</span>
      </div>
      {c.queue && <div className="truncate text-[11px] text-[var(--color-text-muted)]" title="Очередь">{c.queue.name}</div>}
    </button>
  );
}
