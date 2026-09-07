import type { MetadataRoute } from 'next';

// Приложение закрытое, индексировать нечего; отдельно — публичные ТВ-страницы
// (/tv) и API телевизоров: роботам туда нельзя (задача 07.09, «запреты от роботов»).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: ['/tv', '/tv/', '/api/'] }],
  };
}
