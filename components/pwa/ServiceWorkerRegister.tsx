'use client';
import { useEffect } from 'react';
import { useAppMode } from '@/lib/hooks/useAppMode';

/**
 * Регистрация service worker'а — офлайн-заглушка (задача 2947, П2.8 плана
 * мобильной готовности; сам SW — public/sw.template.js, сгенерированный
 * public/sw.js). Один компонент, подключён один раз из корневого
 * app/layout.tsx — та же дисциплина, что useAppMode/useUrlState («одно
 * место знает, как это делается», см. DESIGN_GUIDELINES.md).
 *
 * НЕ регистрируем внутри iframe портала Битрикса (`isBitrixIframe` из
 * useAppMode) — там приложение живёт в чужом хроме портала, отдельный SW/
 * офлайн-режим не имеет смысла и не запрошен владельцем (мобильная
 * готовность — про standalone/browser-режимы ЛК, не про встраивание).
 */
export function ServiceWorkerRegister() {
  const { isBitrixIframe } = useAppMode();

  useEffect(() => {
    if (isBitrixIframe) return;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    let refreshing = false;
    // Стратегия обновления (важнее самой заглушки — см. комментарий в
    // sw.template.js): когда НОВЫЙ SW берёт под контроль страницу
    // (skipWaiting+clients.claim внутри самого SW), перезагружаем ОДИН раз,
    // чтобы открытая вкладка гарантированно подхватила актуальную версию, а
    // не осталась висеть со старым контроллером. Флаг `refreshing` защищает
    // от повторного/каскадного reload, если событие вдруг прилетит дважды.
    const onControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Регистрация — best-effort: если SW не завёлся (старый браузер,
      // корпоративная политика и т.п.), приложение работает как обычно,
      // просто без офлайн-заглушки. Ничего не блокируем и не показываем
      // пользователю.
    });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, [isBitrixIframe]);

  return null;
}
