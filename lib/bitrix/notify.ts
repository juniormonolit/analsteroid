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
// ── ГЛОБАЛЬНАЯ ГЛУШИЛКА БОТОВ (распоряжение владельца 05.08) ─────────────────
// «До тех пор, пока я не скажу, мы не запускаем релиз и не должны отправлять
// Аналитиком (роботом) никаких сообщений никому». Полагаться на то, что никто
// не дёрнет отправку, нельзя: в instrumentation.ts живут ПЛАНИРОВЩИКИ (ежедневные
// отчёты в 18:00 МСК на 2098 и 1923, дайджесты, «Контроль звонков») — они
// отправят сами, без участия человека.
//
// Дефолт — МОЛЧАНИЕ: даже если переменной нет на сервере (а на проде env
// задаётся только через start.sh, см. память проекта), бот молчит. Включение
// обратно — ЯВНОЕ: BOT_SEND_ENABLED=1 в start.sh + рестарт, по слову владельца.
// Вызовы не падают (иначе планировщики уйдут в ретраи и лог-шум) — тихо
// логируем и возвращаем фиктивный id.
function botSendingDisabled(): boolean {
  return process.env.BOT_SEND_ENABLED !== '1';
}

export async function sendBitrixBotMessage(
  bitrixUserId: string,
  message: string,
  keyboard?: BotKeyboardButton[],
): Promise<number> {
  if (botSendingDisabled()) {
    console.warn(`[bot] МОЛЧАНИЕ (BOT_SEND_ENABLED≠1): сообщение для ${bitrixUserId} не отправлено, ${message.length} симв.`);
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
  // Та же глушилка, что у «Аналитика» — распоряжение владельца про ЛЮБЫЕ
  // сообщения роботом (см. комментарий у sendBitrixBotMessage).
  if (botSendingDisabled()) {
    console.warn(`[bot:call-control] МОЛЧАНИЕ (BOT_SEND_ENABLED≠1): сообщение для ${bitrixUserId} не отправлено`);
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
