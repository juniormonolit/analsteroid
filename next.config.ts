import type { NextConfig } from 'next';
import path from 'path';

// Кого пускаем встраивать нас в iframe (задача 30.07, приложение в Битрикс24).
// Портал берём из окружения, чтобы дев/прод и возможная смена адреса не требовали
// правки кода; ниже — дефолт на действующий портал.
const BITRIX_PORTAL = (process.env.BITRIX_PORTAL_URL
  ?? process.env.BITRIX_WEBHOOK_URL
  ?? 'https://td.monolit-crm.ru');
let portalOrigin = 'https://td.monolit-crm.ru';
try { portalOrigin = new URL(BITRIX_PORTAL).origin; } catch { /* оставляем дефолт */ }

const nextConfig: NextConfig = {
  output: 'standalone',
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        // Встроенные страницы: фреймить может только портал (и мы сами).
        source: '/bx/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: `frame-ancestors 'self' ${portalOrigin}` },
        ],
      },
      {
        // ЛК целиком (правка владельца 05.08: «в локальное приложение Битрикса
        // надо выводить по сути /profile»). Раньше внутри портала жила ОТДЕЛЬНАЯ
        // страница /bx/manager с одной карточкой — все новые разделы (Движуха,
        // Коллеги, Кошелёк, Награды, Заявки, Уведомления) внутри Битрикса были
        // недостижимы, потому что ссылки ведут на /profile/*, а фреймить их
        // запрещал CSP ниже. Открываем портлу именно ЛК — и только его:
        // /home, /settings и отчёты по-прежнему не фреймятся.
        source: '/profile/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: `frame-ancestors 'self' ${portalOrigin}` },
        ],
      },
      {
        // Обработчик входа тоже открывается ВНУТРИ iframe портала — под общий
        // запрет ниже он попасть не должен, иначе приложение не откроется вовсе.
        source: '/api/bitrix/app',
        headers: [
          { key: 'Content-Security-Policy', value: `frame-ancestors 'self' ${portalOrigin}` },
        ],
      },
      {
        // Всё остальное фреймить нельзя — до сих пор заголовка не было вообще,
        // то есть встроить приложение в свой сайт мог любой (кликджекинг).
        source: '/((?!bx/|profile|api/bitrix/app).*)',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default nextConfig;
