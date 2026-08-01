// Уведомления ЛК (пакет Серёги 31.07) + пуши ботом «Аналитик».
// «Аналитик» — НЕ телеграм: это Bitrix24 imbot (BOT_ID 20761, вебхук imbot,
// lib/bitrix/notify.ts), менеджеры «привязаны» самим Битриксом — DIALOG_ID =
// их bitrix_user_id, отдельной таблицы чатов не нужно. Пуш — best-effort ПОСЛЕ
// коммита транзакции: падение Битрикса не откатывает бизнес-операцию,
// уведомление в ЛК создаётся всегда.

import type { Pool, PoolClient } from 'pg';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';

export type NotificationType =
  | 'transfer_in' | 'gift_in' | 'activation_resolved' | 'payout_resolved'
  | 'expiry_soon' | 'gacha_rare' | 'gacha_jackpot' | 'quest_done';

export interface NotificationInput {
  bitrixId: number;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
}

// В транзакции бизнес-операции: только строка в notifications.
export async function createNotification(db: Pool | PoolClient, n: NotificationInput): Promise<void> {
  await db.query(
    `INSERT INTO notifications (bitrix_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5)`,
    [n.bitrixId, n.type, n.title, n.body ?? null, n.link ?? null],
  );
}

// Пуш «Аналитиком» в Bitrix-чат менеджера. Вызывать ПОСЛЕ коммита; не бросает.
export async function pushViaAnalitik(bitrixId: number, title: string, body?: string | null): Promise<void> {
  try {
    const msg = body ? `[b]${title}[/b]\n${body}` : `[b]${title}[/b]`;
    await sendBitrixBotMessage(String(bitrixId), msg);
  } catch (e) {
    console.warn(`[notify] пуш Аналитиком менеджеру ${bitrixId} не ушёл:`, e instanceof Error ? e.message : e);
  }
}

// Удобный комбо-помощник вне транзакций.
export async function notifyAndPush(db: Pool, n: NotificationInput): Promise<void> {
  await createNotification(db, n);
  void pushViaAnalitik(n.bitrixId, n.title, n.body);
}
