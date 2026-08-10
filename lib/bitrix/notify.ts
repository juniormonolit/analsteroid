// Вызов Bitrix24 REST API через инкаминг-вебхуки. Два разных вебхука с разными
// правами: BITRIX_WEBHOOK_URL (CRM, только чтение — см. scripts/bitrix_backfill.mjs)
// и BITRIX_BOT_WEBHOOK_URL (создан отдельно под "Информировать сотрудников в чате",
// права "Создание и управление Чат-ботами (imbot)").

export async function bx(webhookUrl: string, method: string, params: Record<string, unknown>) {
  const webhook = webhookUrl.replace(/\/+$/, '');
  if (!webhook) throw new Error('Bitrix webhook URL не задан');

  const MAX = 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const res = await fetch(`${webhook}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        // 60с (было 15): mlt.sales.list за месяц отдаёт ~10 МБ — на 15 секундах
        // большой ответ мог не долиться (реальный пропуск отчёта 30.07).
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && !body.error) return body;

      // HTTP 200, но тело не распарсилось — оборванный/битый ответ (Битрикс режет
      // многомегабайтные payload'ы под нагрузкой). Это ТРАНЗИЕНТНАЯ ошибка: раньше
      // код считал её фатальной («Bitrix mlt.sales.list: HTTP 200») и не повторял —
      // из-за этого 30.07 потерялся ежедневный отчёт.
      const truncated = res.ok && body === null;
      const code = body?.error || (truncated ? 'BROKEN_RESPONSE' : `HTTP ${res.status}`);
      if (code === 'ACCESS_DENIED') {
        throw new Error(
          `Bitrix отказал в доступе к ${method} — у вебхука нет нужных прав. Проверьте настройки вебхука в Bitrix24.`
        );
      }
      const retryable = code === 'QUERY_LIMIT_EXCEEDED' || code === 'BROKEN_RESPONSE' || res.status >= 500;
      if (!retryable) throw new Error(`Bitrix ${method}: ${code} ${body?.error_description || ''}`);
      lastError = new Error(`Bitrix ${method}: ${code} после ${MAX} попыток`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Bitrix')) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    if (attempt < MAX) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastError ?? new Error(`Bitrix ${method}: не удалось выполнить запрос`);
}

// Кнопки под сообщением бота. Клик приходит как ONIMCOMMANDADD — команда обязана быть
// зарегистрирована через imbot.command.register (для чатов по сделкам это 'bind_deal').
export interface BotKeyboardButton {
  TEXT: string;
  COMMAND: string;
  COMMAND_PARAMS: string;
  DISPLAY?: 'LINE' | 'BLOCK';
  BG_COLOR?: string;
  TEXT_COLOR?: string;
}

/** Возвращает id отправленного сообщения (нужен для корреляции ответов по REPLY_ID). */
// ── ПОКАНАЛЬНАЯ ГЛУШИЛКА (задача 09.08.2026) ────────────────────────────────
// Было: один флаг `BOT_SEND_ENABLED` в env — не задан, значит молчит ВСЁ, кроме
// ежедневных отчётов. Под это «всё» попал и «Контроль звонков», который к
// геймификации отношения не имеет, а поменять что-либо можно было только
// правкой start.sh с рестартом.
//
// Стало: у каждого отправителя канал, у каждого канала флажок в `bot_channels`,
// правится в админке. Разбиение ПО СМЫСЛУ, а не по ботам: у «Аналитика» под
// одним ботом живут и отчёт владельцу, и «ты получил награду», и вопрос РОПа по
// сделке — глушить их одним рубильником значило терять нужное вместе с ненужным.
//
// Два правила, которые важно не потерять при правках:
//   1. Канал указывает ВЫЗЫВАЮЩИЙ, а дефолт — 'gamification' (самый глухой из
//      реально используемых). Забытый канал в новом коде должен молчать, а не
//      прорываться наружу.
//   2. Не смогли прочитать настройки (БД недоступна, миграции нет) — считаем
//      канал ВЫКЛЮЧЕННЫМ. Fail-safe в сторону тишины, а не рассылки.
//
// `BOT_SEND_ENABLED=1` остаётся аварийным «включить всё» поверх БД: если
// админка недоступна, а разослать надо. Обратного (`=0`) намеренно нет —
// выключить всё можно флажками, и одно место управления лучше двух.
export type BotChannel = 'report' | 'call_control' | 'gamification' | 'manager_digest' | 'deal_chats' | 'service';

let _channelCache: { map: Map<string, boolean>; at: number } | null = null;
const CHANNEL_CACHE_TTL_MS = 30_000;

/** Сбросить кэш каналов — зовётся из админки сразу после сохранения, чтобы
 *  владелец увидел эффект переключателя, а не ждал 30 секунд. */
export function invalidateBotChannelCache(): void { _channelCache = null; }

async function channelEnabled(channel: BotChannel): Promise<boolean> {
  if (process.env.BOT_SEND_ENABLED === '1') return true;   // аварийное «включить всё»
  if (_channelCache && Date.now() - _channelCache.at < CHANNEL_CACHE_TTL_MS) {
    return _channelCache.map.get(channel) ?? false;
  }
  const map = new Map<string, boolean>();
  try {
    // Динамический импорт: notify.ts тянут и сборщики, которым пул БД не нужен.
    const { systemDb } = await import('@/lib/db/clients');
    const r = await systemDb().query<{ key: string; enabled: boolean }>(
      'SELECT key, enabled FROM bot_channels',
    );
    for (const row of r.rows) map.set(row.key, row.enabled);
    _channelCache = { map, at: Date.now() };
  } catch {
    // Миграции 170 ещё нет или БД недоступна — молчим. Кэш НЕ ставим: иначе
    // при разовом сбое связи бот замолчал бы на полминуты уже после починки.
    return false;
  }
  return map.get(channel) ?? false;
}

export async function sendBitrixBotMessage(
  bitrixUserId: string,
  message: string,
  keyboard?: BotKeyboardButton[],
  channel: BotChannel = 'gamification',
): Promise<number> {
  if (!(await channelEnabled(channel))) {
    console.warn(`[bot] канал «${channel}» выключен: сообщение для ${bitrixUserId} не отправлено, ${message.length} симв.`);
    return 0;
  }
  const webhook = process.env.BITRIX_BOT_WEBHOOK_URL || '';
  const botId = process.env.BITRIX_BOT_ID || '';
  const clientId = process.env.BITRIX_BOT_CLIENT_ID || '';
  if (!webhook || !botId || !clientId) {
    throw new Error('BITRIX_BOT_WEBHOOK_URL/BITRIX_BOT_ID/BITRIX_BOT_CLIENT_ID не заданы — бот "Аналитик" ещё не зарегистрирован');
  }
  const body = await bx(webhook, 'imbot.message.add', {
    CLIENT_ID: clientId,
    BOT_ID: botId,
    DIALOG_ID: bitrixUserId,
    MESSAGE: message,
    ...(keyboard?.length ? { KEYBOARD: { BUTTONS: keyboard } } : {}),
  });
  return Number(body?.result) || 0;
}

// Бот «Контроль звонков» (BOT_ID 15010) — отдельный, давно зарегистрированный бот
// missedcalls-робота. Свой вебхук/CLIENT_ID (env CALL_CONTROL_*), НЕ переиспользует
// креды «Аналитика»: у ботов разные владельцы-вебхуки и разные аватары/имена в чате.
export async function sendCallControlBotMessage(bitrixUserId: string, message: string): Promise<void> {
  // Свой канал: «Контроль звонков» к геймификации отношения не имеет и глохнуть
  // вместе с ней не должен — ровно это и просил владелец 09.08.
  if (!(await channelEnabled('call_control'))) {
    console.warn(`[bot:call-control] канал выключен: сообщение для ${bitrixUserId} не отправлено`);
    return;
  }
  const webhook = process.env.CALL_CONTROL_WEBHOOK_URL || '';
  const botId = process.env.CALL_CONTROL_BOT_ID || '';
  const clientId = process.env.CALL_CONTROL_CLIENT_ID || '';
  if (!webhook || !botId || !clientId) {
    throw new Error('CALL_CONTROL_WEBHOOK_URL/CALL_CONTROL_BOT_ID/CALL_CONTROL_CLIENT_ID не заданы — см. start.sh на сервере');
  }
  await bx(webhook, 'imbot.message.add', {
    CLIENT_ID: clientId,
    BOT_ID: botId,
    DIALOG_ID: bitrixUserId,
    MESSAGE: message,
  });
}
