// Обработка кликов по кнопкам «⚠️ Ошибка» / «👍 Полезно» под сообщениями
// «Аналитика» (задача 2765, правка владельца 02.08). Клик — ONIMCOMMANDADD с
// COMMAND advice_error/advice_useful, COMMAND_PARAMS = id строки
// bot_outbound_log (тот же паттерн, что уже работает в проде для bind_deal,
// см. lib/deal-chats/service.ts). Бонус НЕ начисляется автоматически — только
// падает в очередь bot_feedback на ручной разбор («Настройки → Геймификация →
// Обратная связь»), иначе кнопку жали бы ради MLT.

import { systemDb } from '@/lib/db/clients';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';

export type FeedbackSignal = 'error' | 'useful';

const THANKS: Record<FeedbackSignal, string> = {
  error: 'Принято, спасибо! Передал разработчику на разбор — если найдётся баг, он не останется без внимания 🙏',
  useful: 'Спасибо! 👍 Приятно, что помогает.',
};

/** Не бросает — обработчик событий бота обязан всегда отвечать 200 (см.
 *  app/api/bitrix/events/route.ts), падение фидбека не должно ронять его. */
export async function handleAdviceFeedback(opts: { fromUserId: string; logIdRaw: string; signal: FeedbackSignal }): Promise<void> {
  const bitrixId = Number(opts.fromUserId);
  const logId = Number(opts.logIdRaw);
  if (!bitrixId || !Number.isFinite(logId) || logId <= 0) {
    console.warn('[bot/feedback] некорректные параметры клика:', opts);
    return;
  }

  try {
    // ON CONFLICT — повторный клик/ретрай Битрикса по той же паре (log_id,
    // bitrix_id) не плодит дубли в очереди на разбор.
    const res = await systemDb().query<{ id: string }>(
      `INSERT INTO bot_feedback (log_id, bitrix_id, signal)
       VALUES ($1, $2, $3)
       ON CONFLICT (log_id, bitrix_id) DO NOTHING
       RETURNING id`,
      [logId, bitrixId, opts.signal],
    );
    if (res.rows.length === 0) return; // уже был клик по этому сообщению от этого человека — не спамим повторным «спасибо»
  } catch (e) {
    // log_id может не существовать (напр. ручной тест с фиктивным id) — не роняем обработчик.
    console.warn(`[bot/feedback] запись в очередь не удалась (log_id=${logId}):`, e instanceof Error ? e.message : e);
    return;
  }

  try {
    // Ответ-«спасибо» на кнопку под сообщением геймификации — тот же канал:
    // включили награды, значит и подтверждение реакции должно доходить.
    await sendBitrixBotMessage(opts.fromUserId, THANKS[opts.signal], undefined, 'gamification');
  } catch (e) {
    console.warn('[bot/feedback] ответ-спасибо не ушёл:', e instanceof Error ? e.message : e);
  }
}
