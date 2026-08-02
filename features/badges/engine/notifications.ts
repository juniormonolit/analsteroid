// Уведомления ЛК (пакет Серёги 31.07) + пуши ботом «Аналитик».
// «Аналитик» — НЕ телеграм: это Bitrix24 imbot (BOT_ID 20761, вебхук imbot,
// lib/bitrix/notify.ts), менеджеры «привязаны» самим Битриксом — DIALOG_ID =
// их bitrix_user_id, отдельной таблицы чатов не нужно. Пуш — best-effort ПОСЛЕ
// коммита транзакции: падение Битрикса не откатывает бизнес-операцию,
// уведомление в ЛК создаётся всегда.

import type { Pool, PoolClient } from 'pg';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { systemDb } from '@/lib/db/clients';

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

// ── ЭКСТРЕННЫЙ рубильник dry-run (правка владельца 02.08, задача 2765) ──────
// «Прям с этого момента начинаем dry-run. Сообщения формируем, логируем, но не
// отправляем. Хочу несколько дней потестировать без реального взаимодействия с
// менеджерами» — повод: пуши на ВСЕ события геймификации (#2759, ушло в прод
// сегодня) + готовящийся дайджест (#2765) вместе способны разослать реальным
// менеджерам необкатанную фичу без предупреждения (ближайший риск — ночной
// пересчёт наград 03:00 МСК, instrumentation.ts::scheduleBadgeRecompute).
//
// sendManagerBotMessage() — ЕДИНАЯ точка, откуда реально уходит imbot.message.add
// менеджеру: и pushViaAnalitik (вся геймификация — бейджи/квесты/контракты/
// гача/магазин/выплаты/переводы), и job'ы дайджеста/фидбека (lib/jobs/
// managerDigest.ts, lib/jobs/adviceFeedback.ts, задача 2765) идут ТОЛЬКО через
// неё — обойти рубильник, добавив прямой вызов sendBitrixBotMessage в новом
// коде, нельзя незаметно: это единственное место, где текст реально мог бы уйти
// в Bitrix для менеджерской аудитории. Владельческие/админские каналы (дневной
// отчёт МСК → 2098, деал-чаты РОП↔менеджер, инвайты, self-service виджет-скрипт)
// сюда сознательно не заведены — это адресные человеческие/утилитарные
// сообщения по существующим фичам, а не автоматическая оценка менеджера ботом,
// и именно от неё просил защититься владелец (см. WORKLOG.md 02.08).
//
// Настройка — bot_settings.dry_run_managers (миграция 133), дефолт TRUE.
// Fail-safe: если БД/таблица недоступны (миграция ещё не накатилась на этом
// инстансе) — считаем dry-run ВКЛЮЧЁННЫМ (безопасный дефолт, не наоборот).
// Кэш значения в памяти 30с — не долбим system DB на каждый пуш, но и не
// держим устаревшее значение сутками (владелец должен мочь выключить и
// увидеть эффект быстро).

let _dryRunCache: { value: boolean; at: number } | null = null;
const DRY_RUN_CACHE_TTL_MS = 30_000;

export async function isManagerDryRunEnabled(): Promise<boolean> {
  if (_dryRunCache && Date.now() - _dryRunCache.at < DRY_RUN_CACHE_TTL_MS) return _dryRunCache.value;
  let value = true;
  try {
    const res = await systemDb().query<{ dry_run_managers: boolean }>('SELECT dry_run_managers FROM bot_settings WHERE id = 1');
    if (res.rows[0]) value = res.rows[0].dry_run_managers;
  } catch {
    value = true; // таблицы ещё нет (миграция 133 не накатилась) — безопасный дефолт
  }
  _dryRunCache = { value, at: Date.now() };
  return value;
}

/** Только для тестового роута/ручной проверки — форсирует перечитать флаг без
 *  ожидания TTL кэша (после ручного PATCH настройки хочется увидеть эффект сразу). */
export function invalidateDryRunCache(): void { _dryRunCache = null; }

async function logOutbound(bitrixId: number, msgType: string, text: string, triggerReason: string | null, sent: boolean): Promise<void> {
  try {
    await systemDb().query(
      `INSERT INTO bot_outbound_log (bitrix_id, msg_type, text, trigger_reason, dry_run, sent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [bitrixId, msgType, text, triggerReason, !sent, sent],
    );
  } catch (e) {
    console.warn('[dryRun] лог исходящего сообщения не записался (миграция 133 не накатилась?):', e instanceof Error ? e.message : e);
  }
}

/** ЕДИНАЯ точка отправки менеджеру ботом «Аналитик» — см. разбор выше. Всегда
 *  логирует в bot_outbound_log; реально шлёт в Bitrix только если dry-run
 *  выключен. Не бросает — падение пуша не должно ронять вызывающий код. */
export async function sendManagerBotMessage(bitrixId: number, text: string, msgType: string, triggerReason?: string | null): Promise<void> {
  const dryRun = await isManagerDryRunEnabled();
  await logOutbound(bitrixId, msgType, text, triggerReason ?? null, !dryRun);
  if (dryRun) {
    console.log(`[dryRun] пуш менеджеру ${bitrixId} (${msgType}) залогирован, НЕ отправлен`);
    return;
  }
  try {
    await sendBitrixBotMessage(String(bitrixId), text);
  } catch (e) {
    console.warn(`[notify] пуш менеджеру ${bitrixId} не ушёл:`, e instanceof Error ? e.message : e);
  }
}

// Пуш «Аналитиком» в Bitrix-чат менеджера (вся геймификация). Вызывать ПОСЛЕ
// коммита; не бросает. Теперь идёт через sendManagerBotMessage — рубильник
// dry-run выше применяется автоматически, отдельно включать/выключать здесь
// нечего.
export async function pushViaAnalitik(bitrixId: number, title: string, body?: string | null): Promise<void> {
  const msg = body ? `[b]${title}[/b]\n${body}` : `[b]${title}[/b]`;
  await sendManagerBotMessage(bitrixId, msg, 'gamification', title);
}

// Удобный комбо-помощник вне транзакций.
export async function notifyAndPush(db: Pool, n: NotificationInput): Promise<void> {
  await createNotification(db, n);
  void pushViaAnalitik(n.bitrixId, n.title, n.body);
}
