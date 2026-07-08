// Разовое обновление аватара чат-бота "Аналитик" в Bitrix24 (imbot.update).
// Требует BITRIX_BOT_ID уже зарегистрированного бота (см. scripts/bitrix_register_bot.mjs).
// PERSONAL_PHOTO в Bitrix принимает файл как base64 (data URI), не голый URL.
//
// Usage:
//   BITRIX_BOT_WEBHOOK_URL=https://portal.bitrix24.ru/rest/1/token \
//   BITRIX_BOT_ID=123 \
//   BITRIX_BOT_CLIENT_ID=... \
//   AVATAR_PATH=public/bot-avatar.png \
//   node scripts/bitrix_update_bot_avatar.mjs

import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
require('@next/env').loadEnvConfig(process.cwd());

const WEBHOOK = (process.env.BITRIX_BOT_WEBHOOK_URL || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.BITRIX_BOT_CLIENT_ID || '';
const BOT_ID = process.env.BITRIX_BOT_ID || '';
const AVATAR_PATH = process.env.AVATAR_PATH || 'public/bot-avatar.png';
const AVATAR_BASE64 = 'data:image/png;base64,' + readFileSync(AVATAR_PATH).toString('base64');

if (!WEBHOOK) {
  console.error('BITRIX_BOT_WEBHOOK_URL не задан');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('BITRIX_BOT_CLIENT_ID не задан');
  process.exit(1);
}
if (!BOT_ID) {
  console.error('BITRIX_BOT_ID не задан');
  process.exit(1);
}

const res = await fetch(`${WEBHOOK}/imbot.update.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    BOT_ID: Number(BOT_ID),
    CLIENT_ID,
    FIELDS: {
      // NAME/COLOR обязаны присутствовать вместе с PERSONAL_PHOTO — если передать
      // только PERSONAL_PHOTO, Bitrix отбрасывает весь PROPERTIES как невалидный
      // и отвечает "Update fields can't be empty".
      PROPERTIES: {
        NAME: 'Аналитик',
        COLOR: 'AZURE',
        PERSONAL_PHOTO: AVATAR_BASE64,
      },
    },
  }),
});

const body = await res.json().catch(() => null);
if (!res.ok || !body || body.error) {
  console.error('FAILED:', JSON.stringify(body, null, 2) || res.status);
  process.exit(1);
}

console.log('OK:', body.result);
