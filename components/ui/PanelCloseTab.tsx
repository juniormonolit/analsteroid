'use client';
import { X } from 'lucide-react';

interface PanelCloseTabProps {
  onClick: () => void;
  /** Позиционирование по вертикали — ближе к верху панели по умолчанию. */
  topClassName?: string;
  className?: string;
  /** Точечный оверрайд позиции (напр. `{ left: '10%', transform: 'translateX(-50%)' }`
   * для дрилл-дауна/сравнения, где левый край панели — не фиксированная ширина, а `10%`
   * от экрана). Если передан `left` — дефолтный `-left-[30px]` не применяется. */
  style?: React.CSSProperties;
}

/**
 * Единая кнопка закрытия для правых слайд-панелей (карточка сделки, дрилл-даун,
 * сравнение, настройки метрики, импорт/экспорт планов, ченджлог — п. Н3 спеки):
 * КВАДРАТНЫЙ ярлычок 30×30, торчащий с ЛЕВОГО края панели НАРУЖУ (правка владельца
 * 09.07, уточнение того же дня — вернули выступающий ярлычок вместо кнопки внутри
 * угла панели, но сделали его настоящим квадратом вместо вытянутого 56×28). Скругление
 * только внешних (левых) углов ~4px (`rounded-l-[4px]`), правая сторона вплотную к
 * панели — прямая. Синий фон, белый ×, тень.
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
      className={`hidden sm:flex absolute ${topClassName} ${style?.left === undefined ? '-left-[30px]' : ''} z-10 h-[30px] w-[30px] items-center justify-center rounded-l-[4px] bg-[var(--color-accent)] text-[var(--color-text-inverse)] shadow-lg hover:bg-[var(--color-accent-hover)] transition-colors ${className}`}
    >
      <X size={17} strokeWidth={2.5} />
    </button>
  );
}
