import { redisReady } from '@/lib/cache/redis';
import { bitrixPortalOrigin } from './appAuth';

// Действия в Битриксе ОТ ИМЕНИ сотрудника (владелец 09.11: «Хули задачи ставятся от моего имени?»).
// Вебхук принадлежит владельцу портала (2098, Сергей Афанасьев) — даже с CREATED_BY = нажавший в истории
// задачи, ленте и уведомлениях Битрикс пишет «Сергей Афанасьев создал задачу». Действовать от чужого
// имени вебхук не умеет; умеет OAuth-токен самого сотрудника. Его выдаёт наше приложение в Битриксе:
// при каждом открытии «Монолитики» из портала приходят AUTH_ID (час) и REFRESH_ID (28 дней) —
// lib/bitrix/appEntry.ts сохраняет их сюда. Продлеваем refresh-токеном через oauth.bitrix.info, для этого
// нужны BITRIX_APP_CLIENT_ID / BITRIX_APP_CLIENT_SECRET (код и ключ локального приложения в Битриксе).
// Нет токена или ключей — вызывающий код откатывается на вебхук, как раньше.

const ACCESS_KEY = (uid: string) => `bxuser:access:${uid}`;
const REFRESH_KEY = (uid: string) => `bxuser:refresh:${uid}`;
const REFRESH_TTL = 27 * 86_400; // у Битрикса 28 дней

export async function saveUserTokens(bitrixUserId: string, accessToken: string, refreshToken: string | null, expiresInSec = 3600): Promise<void> {
  const r = await redisReady().catch(() => null);
  if (!r || !bitrixUserId || !accessToken) return;
  await r.set(ACCESS_KEY(bitrixUserId), accessToken, 'EX', Math.max(60, expiresInSec - 120)).catch(() => {});
  if (refreshToken) await r.set(REFRESH_KEY(bitrixUserId), refreshToken, 'EX', REFRESH_TTL).catch(() => {});
}

/** Действующий access-токен сотрудника (продлевает при необходимости) или null. */
export async function userAccessToken(bitrixUserId: string | null | undefined): Promise<string | null> {
  if (!bitrixUserId) return null;
  const r = await redisReady().catch(() => null);
  if (!r) return null;
  const access = await r.get(ACCESS_KEY(bitrixUserId)).catch(() => null);
  if (access) return access;
  const refresh = await r.get(REFRESH_KEY(bitrixUserId)).catch(() => null);
  const clientId = process.env.BITRIX_APP_CLIENT_ID, secret = process.env.BITRIX_APP_CLIENT_SECRET;
  if (!refresh || !clientId || !secret) return null;
  try {
    const u = new URL('https://oauth.bitrix.info/oauth/token/');
    u.search = new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: secret, refresh_token: refresh }).toString();
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; user_id?: number | string; error?: string };
    if (!j.access_token || (j.user_id !== undefined && String(j.user_id) !== String(bitrixUserId))) {
      console.warn(`[bitrix/user-token] не продлился токен ${bitrixUserId}: ${j.error ?? res.status}`);
      if (j.error === 'invalid_grant') await r.del(REFRESH_KEY(bitrixUserId)).catch(() => {});
      return null;
    }
    await saveUserTokens(bitrixUserId, j.access_token, j.refresh_token ?? refresh, Number(j.expires_in) || 3600);
    return j.access_token;
  } catch (e) {
    console.warn(`[bitrix/user-token] продление ${bitrixUserId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export class UserCallUnsure extends Error {}

/**
 * Запись в Битрикс от имени сотрудника. Возвращает result либо undefined — «от его имени не вышло,
 * делайте вебхуком» (нет токена, нет прав/scope у приложения, отказ метода). Сетевой сбой/таймаут —
 * UserCallUnsure: запрос мог пройти, повтор вебхуком задвоил бы задачу.
 */
export async function callAsUser<T>(bitrixUserId: string | null | undefined, method: string, params: Record<string, unknown>, retried = false): Promise<T | undefined> {
  const token = await userAccessToken(bitrixUserId);
  const origin = bitrixPortalOrigin();
  if (!token || !origin) return undefined;
  let res: Response;
  try {
    res = await fetch(`${origin}/rest/${method}.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, auth: token }),
      signal: AbortSignal.timeout(30_000), cache: 'no-store',
    });
  } catch (e) {
    throw new UserCallUnsure(`Битрикс ${method} от имени ${bitrixUserId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await res.json().catch(() => null) as { result?: T; error?: string; error_description?: string } | null;
  if (!body || body.error || body.result === undefined || body.result === null || (body.result as unknown) === false) {
    if (body?.error === 'expired_token' || body?.error === 'invalid_token') {
      const r = await redisReady().catch(() => null);
      await r?.del(ACCESS_KEY(String(bitrixUserId))).catch(() => {});
      if (!retried) return callAsUser<T>(bitrixUserId, method, params, true); // продлим refresh-токеном и ещё раз
    }
    console.warn(`[bitrix/user-token] ${method} от имени ${bitrixUserId} не вышел: ${body?.error ?? `HTTP ${res.status}`} ${body?.error_description ?? ''} — вебхуком`);
    return undefined;
  }
  return body.result;
}
