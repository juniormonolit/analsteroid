'use client';
import { useSyncExternalStore } from 'react';
import { useIsMobile } from './useMediaQuery';

/**
 * Единый механизм определения режима запуска приложения (задача 2764, «ЛК как
 * мобильное приложение»). Контракт задокументирован в
 * `ai_docs/fresh_docs/DESIGN_GUIDELINES.md`, раздел «Режимы запуска
 * (useAppMode)» — правило CLAUDE.md требует, чтобы ЛЮБОЙ новый UI, которому
 * нужно вести себя по-разному в зависимости от того, ГДЕ и КАК открыто
 * приложение, спрашивал этот хук, а не писал заново свою проверку
 * `window.self`/`matchMedia('display-mode')`/User-Agent. Если такая логика
 * разъедется по компонентам — она перестанет быть единой правдой, и будущие
 * доработки снова начнут изобретать частные проверки (ровно то, от чего этот
 * хук должен избавить один раз и навсегда).
 */
export type AppMode = 'bitrix-iframe' | 'standalone' | 'mobile' | 'desktop';

function neverChanges() {
  return () => {};
}

/**
 * Внутри iframe Битрикса. Снимок стабилен на всё время жизни страницы —
 * top-уровень фрейминга не меняется на лету, поэтому слушать нечего (в
 * отличие от media query ниже, которая может меняться при ресайзе/смене
 * ориентации). Та же проверка, что раньше жила только в
 * `components/bitrix/BitrixFrameFit.tsx` — теперь она здесь единственный раз.
 */
function useIsBitrixIframe(): boolean {
  return useSyncExternalStore(neverChanges, () => window.self !== window.top, () => false);
}

/**
 * Установлено на домашний экран / запущено как отдельное PWA-приложение (без
 * адресной строки браузера). `display-mode: standalone` — актуальный
 * стандарт, работает в Chrome/Edge (Android и десктоп) и в современном iOS
 * Safari. `navigator.standalone` — легаси-флаг более старых версий iOS
 * Safari, где `display-mode` ещё не поддерживался надёжно; проверяем оба,
 * чтобы не терять старые устройства молча.
 */
function useIsStandalonePwa(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia('(display-mode: standalone)');
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () =>
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
    () => false,
  );
}

export interface AppModeInfo {
  /**
   * Режим запуска — приоритет сверху вниз, это ИЕРАРХИЯ, а не взаимоисключающие
   * независимые признаки:
   * 1. `bitrix-iframe` — определяется раньше всего и перекрывает остальное:
   *    внутри портала Битрикса неважно, с телефона его открыли или с
   *    десктопа (мобильное приложение Битрикс24 тоже рисует iframe) —
   *    поведение внутри портала должно быть предсказуемым независимо от
   *    устройства.
   * 2. `standalone` — установленное на домашний экран приложение (вне iframe).
   * 3. `mobile` / `desktop` — обычный браузер, по ширине вьюпорта.
   */
  mode: AppMode;
  /**
   * Раскладка «как на телефоне» (узкий вьюпорт, `<768px` — тот же порог, что
   * `useIsMobile`/Tailwind `md:`). Для большинства UI-решений («нижний
   * таб-бар вместо сайдбара», доп. отступы) нужен именно этот флаг, а не
   * сравнение `mode === 'mobile'` — standalone тоже почти всегда узкий
   * (обычный случай — установка на телефон), но теоретически может быть и
   * widescreen (PWA, установленное на десктопе). `isMobileLayout` отвечает
   * за раскладку, `mode` — за то, откуда и как запущено приложение.
   */
  isMobileLayout: boolean;
  isBitrixIframe: boolean;
  isStandalone: boolean;
}

export function useAppMode(): AppModeInfo {
  const isBitrixIframe = useIsBitrixIframe();
  const isStandalone = useIsStandalonePwa();
  const isMobileLayout = useIsMobile();

  const mode: AppMode = isBitrixIframe
    ? 'bitrix-iframe'
    : isStandalone
      ? 'standalone'
      : isMobileLayout
        ? 'mobile'
        : 'desktop';

  return { mode, isMobileLayout, isBitrixIframe, isStandalone };
}
