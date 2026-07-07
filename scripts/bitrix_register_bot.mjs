// Разовая регистрация чат-бота "Аналитик" в Bitrix24 через вебхук с правами imbot.
// Печатает BOT_ID — его нужно вручную положить в .env.local как BITRIX_BOT_ID.
//
// Usage:
//   BITRIX_BOT_WEBHOOK_URL=https://portal.bitrix24.ru/rest/1/token \
//   EVENTS_URL=https://junior-analsteroid.dev.mlt-it.com/api/bitrix/events \
//   node scripts/bitrix_register_bot.mjs

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());

const WEBHOOK = (process.env.BITRIX_BOT_WEBHOOK_URL || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.BITRIX_BOT_CLIENT_ID || '';
const EVENTS_URL = process.env.EVENTS_URL || 'https://junior-analsteroid.dev.mlt-it.com/api/bitrix/events';

if (!WEBHOOK) {
  console.error('BITRIX_BOT_WEBHOOK_URL не задан');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('BITRIX_BOT_CLIENT_ID не задан — нужна произвольная постоянная строка (см. поле CLIENT_ID в "Генераторе запросов" Bitrix)');
  process.exit(1);
}

const res = await fetch(`${WEBHOOK}/imbot.register.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    CLIENT_ID,
    CODE: 'analyst_bot',
    TYPE: 'B',
    EVENT_HANDLER: EVENTS_URL,
    EVENT_MESSAGE_ADD: EVENTS_URL,
    EVENT_WELCOME_MESSAGE: EVENTS_URL,
    EVENT_BOT_DELETE: EVENTS_URL,
    PROPERTIES: {
      NAME: 'Аналитик',
      COLOR: 'AZURE',
    },
  }),
});

const body = await res.json().catch(() => null);
if (!res.ok || !body || body.error) {
  console.error('FAILED:', body?.error, body?.error_description || res.status);
  process.exit(1);
}

console.log('BOT_ID:', body.result);
console.log('Добавьте в .env.local: BITRIX_BOT_ID=' + body.result);
