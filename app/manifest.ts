import type { MetadataRoute } from 'next';

// Web App Manifest (задача 2764, «ЛК как мобильное приложение»). Next.js сам
// сервит это на /manifest.webmanifest и добавляет <link rel="manifest"> в
// <head> — руками ничего линковать не нужно (file convention app/manifest.ts).
//
// start_url — /profile: у BI-дашборда в целом нет единого «дефолтного экрана», но у
// ЛК он есть, и именно ЛК владелец просит «поставить на экран»
// (см. owners-inbox/analsteroid-mobile-readiness.md). Без сессии уводит на /login —
// ожидаемое поведение, не баг манифеста.
//
// Задача 3045: адрес ЛК переехал /manager/me → /profile, поэтому здесь тоже /profile
// (по §5 спеки установленное PWA стартует в ЛК ВСЕМ, включая РОПа и директора — на
// телефоне человек открывает приложение «посмотреть себя», а не строить отчёты).
//
// `id` НЕ меняем и не будем: для браузера id — тождество установленного приложения.
// Смена id превращает уже поставленное на телефон приложение в «другое» — иконка на
// домашнем экране становится мёртвой, нужна переустановка вручную. Поэтому id остаётся
// историческим '/manager/me' навсегда, даже когда такого маршрута не станет; это не
// адрес перехода, а строка-идентификатор.
//
// Иконки — public/icons/, сгенерированы из public/icons/icon-mark.svg
// скриптом scripts/generate-pwa-icons.mjs (см. его шапку про регенерацию).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/manager/me',
    name: 'Монолитика',
    short_name: 'Монолитика',
    description: 'Личный кабинет менеджера и BI-аналитика продаж «Монолитика»',
    start_url: '/profile',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f8f9fa',
    theme_color: '#228be6',
    lang: 'ru',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
