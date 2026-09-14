import type { MetadataRoute } from 'next';

// Приложение закрытое, индексировать нечего; отдельно — публичные страницы ТВ (/tv),
// дашборд /today и API телевизоров: роботам туда нельзя (задача 07.09 «запреты от
// роботов», плюс публичный /today от 14.09).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: ['/tv', '/tv/', '/today', '/api/'] }],
  };
}
