import { redisReady } from '@/lib/cache/redis';
import { bitrixPortalOrigin } from './appAuth';

// Токен приложения Битрикса (AUTH_ID из POST на /api/bitrix/app) — хранится в
// Redis на срок жизни токена (у Битрикса ~1 час). Нужен для методов, которые
// вебхуку недоступны («Application context required»): placement.bind/get/unbind —
// пункт «Монолитика» в левом меню портала для всех сотрудников (задача 17.09).

const TTL_SEC = 55 * 60;
const key = (userId: string) => `bxapp:token:${userId}`;

export async function rememberAppToken(userId: string, authId: string): Promise<void> {
  const r = await redisReady();
  if (!r) return;
  await r.set(key(userId), authId, 'EX', TTL_SEC).catch(() => {});
}

export async function getAppToken(userId: string): Promise<string | null> {
  const r = await redisReady();
  if (!r) return null;
  return r.get(key(userId)).catch(() => null);
}

export type BxResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string; description: string };

/** REST-вызов от имени приложения (токеном пользователя, открывшего приложение). */
export async function bxApp<T = unknown>(authId: string, method: string, params: Record<string, unknown> = {}): Promise<BxResult<T>> {
  const origin = bitrixPortalOrigin();
  if (!origin) return { ok: false, error: 'NO_PORTAL', description: 'Не задан адрес портала' };
  try {
    const res = await fetch(`${origin}/rest/${method}.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, auth: authId }),
      signal: AbortSignal.timeout(15_000), cache: 'no-store',
    });
    const body = await res.json().catch(() => ({})) as { result?: T; error?: string; error_description?: string };
    if (!res.ok || body.error) return { ok: false, error: body.error ?? `HTTP ${res.status}`, description: body.error_description ?? '' };
    return { ok: true, result: body.result as T };
  } catch (e) {
    return { ok: false, error: 'NETWORK', description: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Снять привязки placement с тем же путём обработчика, но другим доменом — хвосты
 * прошлых адресов (переезд .com → .ru 09.11: без этого в меню Битрикса висел бы
 * второй пункт на мёртвый домен). Возвращает снятые обработчики.
 */
export async function unbindStaleHandlers(authId: string, placements: readonly string[], currentHandler: string): Promise<string[]> {
  const cur = new URL(currentHandler);
  const r = await bxApp<{ placement: string; handler: string }[]>(authId, 'placement.get');
  if (!r.ok) return [];
  const removed: string[] = [];
  for (const b of r.result ?? []) {
    if (!placements.includes(b.placement)) continue;
    let h: URL;
    try { h = new URL(b.handler); } catch { continue; }
    if (h.origin === cur.origin || h.pathname.replace(/\/$/, '') !== cur.pathname.replace(/\/$/, '')) continue;
    const u = await bxApp(authId, 'placement.unbind', { PLACEMENT: b.placement, HANDLER: b.handler });
    if (u.ok) removed.push(`${b.placement} ${b.handler}`);
  }
  return removed;
}
