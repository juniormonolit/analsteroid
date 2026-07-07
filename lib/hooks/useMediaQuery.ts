'use client';
import { useSyncExternalStore } from 'react';

/**
 * SSR-безопасный медиазапрос. На сервере (и до гидрации) возвращает `false`,
 * поэтому ветку «мобильный UI» рендерить только после маунта — иначе flash.
 * Для чисто визуальных различий предпочитать Tailwind-префиксы (md:, lg:),
 * хук — только когда реально нужна другая структура DOM/логика.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** < 768px — телефоны. Совпадает с Tailwind-брейкпоинтом md. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

/** 768–1023px — планшеты (между md и lg). */
export function useIsTablet(): boolean {
  return useMediaQuery('(min-width: 768px) and (max-width: 1023px)');
}

/** Устройство без hover (тач). Для решений «показывать ли hover-функции». */
export function useIsTouch(): boolean {
  return useMediaQuery('(hover: none)');
}
