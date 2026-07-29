// Перевешивает обработчики событий бота «Аналитик» на актуальный домен.
//
// Зачем: бот регистрировался на junior-analsteroid.dev.mlt-it.com; после переезда
// на monolitika.mlt-it.com старый URL отвечает 301, Битрикс редиректы при доставке
// событий не отрабатывает → ONIMBOTMESSAGEADD и прочие события молча терялись
// (обнаружено 2026-07-20 на спайке чатов по сделкам).
//
// Запуск:  node scripts/bitrix_update_bot_events.mjs
// Env:     BITRIX_BOT_WEBHOOK_URL, BITRIX_BOT_CLIENT_ID, BITRIX_BOT_ID (из .env.local)
//          EVENTS_URL (опц.) — переопределить целевой URL.

import fs from 'node:fs';

for (const line of fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\\\$/g, '$');
}

const EVENTS_URL = process.env.EVENTS_URL || 'https://monolitika.mlt-it.com/api/bitrix/events';
const hook = (process.env.BITRIX_BOT_WEBHOOK_URL || '').replace(/\/+$/, '');
const clientId = process.env.BITRIX_BOT_CLIENT_ID;
const botId = process.env.BITRIX_BOT_ID;
if (!hook || !clientId || !botId) {
  console.error('Нужны BITRIX_BOT_WEBHOOK_URL / BITRIX_BOT_CLIENT_ID / BITRIX_BOT_ID');
  process.exit(1);
}

const res = await fetch(`${hook}/imbot.update.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    CLIENT_ID: clientId,
    BOT_ID: botId,
    FIELDS: {
      EVENT_HANDLER: EVENTS_URL,
      EVENT_MESSAGE_ADD: EVENTS_URL,
      EVENT_WELCOME_MESSAGE: EVENTS_URL,
      EVENT_BOT_DELETE: EVENTS_URL,
    },
  }),
});
const body = await res.json();
if (body.error) {
  console.error('Ошибка Bitrix:', body.error, body.error_description || '');
  process.exit(1);
}
console.log(`OK — обработчики бота #${botId} переведены на ${EVENTS_URL}`);
