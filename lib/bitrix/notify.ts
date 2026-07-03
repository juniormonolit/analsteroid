// Отправка личных сообщений в Bitrix24 через инкаминг-вебхук (im.notify.personal.add).
// Требует, чтобы у BITRIX_WEBHOOK_URL была включена группа методов "Мессенджер (im)".

const WEBHOOK = (process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');

async function bx(method: string, params: Record<string, unknown>) {
  if (!WEBHOOK) throw new Error('BITRIX_WEBHOOK_URL не задан');

  const MAX = 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const res = await fetch(`${WEBHOOK}/${method}.json`, {
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
          `Bitrix отказал в доступе к ${method} — у вебхука BITRIX_WEBHOOK_URL нет прав на группу методов "Мессенджер (im)". Добавьте её в настройках вебхука.`
        );
      }
      const retryable = code === 'QUERY_LIMIT_EXCEEDED' || res.status >= 500;
      if (!retryable) throw new Error(`Bitrix ${method}: ${code} ${body?.error_description || ''}`);
      lastError = new Error(`Bitrix ${method}: ${code} после ${MAX} попыток`);
    } catch (e) {
      if (e instanceof Error && (e.message.startsWith('Bitrix') || e.message.startsWith('BITRIX'))) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    if (attempt < MAX) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastError ?? new Error(`Bitrix ${method}: не удалось выполнить запрос`);
}

export async function sendBitrixDirectMessage(bitrixUserId: string, message: string): Promise<void> {
  await bx('im.notify.personal.add', {
    USER_ID: bitrixUserId,
    MESSAGE: message,
    TYPE: 'SYSTEM',
  });
}
