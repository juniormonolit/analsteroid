import type { MetadataRoute } from 'next';

// Приложение закрытое, индексировать нечего; отдельно — публичные страницы ТВ (/tv),
// дашборд /today и API телевизоров: роботам туда нельзя (задача 07.09 «запреты от
// роботов», плюс публичный /today от 14.09).
//
// ВНИМАНИЕ: на проде /robots.txt отдаёт НЕ этот файл, а Caddy (handle /robots.txt →
// /var/www/robots-noindex, «Disallow: /» на весь сайт) — проверено 14.09. Этот роут
// остаётся как дев-фолбэк и на случай смены конфигурации фронта; реальная защита от
// индексации — заголовки X-Robots-Tag (next.config.ts) и meta robots на страницах.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: ['/tv', '/tv/', '/today', '/api/'] }],
  };
}
