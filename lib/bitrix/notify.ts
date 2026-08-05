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
// ── РЕЖИМ ТИШИНЫ ДО РЕЛИЗА (распоряжение владельца 05.08, уточнённое) ────────
// «Не должны отправлять Аналитиком никаких сообщений никому» → уточнение:
// «Не-не, ОТЧЁТЫ пусть шлёт. Но ничего больше. По умолчанию у нас задуманы
// уведомления через него».
//
// То есть глушится ВСЁ, кроме ежедневных отчётов: уведомления геймификации
// (награды/квесты/переводы/заявки), дайджесты РОПам, «Контроль звонков», чаты
// по сделкам. Полагаться на «никто не дёрнет» нельзя — часть этого шлют
// ПЛАНИРОВЩИКИ из instrumentation.ts сами, без участия человека.
//
// Реализация: канал указывает ВЫЗЫВАЮЩИЙ (channel: 'report' | 'notify'), дефолт —
// 'notify' (то есть молчание): любой новый или забытый вызов по умолчанию тихий,
// а не прорывается наружу. Снять тишину целиком — BOT_SEND_ENABLED=1 в start.sh
// + рестарт, по слову владельца. Вызовы не бросают исключение (иначе
// планировщики уйдут в ретраи и лог-шум) — тихо логируют и отдают фиктивный id.
export type BotChannel = 'report' | 'notify';

function botChannelMuted(channel: BotChannel): boolean {
  if (process.env.BOT_SEND_ENABLED === '1') return false; // релиз — шлём всё
  return channel !== 'report';                            // до релиза — только отчёты
}

export async function sendBitrixBotMessage(
  bitrixUserId: string,
  message: string,
  keyboard?: BotKeyboardButton[],
  channel: BotChannel = 'notify',
): Promise<number> {
  if (botChannelMuted(channel)) {
    console.warn(`[bot] ТИШИНА ДО РЕЛИЗА (канал ${channel}): сообщение для ${bitrixUserId} не отправлено, ${message.length} симв.`);
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
  // «Контроль звонков» — уведомления, не отчёты: до релиза молчит целиком
  // (см. комментарий про режим тишины у sendBitrixBotMessage).
  if (botChannelMuted('notify')) {
    console.warn(`[bot:call-control] ТИШИНА ДО РЕЛИЗА: сообщение для ${bitrixUserId} не отправлено`);
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
