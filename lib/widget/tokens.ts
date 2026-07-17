import { systemDb } from '@/lib/db/clients';

export interface WidgetTokenRow {
  token: string;
  label: string | null;
  created_at: string;
}

/** Резолв токена → user_id активного пользователя (не отозван, не удалён). */
export async function resolveWidgetTokenUser(token: string): Promise<string | null> {
  if (!token) return null;
  const res = await systemDb().query<{ user_id: string }>(
    `SELECT wt.user_id
       FROM widget_tokens wt
       JOIN users u ON u.id = wt.user_id
      WHERE wt.token = $1 AND wt.revoked_at IS NULL AND u.is_active = true`,
    [token],
  );
  return res.rows[0]?.user_id ?? null;
}

export async function listWidgetTokens(userId: string): Promise<WidgetTokenRow[]> {
  const res = await systemDb().query<WidgetTokenRow>(
    `SELECT token, label, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at
       FROM widget_tokens
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows;
}

export async function createWidgetToken(userId: string, label: string | null): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await systemDb().query(
    `INSERT INTO widget_tokens (token, user_id, label) VALUES ($1, $2, $3)`,
    [token, userId, label],
  );
  return token;
}

/** Отзыв (мягкий) токена пользователя. Возвращает true, если строка принадлежала юзеру. */
export async function revokeWidgetToken(userId: string, token: string): Promise<boolean> {
  const res = await systemDb().query(
    `UPDATE widget_tokens SET revoked_at = now()
      WHERE token = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [token, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Первый активный токен пользователя или новый (для «Отправить себе» — не плодим лишние). */
export async function ensureWidgetToken(userId: string): Promise<string> {
  const existing = await listWidgetTokens(userId);
  if (existing.length > 0) return existing[0].token;
  return createWidgetToken(userId, 'iPhone-виджет');
}
