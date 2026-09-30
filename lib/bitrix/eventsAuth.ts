import { timingSafeEqual } from 'crypto';

// Аутентификация вебхука событий бота «Аналитик» (/api/bitrix/events).
//
// Аудит 09.09: роут был открыт — добавили проверку домена и токена, но при
// незаданном BITRIX_EVENTS_APP_TOKEN события ПРИНИМАЛИСЬ (домен подделывается
// телом запроса). Аудит 29.09 (#8256, A7): теперь fail-closed —
//   * домен обязан совпасть с BITRIX_PORTAL_DOMAIN (дефолт td.monolit-crm.ru);
//   * BITRIX_EVENTS_APP_TOKEN обязан быть задан и совпасть с auth[application_token]
//     (constant-time); не задан — отказ всем событиям.
// Значение токена в лог не пишется — только факт отказа и первые 4 символа
// полученного токена (tokenHint), чтобы сверить с источником.
// Значение для env = auth[application_token] из событий Битрикса (36 символов).
export const DEFAULT_PORTAL_DOMAIN = 'td.monolit-crm.ru';

export type EventsEnv = Record<string, string | undefined>;

/** Первые 4 символа токена для лога — само значение не логируется никогда. */
export function tokenHint(token: string | undefined): string {
  return token ? `${token.slice(0, 4)}…(${token.length})` : '<пусто>';
}

export function pickAuth(data: Record<string, unknown>): { token: string; domain: string } {
  // form-data: плоские ключи auth[application_token] / auth[domain];
  // JSON: вложенный объект auth: { application_token, domain }.
  const nested = (data.auth && typeof data.auth === 'object' ? data.auth : {}) as Record<string, unknown>;
  const token = String(data['auth[application_token]'] ?? nested.application_token ?? '');
  const domain = String(data['auth[domain]'] ?? nested.domain ?? '');
  return { token, domain: domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type EventsAuthResult =
  | { ok: true }
  | { ok: false; reason: 'domain' | 'token_not_configured' | 'token_mismatch'; hint: string };

export function authenticateBitrixEvent(data: Record<string, unknown>, env: EventsEnv = process.env): EventsAuthResult {
  const { token, domain } = pickAuth(data);
  const expectedDomain = (env.BITRIX_PORTAL_DOMAIN || DEFAULT_PORTAL_DOMAIN).toLowerCase();
  if (domain !== expectedDomain) return { ok: false, reason: 'domain', hint: tokenHint(token) };
  const expectedToken = env.BITRIX_EVENTS_APP_TOKEN || '';
  if (!expectedToken) return { ok: false, reason: 'token_not_configured', hint: tokenHint(token) };
  if (!token || !safeEqual(token, expectedToken)) return { ok: false, reason: 'token_mismatch', hint: tokenHint(token) };
  return { ok: true };
}
