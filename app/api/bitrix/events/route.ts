import { NextRequest, NextResponse } from 'next/server';
import { handleIncomingBotMessage, handleBindDealCommand } from '@/lib/deal-chats/service';
import { handleAdviceFeedback } from '@/lib/bot/feedback';
import { systemDb } from '@/lib/db/clients';
import { authenticateBitrixEvent, pickAuth, tokenHint } from '@/lib/bitrix/eventsAuth';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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

// ── Аутентификация вебхука: lib/bitrix/eventsAuth.ts (аудит 09.09 + 29.09, #8256).
// С 29.09 fail-closed: без BITRIX_EVENTS_APP_TOKEN в окружении события отклоняются.
let notConfiguredWarned = false;

// Перехват токена (17.11): сервер 62 умер вместе со start.sh, где жил BITRIX_EVENTS_APP_TOKEN, — на новом
// проде токена нет, все события «Аналитика» отклоняются, ответы людей (погода, «Отчёт») теряются. Узнать
// токен можно только из самого события, а в лог его писать нельзя (#8256). Поэтому, пока токен НЕ задан,
// событие с нашим доменом кладёт свой токен в файл 600 рядом с приложением; владелец переносит его в
// secrets.env и перезапускает. Событие при этом всё равно отклоняется (fail-closed не ослаблен). Домен в
// теле подделывается — поэтому в файл пишется счётчик совпадений: верить токену, который пришёл ≥2 раз
// и без «другого токена» в логе.
// Прод запускается из ~/analsteroid/.next/standalone (папку перезаписывает каждая выкатка) — файл кладём
// в корень приложения, рядом с secrets.env.
const APP_ROOT = process.cwd().replace(/[/\\]\.next[/\\]standalone[/\\]?$/, '');
const CAPTURE_PATH = process.env.BITRIX_EVENTS_TOKEN_CAPTURE_PATH || join(APP_ROOT, 'bitrix-events-token.captured');
function captureEventsToken(data: Record<string, unknown>): void {
  const { token } = pickAuth(data);
  if (!/^[A-Za-z0-9]{16,64}$/.test(token)) return;
  try {
    let prev: { token: string; hits: number } | null = null;
    if (existsSync(CAPTURE_PATH)) {
      const m = /^BITRIX_EVENTS_APP_TOKEN=(\S+)\s+# hits=(\d+)/.exec(readFileSync(CAPTURE_PATH, 'utf8'));
      if (m) prev = { token: m[1], hits: Number(m[2]) };
    }
    if (prev && prev.token !== token) {
      console.warn(`[bitrix/events] перехват токена: пришёл ДРУГОЙ токен (${tokenHint(token)}) — файл не тронут, проверить вручную`);
      return;
    }
    const hits = (prev?.hits ?? 0) + 1;
    writeFileSync(CAPTURE_PATH, `BITRIX_EVENTS_APP_TOKEN=${token}  # hits=${hits}\n`, { mode: 0o600 });
    chmodSync(CAPTURE_PATH, 0o600);
    console.warn(`[bitrix/events] токен событий перехвачен в ${CAPTURE_PATH} (${tokenHint(token)}, совпадений ${hits}) — перенести в secrets.env`);
  } catch (e) {
    console.warn('[bitrix/events] перехват токена не удался:', e instanceof Error ? e.message : e);
  }
}

