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
// С 09.09.2026 (задача владельца «каждую функцию бота включать, настраивать и
// выключать») строка bot_channels = ОДНА ФУНКЦИЯ, а не смысловая группа: ключ
// передаёт вызывающий, и он же виден владельцу в «Настройки → Боты → Аналитик».
// Все функции после миграции 181 выключены — включает владелец руками.
export const BOT_FUNCTION_KEYS = [
  'invite_link', 'direct_access_link', 'widget_script',
  'daily_moscow_report', 'daily_os_teams_report', 'report_schedules', 'weekly_weather',
  'manager_digest_daily', 'manager_digest_weekly', 'rop_digest', 'advice_feedback',
  'gamification', 'deal_chats',
] as const;
export type BotChannel = (typeof BOT_FUNCTION_KEYS)[number];

/** Настройки функции: получатели (bitrix id) и час МСК — что именно значат поля,
 *  решает функция-потребитель; пустые значения = прежнее поведение (env/константы). */
export interface BotFunctionConfig {
  recipients?: string[];
  hour?: number;
}
interface BotFunctionRow { enabled: boolean; config: BotFunctionConfig }

// Общий рубильник «Аналитика» (bot_settings.killed, миграция 183; панель
// /settings/bots/analitik, кнопка «Вырубить бота»): true — молчит ВСЁ, сколько бы
// функций ни было включено. Живёт в том же кэше, что реестр функций.
let _killed = false;

let _channelCache: { map: Map<string, BotFunctionRow>; at: number } | null = null;
const CHANNEL_CACHE_TTL_MS = 30_000;

/** Сбросить кэш функций — зовётся из админки сразу после сохранения, чтобы
 *  владелец увидел эффект переключателя, а не ждал 30 секунд. */
export function invalidateBotChannelCache(): void { _channelCache = null; }

async function loadFunctions(): Promise<Map<string, BotFunctionRow> | null> {
  if (_channelCache && Date.now() - _channelCache.at < CHANNEL_CACHE_TTL_MS) return _channelCache.map;
  const map = new Map<string, BotFunctionRow>();
  try {
    // Динамический импорт: notify.ts тянут и сборщики, которым пул БД не нужен.
    const { systemDb } = await import('@/lib/db/clients');
    const r = await systemDb().query<{ key: string; enabled: boolean; config: BotFunctionConfig | null }>(
      'SELECT key, enabled, config FROM bot_channels',
    );
    for (const row of r.rows) map.set(row.key, { enabled: row.enabled, config: row.config ?? {} });
    // Колонка появилась миграцией 183; до неё — считаем «не вырублен» (реестр
    // функций и так всё режет), чтобы отсутствие колонки не глушило бота молча.
    const k = await systemDb().query<{ killed: boolean }>('SELECT killed FROM bot_settings WHERE id = 1').catch(() => null);
    _killed = k?.rows[0]?.killed ?? false;
    _channelCache = { map, at: Date.now() };
    return map;
  } catch {
    // Миграции нет или БД недоступна — молчим. Кэш НЕ ставим: иначе при разовом
    // сбое связи бот замолчал бы на полминуты уже после починки.
    return null;
  }
}

/** Настройки функции для её потребителя (получатели ежедневных отчётов и т.п.).
 *  Недоступная БД → {} — вызывающий падает на свой прежний дефолт. */
export async function getBotFunctionConfig(channel: BotChannel): Promise<BotFunctionConfig> {
  const map = await loadFunctions();
  return map?.get(channel)?.config ?? {};
}

/** Включена ли функция. Экспорт — для джоб, которые дорого СЧИТАТЬ (дайджесты,
 *  отчёты) и незачем считать, если отправка всё равно заглушена. */
export async function channelEnabled(channel: BotChannel): Promise<boolean> {
  const map = await loadFunctions();
  // Общий рубильник сильнее аварийного env: «Вырубить бота» из панели обязано
  // работать и когда на сервере поднят BOT_SEND_ENABLED=1.
  if (map && _killed) return false;
  if (process.env.BOT_SEND_ENABLED === '1') return true;   // аварийное «включить всё»
  return map?.get(channel)?.enabled ?? false;
}

/** Состояние общего рубильника — для панели (после loadFunctions актуально). */
export async function isBotKilled(): Promise<boolean> {
  await loadFunctions();
  return _killed;
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
/** Всегда true (сигнатура сохранена ради вызывающих). Рубильника у этого бота НЕТ
 *  намеренно — правка владельца 09.09: «у Контроля звонков одна функция —
 *  уведомления о пропущенных, он должен работать всегда; его настройки — только на
 *  /settings/bots/call-control». Реестр функций (bot_channels) — про «Аналитика».
 *  История: 09.08 канал call_control завели, чтобы он не глох вместе с
 *  геймификацией; 09.09 реестр стал пофункциональным и рубильник для отдельного
 *  бота с одной функцией потерял смысл (миграция 182 удалила строку). */
export async function sendCallControlBotMessage(bitrixUserId: string, message: string): Promise<boolean> {
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
  return true;
}
