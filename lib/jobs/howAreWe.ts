import { systemDb } from '@/lib/db/clients';
import { channelEnabled, getBotFunctionConfig, sendBitrixBotMessage, sendBitrixBotMessageWithImage } from '@/lib/bitrix/notify';
import { computeHowAreWeFacts, isWeekday, type HowAreWeFacts } from '@/features/how-are-we/engine/facts';
import { buildHowAreWeMessage } from '@/features/how-are-we/engine/text';
import { renderHowAreWePng, storeChart } from '@/features/how-are-we/engine/chart';
import type { PhraseOverrides } from '@/features/how-are-we/engine/phrases';

// Джоба дайджеста «Как дела?» (задача владельца 15.09.2026). Расписание — часы
// из how_are_we_settings (по умолчанию 12, 15, 18 МСК, будни); получатели — из
// реестра функций бота (bot_channels.how_are_we.config.recipients). Каждый выпуск —
// текст (bbcode) + картинка (см. engine/chart.ts). Всё отправленное — в how_are_we_log.

export interface HowAreWeSettings {
  hours: number[];
  weekdaysOnly: boolean;
  phrases: PhraseOverrides;
  updatedAt: string | null;
  updatedBy: string | null;
}
export const DEFAULT_HOW_ARE_WE_SETTINGS: HowAreWeSettings = { hours: [12, 15, 18], weekdaysOnly: true, phrases: {}, updatedAt: null, updatedBy: null };

export async function fetchHowAreWeSettings(): Promise<HowAreWeSettings> {
  try {
    const r = await systemDb().query<{ hours: number[]; weekdays_only: boolean; phrases: PhraseOverrides; updated_at: string; updated_by: string | null }>(
      'SELECT hours, weekdays_only, phrases, updated_at, updated_by FROM how_are_we_settings WHERE id = 1',
    );
    const row = r.rows[0];
    if (!row) return DEFAULT_HOW_ARE_WE_SETTINGS;
    return {
      hours: row.hours?.length ? row.hours : DEFAULT_HOW_ARE_WE_SETTINGS.hours,
      weekdaysOnly: row.weekdays_only, phrases: row.phrases ?? {},
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null, updatedBy: row.updated_by,
    };
  } catch { return DEFAULT_HOW_ARE_WE_SETTINGS; } // до миграции 212 — дефолты
}

export function baseUrl(): string {
  return (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.com').replace(/\/$/, '');
}

export function mskNowParts(now = new Date()): { date: string; hour: number; minute: number } {
  const msk = now.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }); // 'YYYY-MM-DD HH:mm:ss'
  const [date, time] = msk.split(' ');
  return { date, hour: parseInt(time.slice(0, 2), 10), minute: parseInt(time.slice(3, 5), 10) };
}

export interface BuiltDigest { facts: HowAreWeFacts; message: string; png: Buffer; imageUrl: string | null }

export async function buildHowAreWeDigest(dateStr: string, cutHour: number, settings?: HowAreWeSettings, phrasesOverride?: PhraseOverrides): Promise<BuiltDigest> {
  const s = settings ?? await fetchHowAreWeSettings();
  const facts = await computeHowAreWeFacts(dateStr, cutHour);
  const message = buildHowAreWeMessage(facts, { overrides: phrasesOverride ?? s.phrases, hours: s.hours, baseUrl: baseUrl() });
  const png = await renderHowAreWePng(facts);
  const token = await storeChart(png);
  return { facts, message, png, imageUrl: token ? `${baseUrl()}/api/how-are-we/chart/${token}` : null };
}

export interface SendOptions {
  cutHour: number;
  /** Дата выпуска (МСК); по умолчанию сегодня. */
  dateStr?: string;
  /** Отправить только этому bitrix id (проверка) — получатели из настроек игнорируются. */
  deliverTo?: string;
  test?: boolean;
}

export async function sendHowAreWe(opts: SendOptions): Promise<{ recipients: string[]; message: string; imageUrl: string | null }> {
  const dateStr = opts.dateStr ?? mskNowParts().date;
  const cfg = await getBotFunctionConfig('how_are_we');
  const recipients = opts.deliverTo ? [opts.deliverTo] : (cfg.recipients ?? []).filter(Boolean);
  if (!recipients.length) throw new Error('Получатели дайджеста «Как дела?» не заданы — Настройки → Боты → Аналитик → Функции');

  const built = await buildHowAreWeDigest(dateStr, opts.cutHour);
  for (const to of recipients) {
    // Пробная отправка явному адресату (кнопка «отправить мне» / тест-роут) идёт и
    // при выключенной функции: иначе владелец не увидит выпуск до включения на всех.
    if (built.imageUrl) await sendBitrixBotMessageWithImage(to, built.message, built.imageUrl, 'how_are_we', { test: !!opts.deliverTo });
    else if (opts.deliverTo) await sendBitrixBotMessageWithImage(to, built.message, '', 'how_are_we', { test: true });
    else await sendBitrixBotMessage(to, built.message, undefined, 'how_are_we');
    await systemDb().query(
      'INSERT INTO how_are_we_log (date_str, cut_hour, recipient, message, image_url, test) VALUES ($1, $2, $3, $4, $5, $6)',
      [dateStr, opts.cutHour, to, built.message, built.imageUrl, opts.test ?? false],
    ).catch(err => console.warn('[howAreWe] журнал не записан:', err instanceof Error ? err.message : err));
  }
  return { recipients, message: built.message, imageUrl: built.imageUrl };
}

/** Пора ли слать выпуск за этот час: функция включена, час в расписании, будни. */
export async function howAreWeDue(now = new Date()): Promise<{ date: string; hour: number } | null> {
  if (!(await channelEnabled('how_are_we'))) return null;
  const s = await fetchHowAreWeSettings();
  const { date, hour } = mskNowParts(now);
  if (!s.hours.includes(hour)) return null;
  if (s.weekdaysOnly && !isWeekday(date)) return null;
  return { date, hour };
}
