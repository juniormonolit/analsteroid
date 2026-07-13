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
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && !body.error) return body;

      const code = body?.error || `HTTP ${res.status}`;
      if (code === 'ACCESS_DENIED') {
        throw new Error(
          `Bitrix отказал в доступе к ${method} — у вебхука нет нужных прав. Проверьте настройки вебхука в Bitrix24.`
        );
      }
      const retryable = code === 'QUERY_LIMIT_EXCEEDED' || res.status >= 500;
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

export async function sendBitrixBotMessage(bitrixUserId: string, message: string): Promise<void> {
  const webhook = process.env.BITRIX_BOT_WEBHOOK_URL || '';
  const botId = process.env.BITRIX_BOT_ID || '';
  const clientId = process.env.BITRIX_BOT_CLIENT_ID || '';
  if (!webhook || !botId || !clientId) {
    throw new Error('BITRIX_BOT_WEBHOOK_URL/BITRIX_BOT_ID/BITRIX_BOT_CLIENT_ID не заданы — бот "Аналитик" ещё не зарегистрирован');
  }
  await bx(webhook, 'imbot.message.add', {
    CLIENT_ID: clientId,
    BOT_ID: botId,
    DIALOG_ID: bitrixUserId,
    MESSAGE: message,
  });
}

// Бот «Контроль звонков» (BOT_ID 15010) — отдельный, давно зарегистрированный бот
// missedcalls-робота. Свой вебхук/CLIENT_ID (env CALL_CONTROL_*), НЕ переиспользует
// креды «Аналитика»: у ботов разные владельцы-вебхуки и разные аватары/имена в чате.
export async function sendCallControlBotMessage(bitrixUserId: string, message: string): Promise<void> {
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
