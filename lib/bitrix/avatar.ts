// Аватар пользователя из Битрикса (user.get → PERSONAL_PHOTO), лениво с TTL —
// вызывается из GET /api/me. Крон не нужен: аватар нужен только активным пользователям.

import { systemDb } from '@/lib/db/clients';
import { bx } from './notify';

const SYNC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function ensureAvatar(
  userId: string,
  bitrixUserId: string | null,
  avatarSyncedAt: Date | null,
): Promise<string | null> {
  if (!bitrixUserId) return null;
  if (avatarSyncedAt && Date.now() - new Date(avatarSyncedAt).getTime() < SYNC_TTL_MS) return null;

  const db = systemDb();
  try {
    const webhook = process.env.BITRIX_WEBHOOK_URL || '';
    const body = await bx(webhook, 'user.get', { ID: bitrixUserId });
    const photo = body?.result?.[0]?.PERSONAL_PHOTO;
    const url = typeof photo === 'string' && photo ? photo : null;
    await db.query(
      `UPDATE users SET avatar_url = $1, avatar_synced_at = now() WHERE id = $2`,
      [url, userId]
    );
    return url;
  } catch (e) {
    // Битрикс недоступен — не долбим его на каждый заход, но и не роняем /api/me
    console.warn('[avatar] sync failed:', e instanceof Error ? e.message : e);
    await db
      .query(`UPDATE users SET avatar_synced_at = now() WHERE id = $1`, [userId])
      .catch(() => {});
    return null;
  }
}
