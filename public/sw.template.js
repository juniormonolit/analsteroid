// Service worker «Монолитики» — офлайн-заглушка (задача 2947, П2.8 плана
// мобильной готовности). Источник правды — ЭТОТ файл; public/sw.js
// (собственно то, что регистрирует браузер) — сборочный артефакт,
// генерируется скриптом scripts/generate-sw.mjs автоматически перед КАЖДЫМ
// `next build`/`next dev` (см. package.json → "prebuild"/"predev"), который
// подставляет вместо __SW_VERSION__ момент сборки. Руками public/sw.js не
// редактировать — правки в generate-sw.mjs их перезапишут.
//
// НАМЕРЕННО НЕ ДЕЛАЕТ offline-first кэширование страниц/JS/API. Причина —
// владелец приложения предупредил: «сломанный SW хуже его отсутствия», а у
// проекта частые выкатки. Классический баг PWA — SW отдаёт из кэша старый
// HTML/чанки после деплоя, и пользователь «залипает» на прошлой версии, пока
// не почистит кэш руками. Этот SW НЕ кэширует ни один Next-роут, ни один
// хэшированный чанк, ни один API-ответ — единственное, что он делает:
//   1. На навигационных запросах (переход по ссылке/адресу) сперва идёт в
//      сеть; если сеть недоступна (реальный офлайн, не 4xx/5xx с сервера) —
//      отдаёт статичную заглушку /offline.html из версионированного кэша.
//   2. Всё остальное (JS/CSS/RSC-данные/API/иконки) SW вообще не трогает —
//      event.respondWith() для них не вызывается, запрос идёт как обычно
//      мимо service worker. Значит НЕЧЕМУ протухать: свежий деплой всегда
//      долетает до пользователя как обычная сетевая загрузка.
// Итог: «нет сети» показывает приятный экран вместо ошибки браузера, но сам
// SW не может подсунуть устаревшую версию приложения — потому что ничего из
// самого приложения не кэширует.

const SW_VERSION = '__SW_VERSION__';
const CACHE_NAME = `analsteroid-offline-shell-${SW_VERSION}`;
const OFFLINE_URL = '/offline.html';
// Иконка на заглушке — уже существующий PWA-артефакт (public/icons/,
// scripts/generate-pwa-icons.mjs), отдельную картинку под офлайн-экран не
// заводим.
const PRECACHE_URLS = [OFFLINE_URL, '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // skipWaiting — новая версия SW активируется сразу, не дожидаясь
      // закрытия всех вкладок со старой версией (это ЧАСТЬ стратегии
      // обновления, не просто ускорение — без него старый SW мог бы
      // годами оставаться активным controller'ом у пользователя, который
      // не закрывает вкладку).
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith('analsteroid-offline-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ))
      // clients.claim — новый SW сразу берёт под управление уже открытые
      // вкладки (вместо ожидания следующей полной перезагрузки).
      .then(() => self.clients.claim()),
  );
});

// Ручной триггер на будущее (например, кнопка «Проверить обновление» в UI) —
// сейчас skipWaiting уже вызывается автоматически при install, этот
// обработчик — защитный запасной путь, ничего не ломает, если не используется.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Только навигация (переход по адресу/ссылке, включая обновление F5).
  // Всё остальное — мимо SW, см. комментарий в шапке файла.
  if (request.mode !== 'navigate') return;

  event.respondWith(
    fetch(request).catch(() =>
      caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error()),
    ),
  );
});
