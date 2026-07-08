'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Длительность exit-анимации слайд-панелей — держим в паре с .slide-panel-out-* в globals.css. */
export const SLIDE_CLOSE_MS = 180;

/**
 * Плавное закрытие правых/левых слайд-панелей (карточка сделки, дрилл-даун, настройки,
 * импорт/экспорт планов — п. Н3 спеки). Панель остаётся смонтированной ~180ms дольше,
 * проигрывает exit-класс (`slide-panel-out-right`/`-left`), и только потом вызывает
 * реальный onClose (размонтирование родителем). При prefers-reduced-motion CSS-анимация
 * отключается сама (globals.css), но задержка перед onClose остаётся — безопасно и не
 * ломает эффекты вызывающего кода.
 */
export function useSlideClose(onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const requestClose = useCallback(() => {
    setClosing(closingNow => {
      if (closingNow) return closingNow;
      timerRef.current = setTimeout(() => onCloseRef.current(), SLIDE_CLOSE_MS);
      return true;
    });
  }, []);

  return { closing, requestClose };
}
