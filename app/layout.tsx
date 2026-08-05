import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { APPLE_SPLASH_LINKS } from '@/lib/pwa/appleSplashScreens';

// PWA-метаданные (задача 2764, «ЛК как мобильное приложение»). Манифест —
// app/manifest.ts (Next сам линкует), иконки — app/apple-icon.png +
// public/icons/*.png (scripts/generate-pwa-icons.mjs). appleWebApp ниже
// рендерит apple-mobile-web-app-status-bar-style/-title и (только!) новый
// НЕпрефиксованный mobile-web-app-capable — проверено живьём на проде
// (curl /login), Next 16.2.9 apple-mobile-web-app-capable САМ не пишет,
// хотя это ровно тот тег, от которого на iOS Safari зависит полноэкранный
// запуск с домашнего экрана (без него на некоторых версиях iOS в
// standalone всё равно остаётся урезанная адресная строка). Дописан руками
// через `other` — не полагаться на то, что появится молча в будущей версии
// Next, тег обязателен явно.
export const metadata: Metadata = {
  title: 'Монолитика',
  description: 'BI-аналитика продаж',
  appleWebApp: {
    capable: true,
    // 'default' — статус-бар остаётся непрозрачным (безопасный выбор: контент
    // не залезает под системные часы/индикаторы). 'black-translucent' дал бы
    // полноэкранный вид, но требует safe-area-padding ВЕЗДЕ в шапке — сейчас
    // env(safe-area-inset-*) применён только в components/ui/Modal.tsx (см.
    // аудит), включать раньше, чем это закрыто — риск обрезанного контента
    // под чёлкой на iPhone.
    statusBarStyle: 'default',
    title: 'Монолитика',
  },
  other: {
    'apple-mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // viewportFit=cover — чтобы работали env(safe-area-inset-*) на iPhone с вырезом
  viewportFit: 'cover',
  // Цвет системной строки состояния/адресной строки браузера — те же токены,
  // что --color-bg светлой/тёмной темы (app/globals.css), чтобы не изобретать
  // отдельный «PWA-цвет» рассинхронизированный с самим приложением.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f9fa' },
    { media: '(prefers-color-scheme: dark)', color: '#14161b' },
  ],
};

// Анти-вспышка темы (владелец утвердил макет, задача Николая; расширено до трёх тем —
// light/dark/mono, задача 2999; до четырёх — 'classic', 04.08): читает зеркало
// localStorage.theme и ставит data-theme
// НА <html> ДО первой отрисовки — обычный inline-script в <head>, выполняется синхронно
// раньше React/гидратации, поэтому нет «моргания» светлым перед перекраской. Работает и
// на /login (неавторизован, но зеркало в localStorage уже могло остаться от предыдущей
// сессии — п.4 брифа «Логин-страница тоже темнеет при тёмной, если тема известна из
// localStorage»). Дефолт (нет записи/невалидное значение/ошибка) — 'classic' (решение
// владельца: по умолчанию у всех вид до редизайна), атрибут
// всё равно ставится явно (см. комментарий в lib/hooks/useTheme.ts — 'light' больше не
// «атрибут не ставится», т.к. mono и light должны различаться одним и тем же способом).
const THEME_ANTI_FLASH_SCRIPT = `
try {
  var t = localStorage.getItem('theme');
  document.documentElement.setAttribute('data-theme', ['classic','light','dark','mono'].indexOf(t) !== -1 ? t : 'classic');
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'classic');
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_ANTI_FLASH_SCRIPT }} />
        {/* iOS splash-экраны при запуске установленного приложения (задача
            2947) — Next Metadata API не типизирует apple-touch-startup-image
            (это не appleWebApp-опция), поэтому линкуем явными <link>,
            данные — lib/pwa/appleSplashScreens.ts. */}
        {APPLE_SPLASH_LINKS.map((s) => (
          <link key={s.href} rel="apple-touch-startup-image" href={s.href} media={s.media} />
        ))}
      </head>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
