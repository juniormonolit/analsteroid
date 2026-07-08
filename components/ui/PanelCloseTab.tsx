'use client';
import { X } from 'lucide-react';

interface PanelCloseTabProps {
  onClick: () => void;
  /** Позиционирование по вертикали — ближе к верху панели по умолчанию. */
  topClassName?: string;
  className?: string;
  /** Точечный оверрайд позиции (напр. `{ left: '10%', transform: 'translateX(-50%)' }`
   * для дрилл-дауна, где левый край панели — не фиксированная ширина, а `10%` от экрана). */
  style?: React.CSSProperties;
}

/**
 * Единая кнопка закрытия для правых слайд-панелей (карточка сделки, дрилл-даун,
 * настройки метрики, импорт/экспорт планов — п. Н3 спеки): скруглённый «язычок»,
 * торчащий с ЛЕВОГО края панели наружу, синий фон, белый крупный ×.
 *
 * Только для широких экранов (`hidden sm:flex`) — на мобиле панели занимают почти всю
 * ширину экрана, слева нет места для выступающего таба, там остаётся обычный крестик
 * в шапке панели (`sm:hidden` на нём). Один крестик видим одновременно, никогда оба.
 *
 * Требует, чтобы предок с `position: fixed`/`relative` был контейнером позиционирования
 * (у всех текущих слайд-панелей корневой div уже `fixed`, так что `absolute` тут работает
 * из коробки, доп. `relative` не нужен).
 */
export function PanelCloseTab({ onClick, topClassName = 'top-6', className = '', style }: PanelCloseTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Закрыть"
      title="Закрыть"
      style={style}
      className={`hidden sm:flex absolute ${topClassName} ${style?.left === undefined ? '-left-7' : ''} z-10 h-14 w-7 items-center justify-center rounded-l-full bg-[var(--color-accent)] text-white shadow-lg hover:bg-[var(--color-accent-hover)] transition-colors ${className}`}
    >
      <X size={18} strokeWidth={2.5} />
    </button>
  );
}
