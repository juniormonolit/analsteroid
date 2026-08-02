// Уведомления ЛК (пакет Серёги 31.07) + пуши ботом «Аналитик».
// «Аналитик» — НЕ телеграм: это Bitrix24 imbot (BOT_ID 20761, вебхук imbot,
// lib/bitrix/notify.ts), менеджеры «привязаны» самим Битриксом — DIALOG_ID =
// их bitrix_user_id, отдельной таблицы чатов не нужно. Пуш — best-effort ПОСЛЕ
// коммита транзакции: падение Битрикса не откатывает бизнес-операцию,
// уведомление в ЛК создаётся всегда.

import type { Pool, PoolClient } from 'pg';
import { sendBitrixBotMessage, type BotKeyboardButton } from '@/lib/bitrix/notify';
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
// сообщения по существующим фичам, а не автоматическая оценка менеджера ботом.
//
// Настройка — bot_settings.dry_run_managers (миграция 133), дефолт TRUE.
// Fail-safe: если БД/таблица недоступны (миграция ещё не накатилась на этом
// инстансе) — считаем dry-run ВКЛЮЧЁННЫМ (безопасный дефолт, не наоборот).
// Кэш значения в памяти 30с — не долбим system DB на каждый пуш.

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
 *  ожидания TTL кэша. */
export function invalidateDryRunCache(): void { _dryRunCache = null; }

// ── Система отладки сообщений (правка владельца 02.08, задача 2765) ─────────
// «Каждому сообщению должен быть присвоен уникальный айди, по которому мы
// должны иметь возможность разобрать, как и почему оно ушло» — ID = base36 от
// bot_outbound_log.id (не отдельная колонка, id и так уникален и обратим).
// Формат подтверждён владельцем ЖИВЬЁМ на 2098 (скриншоты реального клиента
// Bitrix, 02.08): [size]+[color]+[i] рендерятся как надо (мелко/серо/курсивом),
// [spoiler] НЕ поддерживается порталом — отдаётся сырым текстом, не используем.
// Итоговый формат метки: [size=8][color=#999999]ID:xxx[/color][/size].
//
// Кнопки «⚠️ Ошибка» / «👍 Полезно» — imbot-команды advice_error/advice_useful
// (зарегистрированы live 02.08 через imbot.command.register, id 15/14, тем же
// паттерном, что уже работает в проде для bind_deal — деал-чаты). Обработчик
// кликов — app/api/bitrix/events/route.ts (тот же роут, что уже принимает
// ONIMCOMMANDADD). COMMAND_PARAMS = id лог-строки (bot_outbound_log.id) —
// клик пишет в bot_feedback (очередь на РУЧНОЙ разбор админом, бонус НЕ
// начисляется автоматически — защита от фарма кнопки ради MLT).

function shortMsgId(logId: number): string {
  return logId.toString(36).toUpperCase();
}

const FEEDBACK_FOOTER =
  '[i]В системе могут быть неточности — нажми «⚠️ Ошибка», если что-то не так. ' +
  'За помощь в развитии системы иногда могут быть начислены бонусы MLT.[/i]';

function feedbackButtons(logId: number): BotKeyboardButton[] {
  const params = String(logId);
  return [
    { TEXT: '⚠️ Ошибка', COMMAND: 'advice_error', COMMAND_PARAMS: params, DISPLAY: 'LINE', BG_COLOR: '#f5f5f5', TEXT_COLOR: '#c0392b' },
    { TEXT: '👍 Полезно', COMMAND: 'advice_useful', COMMAND_PARAMS: params, DISPLAY: 'LINE', BG_COLOR: '#f5f5f5', TEXT_COLOR: '#27ae60' },
  ];
}

async function insertOutbound(bitrixId: number, msgType: string, baseText: string, triggerReason: string | null, decisionTrace: unknown): Promise<number | null> {
  try {
    const res = await systemDb().query<{ id: string }>(
      `INSERT INTO bot_outbound_log (bitrix_id, msg_type, text, trigger_reason, dry_run, sent, decision_trace)
       VALUES ($1,$2,$3,$4,true,false,$5) RETURNING id`,
      [bitrixId, msgType, baseText, triggerReason, decisionTrace != null ? JSON.stringify(decisionTrace) : null],
    );
    return Number(res.rows[0]!.id);
  } catch (e) {
    console.warn('[dryRun] лог исходящего сообщения не записался (миграция 133/136 не накатилась?):', e instanceof Error ? e.message : e);
    return null;
  }
}

