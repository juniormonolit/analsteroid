// Аватар произвольного менеджера из Битрикса (ЛК менеджера, «Карточка 10.0»).
// Тот же ленивый паттерн, что lib/bitrix/avatar.ts для пользователей приложения:
// кэш в manager_avatars (system DB, миграция 106) с TTL 7 дней; неудача тоже
// штампует synced_at, чтобы не долбить Битрикс на каждое открытие карточки.

import { systemDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';

const SYNC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getManagerAvatarUrl(bitrixUserId: string): Promise<string | null> {
  if (!/^\d+$/.test(bitrixUserId)) return null;
  const db = systemDb();

  try {
    const cached = await db.query<{ avatar_url: string | null; synced_at: string }>(
      'SELECT avatar_url, synced_at FROM manager_avatars WHERE bitrix_user_id = $1',
      [bitrixUserId],
    );
    const row = cached.rows[0];
    if (row && Date.now() - new Date(row.synced_at).getTime() < SYNC_TTL_MS) return row.avatar_url;

    const webhook = process.env.BITRIX_WEBHOOK_URL || '';
    if (!webhook) return row?.avatar_url ?? null;

    let url: string | null = null;
    try {
      const body = await bx(webhook, 'user.get', { ID: bitrixUserId });
      url = body?.result?.[0]?.PERSONAL_PHOTO ?? null;
    } catch (e) {
      console.warn('[managerAvatar] user.get не удался:', e instanceof Error ? e.message : e);
      // штампуем synced_at со старым значением — не ретраим до истечения TTL
      url = row?.avatar_url ?? null;
    }

    await db.query(
      `INSERT INTO manager_avatars (bitrix_user_id, avatar_url, synced_at) VALUES ($1, $2, NOW())
       ON CONFLICT (bitrix_user_id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url, synced_at = NOW()`,
      [bitrixUserId, url],
    );
    return url;
  } catch (e) {
    // Таблицы может не быть до миграции 106 — карточка не должна падать из-за аватарки.
    console.warn('[managerAvatar] кэш недоступен:', e instanceof Error ? e.message : e);
    return null;
  }
}
