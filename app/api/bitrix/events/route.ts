import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { handleIncomingBotMessage, handleBindDealCommand } from '@/lib/deal-chats/service';
import { handleAdviceFeedback } from '@/lib/bot/feedback';
import { systemDb } from '@/lib/db/clients';

// Журнал входящих (панель управления «Аналитиком», 09.09): каждое сообщение/клик
// человека боту — строкой, с пометкой, какой обработчик его забрал. Не бросает:
// журнал не должен ломать обработку.
async function logInbound(row: {
  bitrixId: string; event: string; text: string; dialogId: string; messageId: string; replyTo: string | null; handledBy: string;
}): Promise<void> {
  if (!/^\d+$/.test(row.bitrixId)) return;
  try {
    await systemDb().query(
      `INSERT INTO bot_inbound_log (bitrix_id, event, text, dialog_id, message_id, reply_to, handled_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [Number(row.bitrixId), row.event, row.text.slice(0, 4000) || null, row.dialogId || null,
       /^\d+$/.test(row.messageId) ? Number(row.messageId) : null,
       row.replyTo && /^\d+$/.test(row.replyTo) ? Number(row.replyTo) : null, row.handledBy],
    );
  } catch (e) {
    console.warn('[bitrix/events] журнал входящих не записан:', e instanceof Error ? e.message : e);
  }
}

// ── Аутентификация вебхука (аудит 09.09, ACCESS_AUDIT_2026-09-09.md, «главная
// дыра» №1): роут был полностью открыт — любой из интернета мог подделать
// «ответ менеджера», привязку сделки и клики по кнопкам. Битрикс с каждым
// событием присылает auth[application_token] (секрет приложения, выдаётся при
// установке обработчика) и auth[domain] (портал). Проверяем:
//   * домен обязан совпасть с BITRIX_PORTAL_DOMAIN (дефолт — td.monolit-crm.ru,
//     тот же захардкоженный портал, что в lib/bots/callControlAdmin.ts);
//   * если задан BITRIX_EVENTS_APP_TOKEN — токен обязан совпасть (constant-time),
//     иначе 403;
//   * если env НЕ задан — событие принимаем (не ломать бота до настройки), но один
//     раз за процесс пишем в лог полученный токен, чтобы админ перенёс его в
//     start.sh (прод читает env только оттуда — см. память prod-env-not-from-envlocal).
const DEFAULT_PORTAL_DOMAIN = 'td.monolit-crm.ru';
let appTokenWarned = false;

function pickAuth(data: Record<string, unknown>): { token: string; domain: string } {
  // form-data: плоские ключи auth[application_token] / auth[domain];
  // JSON: вложенный объект auth: { application_token, domain }.
  const nested = (data.auth && typeof data.auth === 'object' ? data.auth : {}) as Record<string, unknown>;
  const token = String(data['auth[application_token]'] ?? nested.application_token ?? '');
  const domain = String(data['auth[domain]'] ?? nested.domain ?? '');
  return { token, domain: domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual бросает при разной длине — сравниваем длину отдельно,
  // а потом буферы одинаковой длины (тот же приём, что в admin/org-sync).
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** null — событие подлинное; иначе готовый ответ 403. */
function authenticateEvent(data: Record<string, unknown>): NextResponse | null {
  const { token, domain } = pickAuth(data);
  const expectedDomain = (process.env.BITRIX_PORTAL_DOMAIN || DEFAULT_PORTAL_DOMAIN).toLowerCase();
  if (domain !== expectedDomain) {
    console.warn('[bitrix/events] отклонено: чужой домен', JSON.stringify(domain));
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const expectedToken = process.env.BITRIX_EVENTS_APP_TOKEN || '';
  if (!expectedToken) {
    if (!appTokenWarned) {
      appTokenWarned = true;
      console.warn(
        `[bitrix/events] BITRIX_EVENTS_APP_TOKEN не задан — события принимаются без проверки токена. `
        + `Настройте BITRIX_EVENTS_APP_TOKEN=${token || '<пусто: Битрикс не прислал application_token>'} в start.sh и перезапустите.`,
      );
    }
    return null;
  }
  if (!token || !safeEqual(token, expectedToken)) {
    console.warn('[bitrix/events] отклонено: application_token не совпал');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

// Обработчик событий бота «Аналитик». Сейчас обслуживает чаты по сделкам
// (ответы менеджеров и клики по кнопкам bind_deal); разбор вопросов на
// естественном языке — по-прежнему Phase 2.
//
// Битрикс шлёт события form-encoded с плоскими ключами вида
// data[PARAMS][MESSAGE]; работаем прямо по этим ключам.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') || '';
  const data: Record<string, unknown> = {};

  if (contentType.includes('application/json')) {
    Object.assign(data, await req.json().catch(() => ({})));
  } else {
    const form = await req.formData().catch(() => null);
    if (form) for (const [key, value] of form.entries()) data[key] = String(value);
  }

  // Аудит 09.09: сначала подлинность события, потом всё остальное (в т.ч. лог тела).
  const denied = authenticateEvent(data);
  if (denied) return denied;

  const event = String(data.event ?? '');
  console.log('[bitrix/events]', event || 'unknown event', JSON.stringify(data).slice(0, 500));

  const str = (key: string): string => String(data[key] ?? '');
  const botId = process.env.BITRIX_BOT_ID || '';

  try {
    // Ответ менеджера боту в личке. Системные и свои (бота) сообщения пропускаем.
    if (event === 'ONIMBOTMESSAGEADD'
        && str('data[PARAMS][MESSAGE_TYPE]') === 'P'
        && str('data[PARAMS][SYSTEM]') !== 'Y'
        && str('data[PARAMS][FROM_USER_ID]') !== botId) {
      const replyIdRaw = str('data[PARAMS][PARAMS][REPLY_ID]');
      const handledByDealChats = await handleIncomingBotMessage({
        fromUserId: str('data[PARAMS][FROM_USER_ID]'),
        text: str('data[PARAMS][MESSAGE]'),
        replyToBitrixMessageId: replyIdRaw ? Number(replyIdRaw) : null,
      });
      // Не чат по сделке → возможно, это ответ на понедельничный вопрос бота
      // «Как погодка на той неделе была?» (спец-отчёт «Данные по годам», 28.08).
      // recordWeatherAnswer сам возвращает null, если вопросов человеку не было.
      let handledBy = handledByDealChats ? 'deal_chat' : 'unhandled';
      if (!handledByDealChats) {
        const { recordWeatherAnswer } = await import('@/lib/weather/weeklyWeather');
        const w = await recordWeatherAnswer(str('data[PARAMS][FROM_USER_ID]'), str('data[PARAMS][MESSAGE]'));
        if (w) handledBy = 'weather';
      }
      await logInbound({
        bitrixId: str('data[PARAMS][FROM_USER_ID]'), event, text: str('data[PARAMS][MESSAGE]'),
        dialogId: str('data[PARAMS][DIALOG_ID]'), messageId: str('data[PARAMS][MESSAGE_ID]'),
        replyTo: replyIdRaw || null, handledBy,
      });
    }

    // Клик по кнопке «к какой сделке относится ответ?». Ключ содержит id команды:
    // data[COMMAND][<id>][COMMAND] = 'bind_deal' — ищем по значению, id не хардкодим.
    if (event === 'ONIMCOMMANDADD') {
      const cmdKey = Object.keys(data).find(
        k => /^data\[COMMAND\]\[\d+\]\[COMMAND\]$/.test(k) && data[k] === 'bind_deal',
      );
      if (cmdKey) {
        const chatId = Number(str(cmdKey.replace(/\[COMMAND\]$/, '[COMMAND_PARAMS]')));
        if (chatId) {
          await handleBindDealCommand({ fromUserId: str('data[PARAMS][FROM_USER_ID]'), chatId });
        }
        await logInbound({
          bitrixId: str('data[PARAMS][FROM_USER_ID]'), event, text: `кнопка: привязать к сделке (чат ${chatId})`,
          dialogId: str('data[PARAMS][DIALOG_ID]'), messageId: str('data[PARAMS][MESSAGE_ID]'), replyTo: null, handledBy: 'bind_deal',
        });
      }

      // Кнопки «⚠️ Ошибка» / «👍 Полезно» под сообщениями «Аналитика» (задача
      // 2765): те же imbot-команды, тот же паттерн разбора ключей, что и у
      // bind_deal выше — COMMAND_PARAMS = id строки bot_outbound_log.
      for (const signal of ['advice_error', 'advice_useful'] as const) {
        const fbKey = Object.keys(data).find(
          k => /^data\[COMMAND\]\[\d+\]\[COMMAND\]$/.test(k) && data[k] === signal,
        );
        if (fbKey) {
          const logIdRaw = str(fbKey.replace(/\[COMMAND\]$/, '[COMMAND_PARAMS]'));
          await handleAdviceFeedback({
            fromUserId: str('data[PARAMS][FROM_USER_ID]'),
            logIdRaw,
            signal: signal === 'advice_error' ? 'error' : 'useful',
          });
          await logInbound({
            bitrixId: str('data[PARAMS][FROM_USER_ID]'), event,
            text: signal === 'advice_error' ? `кнопка: ⚠️ Ошибка (сообщение #${logIdRaw})` : `кнопка: 👍 Полезно (сообщение #${logIdRaw})`,
            dialogId: str('data[PARAMS][DIALOG_ID]'), messageId: str('data[PARAMS][MESSAGE_ID]'), replyTo: null, handledBy: 'feedback',
          });
        }
      }
    }
  } catch (e) {
    // Событиям бота всегда отвечаем 200 — иначе Битрикс ретраит и может отключить
    // обработчик (мы такое уже проходили с 301 после переезда домена).
    console.error('[bitrix/events] обработка не удалась:', e);
  }

  return NextResponse.json({});
}
