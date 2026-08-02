import type { MetadataRoute } from 'next';

// Web App Manifest (задача 2764, «ЛК как мобильное приложение»). Next.js сам
// сервит это на /manifest.webmanifest и добавляет <link rel="manifest"> в
// <head> — руками ничего линковать не нужно (file convention app/manifest.ts).
//
// start_url — /manager/me: у BI-дашборда в целом нет единого «дефолтного
// экрана», но у ЛК менеджера он есть, и именно ЛК — то, что владелец просит
// «поставить на экран» (см. owners-inbox/analsteroid-mobile-readiness.md).
// До релиза системы авторизации /manager/me без сессии уводит на /login —
// это ожидаемое промежуточное поведение, не баг манифеста.
//
// Иконки — public/icons/, сгенерированы из public/icons/icon-mark.svg
// скриптом scripts/generate-pwa-icons.mjs (см. его шапку про регенерацию).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/manager/me',
    name: 'Монолитика',
    short_name: 'Монолитика',
    description: 'Личный кабинет менеджера и BI-аналитика продаж «Монолитика»',
    start_url: '/manager/me',
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