async function finalizeOutbound(logId: number, finalText: string, dryRun: boolean, sent: boolean, suppressReason: string | null): Promise<void> {
  try {
    await systemDb().query(
      `UPDATE bot_outbound_log SET text = $2, dry_run = $3, sent = $4, suppress_reason = $5 WHERE id = $1`,
      [logId, finalText, dryRun, sent, suppressReason],
    );
  } catch (e) {
    console.warn('[dryRun] обновление лога не удалось:', e instanceof Error ? e.message : e);
  }
}

export interface SendManagerBotMessageOpts {
  /** Причина подавления, НЕ связанная с глобальным dry-run (напр. личная
   *  настройка подписки менеджера) — сообщение всё равно формируется целиком
   *  и логируется, просто реально не уходит. */
  suppressReason?: string | null;
  /** «След решения» — что рассматривали, какое правило/порог сработали,
   *  почему выбран именно этот вариант (задача 2765, отладочная система). */
  decisionTrace?: unknown;
}

/** ЕДИНАЯ точка отправки менеджеру ботом «Аналитик»: и вся геймификация
 *  (pushViaAnalitik), и дайджест/фидбек (2765). Всегда логирует в
 *  bot_outbound_log (с ID сообщения и следом решения) и добавляет кнопки
 *  «Ошибка»/«Полезно» + тихую метку ID + приписку про неточности. Реально
 *  шлёт в Bitrix только если dry-run выключен И suppressReason не задан.
 *  Не бросает — падение пуша не должно ронять вызывающий код. */
export async function sendManagerBotMessage(
  bitrixId: number, text: string, msgType: string, triggerReason?: string | null,
  opts: SendManagerBotMessageOpts = {},
): Promise<void> {
  const dryRun = await isManagerDryRunEnabled();
  const willSend = !dryRun && !opts.suppressReason;

  const logId = await insertOutbound(bitrixId, msgType, text, triggerReason ?? null, opts.decisionTrace);
  const idTag = logId !== null ? shortMsgId(logId) : '—';
  const finalText = `${text}\n\n[size=8][color=#999999]ID:${idTag}[/color][/size]\n${FEEDBACK_FOOTER}`;
  if (logId !== null) await finalizeOutbound(logId, finalText, dryRun, willSend, opts.suppressReason ?? null);

  if (!willSend) {
    if (opts.suppressReason) console.log(`[prefs] пуш менеджеру ${bitrixId} (${msgType}) подавлен настройками получателя: ${opts.suppressReason}`);
    else console.log(`[dryRun] пуш менеджеру ${bitrixId} (${msgType}) залогирован (ID:${idTag}), НЕ отправлен`);
    return;
  }
  try {
    await sendBitrixBotMessage(String(bitrixId), finalText, logId !== null ? feedbackButtons(logId) : undefined);
  } catch (e) {
    console.warn(`[notify] пуш менеджеру ${bitrixId} не ушёл:`, e instanceof Error ? e.message : e);
  }
}

// Пуш «Аналитиком» в Bitrix-чат менеджера (вся геймификация). Вызывать ПОСЛЕ
// коммита; не бросает. Идёт через sendManagerBotMessage — рубильник dry-run
// и ID/кнопки применяются автоматически.
export async function pushViaAnalitik(bitrixId: number, title: string, body?: string | null): Promise<void> {
  const msg = body ? `[b]${title}[/b]\n${body}` : `[b]${title}[/b]`;
  await sendManagerBotMessage(bitrixId, msg, 'gamification', title);
}

// Удобный комбо-помощник вне транзакций.
export async function notifyAndPush(db: Pool, n: NotificationInput): Promise<void> {
  await createNotification(db, n);
  void pushViaAnalitik(n.bitrixId, n.title, n.body);
}
