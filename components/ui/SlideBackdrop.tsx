'use client';

/** Единый цвет/прозрачность затемнения фона под выезжающими справа панелями (правка
 * владельца 09.07: «затемнение везде одинаково», эталон — ChangelogPanel). Используется
 * и здесь (константа), и напрямую в панелях с иной вёрсткой оверлея (полоска-подложка
 * ComparisonPanel/DrilldownDrawer, flex-задняя часть MetricEditor), где сам компонент
 * SlideBackdrop не подходит по разметке (не fixed inset-0, а часть flex-раскладки). */
export const SLIDE_BACKDROP_BG = 'bg-black/30';

interface SlideBackdropProps {
  closing: boolean;
  onClick: () => void;
  /** Переопределить z-index для вложенных панелей (карточка сделки поверх дрилл-дауна
   * требует более высокого z, чем базовый z-40) — передавать вместе с классом, например
   * `"z-[65]"`. По умолчанию — z-40, как у ченджлога. */
  className?: string;
}

/**
 * Затемняющая подложка правых слайд-панелей (карточка сделки, дрилл-даун, сравнение,
 * настройки метрики, импорт/экспорт планов, ченджлог, редактор метрики — п. Н3 спеки):
 * fixed inset-0, полупрозрачный чёрный, fade вместе с закрытием панели (useSlideClose),
 * клик по подложке закрывает панель. Тот же паттерн, что уже был у ChangelogPanel —
 * вынесен сюда, чтобы не копипастить в каждой панели по отдельности (правка 09.07).
 */
export function SlideBackdrop({ closing, onClick, className = 'z-40' }: SlideBackdropProps) {
  return (
    <div
      className={`fixed inset-0 ${SLIDE_BACKDROP_BG} slide-backdrop-fade ${className} ${closing ? 'opacity-0' : 'opacity-100'}`}
      onClick={onClick}
    />
  );
}
