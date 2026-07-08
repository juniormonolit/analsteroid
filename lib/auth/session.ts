import { cache } from 'react';
import { cookies } from 'next/headers';
import { systemDb } from '@/lib/db/clients';

const COOKIE = 'as_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  login: string;
  displayName: string;
  isSuperadmin: boolean;
  permissions: string[]; // из роли (roles.permissions); [] если роль не назначена
  roleName: string | null;
  avatarUrl: string | null;
  bitrixUserId: string | null;
  // Тумблер «Обычная/Про» (п.3а спеки): null = ещё не переключал сам, дефолт по роли
  // считает effectiveUiMode() в lib/auth/perms.ts.
  uiMode: 'basic' | 'pro' | null;
}

// cache(): app-layout и section-layouts зовут getSession в одном запросе — БД дёргается один раз.
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;

  const db = systemDb();
  const res = await db.query<SessionUser & { expires_at: Date }>(
    `SELECT u.id, u.login, u.display_name AS "displayName",
            u.is_superadmin AS "isSuperadmin",
            COALESCE(r.permissions, '{}') AS "permissions",
            r.name AS "roleName",
            u.avatar_url AS "avatarUrl",
            u.bitrix_user_id AS "bitrixUserId",
            u.ui_mode AS "uiMode",
            s.expires_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE s.token = $1 AND u.is_active = true`,
    [token]
  );
  if (!res.rows.length) return null;
  const row = res.rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return {
    id: row.id,
    login: row.login,
    displayName: row.displayName,
    isSuperadmin: row.isSuperadmin,
    permissions: row.permissions ?? [],
    roleName: row.roleName,
    avatarUrl: row.avatarUrl,
    bitrixUserId: row.bitrixUserId,
    uiMode: row.uiMode,
  };
});

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const db = systemDb();
  await db.query(
    `INSERT INTO user_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, userId, expiresAt]
  );
  return token;
}

export async function deleteSession(token: string): Promise<void> {
  await systemDb().query(`DELETE FROM user_sessions WHERE token = $1`, [token]);
}

export const SESSION_COOKIE = COOKIE;
export const SESSION_TTL_DAYS = 7;
