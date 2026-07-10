import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Монолитика',
  description: 'BI-аналитика продаж',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // viewportFit=cover — чтобы работали env(safe-area-inset-*) на iPhone с вырезом
  viewportFit: 'cover',
};

// Анти-вспышка тёмной темы (владелец утвердил макет, задача Николая): читает зеркало
// localStorage.theme и ставит data-theme НА <html> ДО первой отрисовки — обычный
// inline-script в <head>, выполняется синхронно раньше React/гидратации, поэтому нет
// «моргания» светлым перед перекраской. Работает и на /login (неавторизован, но
// зеркало в localStorage уже могло остаться от предыдущей сессии — п.4 брифа
// «Логин-страница тоже темнеет при тёмной, если тема известна из localStorage»).
// Дефолт (нет записи/ошибка) — светлая, атрибут не ставится вовсе.
const THEME_ANTI_FLASH_SCRIPT = `
try {
  if (localStorage.getItem('theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_ANTI_FLASH_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
