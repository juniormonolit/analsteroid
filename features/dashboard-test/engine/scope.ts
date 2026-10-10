import { createHash } from 'node:crypto';
import { scopeManagerIds, type SessionScope } from '@/lib/org/sessionScope';

// Ключ кэша «Дашборда» по срезу данных сессии: без ограничения — 'all', иначе хэш
// отсортированного набора менеджеров (люди с одним срезом делят кэш).
export function scopeCacheKey(scope?: SessionScope): string {
  const ids = scope ? scopeManagerIds(scope) : null;
  if (!ids) return 'all';
  return 'm' + createHash('sha1').update([...ids].sort().join(',')).digest('hex').slice(0, 16);
}