/** null — событие подлинное; иначе готовый ответ 403. Токен в лог — только первые 4 символа. */
function authenticateEvent(data: Record<string, unknown>): NextResponse | null {
  const r = authenticateBitrixEvent(data);
  if (r.ok) return null;
  if (r.reason === 'domain') {
    console.warn('[bitrix/events] отклонено: чужой домен');
  } else if (r.reason === 'token_mismatch') {
    console.warn(`[bitrix/events] отклонено: application_token не совпал (получен ${r.hint})`);
  } else {
    if (!notConfiguredWarned) {
      notConfiguredWarned = true;
      console.error('[bitrix/events] BITRIX_EVENTS_APP_TOKEN не задан — ВСЕ события отклоняются (fail-closed). '
        + `Задайте его в secrets.env = auth[application_token] событий Битрикса (получен ${r.hint}).`);
    }
    captureEventsToken(data);
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// Обработчик событий бота «Аналитик». Сейчас обслуживает чаты по сделкам
// (ответы менеджеров и клики по кнопкам bind_deal); разбор вопросов на
// естественном языке — по-прежнему Phase 2.
//
// Битрикс шлёт события form-encoded с плоскими ключами вида
// data[PARAMS][MESSAGE]; работаем прямо по этим ключам.
/** «Отчёт», «отчет», «report» — с любым регистром, точкой или восклицательным знаком. */
const REPORT_CMD_RE = /^\s*(отч[ёе]т|report)\s*[.!?]*\s*$/i;

/**
 * Отправить человеку его расписания прямо сейчас. Возвращает число отправленных.
 * Берём именно РАСПИСАНИЯ получателя: «типовой отчёт» для каждого свой, и он уже
 * настроен в «Настройки → Расписания отчётов» — дублировать это понятие незачем.
 */
async function sendSchedulesOnDemand(bitrixUserId: string): Promise<number> {
  if (!/^\d+$/.test(bitrixUserId)) return 0;
  const { systemDb } = await import('@/lib/db/clients');
  const { sendReportScheduleNow } = await import('@/lib/jobs/reportSchedules');
  const { sendBitrixBotMessage } = await import('@/lib/bitrix/notify');
  const r = await systemDb().query<{ id: string; name: string | null }>(
    `SELECT s.id::text, t.name FROM report_schedules s
       LEFT JOIN report_templates t ON t.id = s.template_id
      WHERE s.recipient_bitrix_id = $1 AND s.enabled = true
      ORDER BY s.send_time`,
    [bitrixUserId],
  );
  if (r.rows.length === 0) {
    await sendBitrixBotMessage(
      bitrixUserId,
      'Отчёт по команде «Отчёт» приходит тем, кому он настроен в «Настройки → Расписания отчётов». Для вас расписаний нет — попросите администратора добавить.',
      undefined, 'report_schedules',
    ).catch(() => 0);
    return 0;
  }
  let sent = 0;
  for (const row of r.rows) {
    try {
      await sendReportScheduleNow(row.id);
      sent++;
    } catch (e) {
      console.error('[bitrix/events] «Отчёт» не собрался:', row.name, e instanceof Error ? e.message : e);
      await sendBitrixBotMessage(bitrixUserId, `Не удалось собрать «${row.name ?? 'отчёт'}». Попробуйте ещё раз через минуту.`, undefined, 'report_schedules').catch(() => 0);
    }
  }
  return sent;
}

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
  // Без auth[*]: там application_token и access-токены — в лог не пишем (#8256).
  const loggable = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'auth' && !k.startsWith('auth[')));
  console.log('[bitrix/events]', event || 'unknown event', JSON.stringify(loggable).slice(0, 500));

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
      // Команда «Отчёт» (ТЗ владельца 28.09: «научим его команде „Отчет“, чтобы он по
      // этой команде слал типовой отчёт»). Типовой — это буквально то, что человек и
      // так получает по расписанию (report_schedules), поэтому команда просто шлёт его
      // сейчас: второго определения «типового отчёта» не заводим. Кому расписаний не
      // настроено — честно об этом говорим, а не молчим.
      let handledBy = handledByDealChats ? 'deal_chat' : 'unhandled';
      if (!handledByDealChats && REPORT_CMD_RE.test(str('data[PARAMS][MESSAGE]'))) {
        const sent = await sendSchedulesOnDemand(str('data[PARAMS][FROM_USER_ID]'));
        handledBy = sent > 0 ? 'report_command' : 'report_command_empty';
      } else if (!handledByDealChats) {
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

      // Кнопка «📋 Детально» под выпуском дайджеста «Как дела?» (15.09):
      // COMMAND_PARAMS = «дата:час» выпуска, ответ — раскладка по командам.
      const howKey = Object.keys(data).find(
        k => /^data\[COMMAND\]\[\d+\]\[COMMAND\]$/.test(k) && data[k] === 'how_details',
      );
      if (howKey) {
        const params = str(howKey.replace(/\[COMMAND\]$/, '[COMMAND_PARAMS]'));
        const { sendHowAreWeDetails } = await import('@/lib/jobs/howAreWe');
        const ok = await sendHowAreWeDetails(str('data[PARAMS][FROM_USER_ID]'), params);
        await logInbound({
          bitrixId: str('data[PARAMS][FROM_USER_ID]'), event, text: `кнопка: детали «Как дела?» (${params})${ok ? '' : ' — не отправлено'}`,
          dialogId: str('data[PARAMS][DIALOG_ID]'), messageId: str('data[PARAMS][MESSAGE_ID]'), replyTo: null, handledBy: 'how_are_we',
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
