// OAuth для MCP-коннектора Claude (миграция 246). Монолитика сама себе authorization
// server: Claude (claude.ai / Desktop / Code) находит нас через /.well-known/*, регистрирует
// клиента (DCR, RFC 7591), уводит человека на /oauth/authorize — там обычная сессия
// Монолитики и кнопка «Разрешить», — потом меняет code на токены (PKCE S256).
//
// Почему не статический токен: в коннекторе Claude он один на всю организацию, а у нас
// права персональные (директор филиала видит свой филиал). Токен = конкретный users.id,
// дальше работает тот же срез сессии, что у роутов (lib/org/sessionScope.ts).
//
// В БД — только sha256 токенов и кодов: утечка таблицы не даёт доступ.
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';

export const MCP_PERM = 'action.mcp' as const;

export const ACCESS_TTL_S = 60 * 60;            // час — Claude сам освежает refresh-токеном
export const REFRESH_TTL_S = 60 * 24 * 60 * 60; // 60 дней без использования — переподключить
const CODE_TTL_S = 5 * 60;
const REQUEST_TTL_S = 15 * 60;

/** Публичный адрес Монолитики. resource в метаданных обязан СТРОГО совпадать с URL,
 *  который человек вставил в коннектор, поэтому берём из env, а не из заголовков прокси. */
