'use client';
// Ссылка на сделку внутри единой «Карточки клиента» (20.10). В приложении карточка
// открыта панелью — сделка открывается своей карточкой Монолитики (DealCard) поверх;
// во вкладке Битрикса (и в «Модулях») обработчика нет — обычная ссылка в Битрикс.
import { createContext, useContext } from 'react';
import { dealBitrixUrl } from '@/features/customers/ui/shared';

export const DealOpenerContext = createContext<((dealId: number) => void) | null>(null);

export function DealLink({ dealId, className, title, children, stop }: {
  dealId: number; className?: string; title?: string; children: React.ReactNode;
  /** Не всплывать клик (ссылка внутри раскрывающейся строки). */
  stop?: boolean;
}) {
  const open = useContext(DealOpenerContext);
  if (open) {
    return (
      <button type="button" title={title} className={className}
        onClick={e => { if (stop) e.stopPropagation(); open(dealId); }}>
        {children}
      </button>
    );
  }
  return (
    <a href={dealBitrixUrl(dealId)} target="_blank" rel="noreferrer" title={title} className={className}
      onClick={stop ? e => e.stopPropagation() : undefined}>
      {children}
    </a>
  );
}