export function publicBaseUrl(): string {
  return (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.com').replace(/\/$/, '');
}
export const mcpResourceUrl = () => `${publicBaseUrl()}/api/mcp`;

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function token(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** Кому можно подключать Claude. Супер-админ — всегда (hasPerm), остальным право выдаётся
 *  ролью явно («Настройки → Роли»): джокер section.* действия не покрывает. */
export function canUseMcp(session: SessionUser | null): boolean {
  return hasPerm(session, MCP_PERM);
}

// ── Redirect URI ────────────────────────────────────────────────────────────────────
//
// Регистрировать клиента может кто угодно (так устроен DCR), поэтому список адресов
// возврата закрыт: иначе чужой «клиент» получил бы code на свой домен, показав человеку
// нашу же страницу согласия. Claude: один фиксированный callback для claude.ai / Desktop /
// мобильного; Claude Code — loopback с любым портом.
const ALLOWED_REDIRECTS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

export function isAllowedRedirect(uri: string): boolean {
  if (ALLOWED_REDIRECTS.has(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** redirect_uri запроса совпадает с зарегистрированным (у loopback порт не важен — RFC 8252 §7.3). */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try { req = new URL(requested); } catch { return false; }
  if (req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') return false;
  return registered.some(r => {
    try {
      const u = new URL(r);
      return u.protocol === req.protocol && u.hostname === req.hostname && u.pathname === req.pathname;
    } catch { return false; }
  });
}

// ── Клиенты (DCR) ───────────────────────────────────────────────────────────────────

export interface OAuthClient { clientId: string; clientName: string | null; redirectUris: string[] }

export async function registerClient(name: string | null, redirectUris: string[]): Promise<OAuthClient> {
  const clientId = `mcpc_${randomBytes(16).toString('base64url')}`;
  await systemDb().query(
    `INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)`,
    [clientId, name, redirectUris],
  );
  return { clientId, clientName: name, redirectUris };
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const r = await systemDb().query<{ client_id: string; client_name: string | null; redirect_uris: string[] }>(
    `SELECT client_id, client_name, redirect_uris FROM mcp_oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  const row = r.rows[0];
  return row ? { clientId: row.client_id, clientName: row.client_name, redirectUris: row.redirect_uris } : null;
}

// ── Согласие и code ─────────────────────────────────────────────────────────────────

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string | null;
  resource: string | null;
}

/** Запоминаем параметры показанной страницы согласия; кнопка «Разрешить» шлёт только id. */
export async function createConsentRequest(userId: string, p: AuthorizeParams): Promise<string> {
  const id = randomBytes(24).toString('base64url');
  await systemDb().query(
    `INSERT INTO mcp_oauth_requests (id, user_id, client_id, redirect_uri, code_challenge, state, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))`,
    [id, userId, p.clientId, p.redirectUri, p.codeChallenge, p.state, p.scope, p.resource, REQUEST_TTL_S],
  );
  return id;
}

/** Забрать (и удалить) запрос согласия — только свой и не просроченный. */
export async function takeConsentRequest(id: string, userId: string): Promise<AuthorizeParams | null> {
  const r = await systemDb().query<{
    client_id: string; redirect_uri: string; code_challenge: string; state: string | null; scope: string | null; resource: string | null;
  }>(
    `DELETE FROM mcp_oauth_requests WHERE id = $1 AND user_id = $2 AND expires_at > now()
     RETURNING client_id, redirect_uri, code_challenge, state, scope, resource`,
    [id, userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge,
    state: row.state, scope: row.scope, resource: row.resource,
  };
}

export async function issueCode(userId: string, p: AuthorizeParams): Promise<string> {
  const code = token('mlt_code_');
  await systemDb().query(
    `INSERT INTO mcp_oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [sha256(code), userId, p.clientId, p.redirectUri, p.codeChallenge, p.scope, p.resource, CODE_TTL_S],
  );
  return code;
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Погасить code (одноразово). null — нет, просрочен, уже использован или чужой клиент. */
export async function redeemCode(code: string, clientId: string, redirectUri: string): Promise<{
  userId: string; codeChallenge: string; scope: string | null;
} | null> {
  const r = await systemDb().query<{ user_id: string; code_challenge: string; scope: string | null }>(
    `UPDATE mcp_oauth_codes SET used_at = now()
      WHERE code_hash = $1 AND client_id = $2 AND redirect_uri = $3 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, code_challenge, scope`,
    [sha256(code), clientId, redirectUri],
  );
  const row = r.rows[0];
  return row ? { userId: row.user_id, codeChallenge: row.code_challenge, scope: row.scope } : null;
}

// ── Токены ──────────────────────────────────────────────────────────────────────────

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number; scope: string | null }

export async function issueTokens(userId: string, clientId: string, scope: string | null, grantId?: string): Promise<TokenPair> {
  const accessToken = token('mlt_at_');
  const refreshToken = token('mlt_rt_');
  const grant = grantId ?? randomBytes(16).toString('base64url');
  await systemDb().query(
    `INSERT INTO mcp_tokens (token_hash, kind, user_id, client_id, grant_id, scope, expires_at) VALUES
       ($1, 'access',  $3, $4, $5, $6, now() + make_interval(secs => $7)),
       ($2, 'refresh', $3, $4, $5, $6, now() + make_interval(secs => $8))`,
    [sha256(accessToken), sha256(refreshToken), userId, clientId, grant, scope, ACCESS_TTL_S, REFRESH_TTL_S],
  );
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_S, scope };
}

/** Ротация refresh-токена (публичный клиент — обязательно): старый гасится, выдаётся новая пара
 *  в той же выдаче. null — токен не найден/просрочен/отозван → invalid_grant. */
export async function rotateRefresh(refreshToken: string, clientId: string): Promise<TokenPair | null> {
  const r = await systemDb().query<{ user_id: string; grant_id: string; scope: string | null }>(
    `UPDATE mcp_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id, grant_id, scope`,
    [sha256(refreshToken), clientId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return issueTokens(row.user_id, clientId, row.scope, row.grant_id);
}

/** users.id по access-токену из заголовка Authorization. */
export async function userIdByAccessToken(accessToken: string): Promise<string | null> {
  if (!accessToken.startsWith('mlt_at_')) return null;
  const r = await systemDb().query<{ user_id: string }>(
    `UPDATE mcp_tokens SET last_used_at = now()
      WHERE token_hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [sha256(accessToken)],
  );
  return r.rows[0]?.user_id ?? null;
}

export async function revokeGrant(grantId: string, userId: string): Promise<void> {
  await systemDb().query(
    `UPDATE mcp_tokens SET revoked_at = now() WHERE grant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [grantId, userId],
  );
}
