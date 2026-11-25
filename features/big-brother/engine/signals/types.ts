// «Большой брат», поток G — сигналы риска, реакция на бота, еженедельный дайджест директору.
// Типы общие для движка, API и UI (без серверных импортов).
import type { PersonRole } from '../daily/types';

/** Вид сигнала. Все — отклонение от СОБСТВЕННОЙ нормы человека, а не от общей планки. */
export type SignalKind =
  | 'no_signal'     // обычно в работе, но ≥ N рабочих дней подряд ни одного сигнала (звонки, сделки, задачи, Монолитика)
  | 'no_mono'       // обычно заходит в Монолитику, но ≥ N рабочих дней подряд не заходил
  | 'activity_drop' // последние 5 рабочих дней активность < доли нормы
  | 'night'         // ночная активность в Монолитике (22:00–06:00 МСК), которой раньше не было
  | 'export_spike'  // всплеск выгрузок и проваливаний в отчётах за неделю
  | 'new_surface';  // новый режим входа (телефон / PWA / Битрикс / десктоп), которого не было 60 дней

export const SIGNAL_LABEL: Record<SignalKind, string> = {
  no_signal: 'Пропал: нет рабочих сигналов',
  no_mono: 'Перестал заходить в Монолитику',
  activity_drop: 'Резкий спад активности',
  night: 'Ночная активность',
  export_spike: 'Всплеск выгрузок',
  new_surface: 'Новый способ входа',
};

/** Точка дневного ряда человека (из activity_daily или посчитанная вживую). */
export interface SeriesPoint {
  date: string;
  isWorkday: boolean;
  inWork: boolean;
  /** 5-мин отрезков с сильным сигналом (любой источник). */
  buckets: number;
  /** Активные минуты + события Монолитики за день (> 0 — заходил). */
  mono: number;
  /** Режимы входа за день (web / mobile / pwa / bx_iframe). */
  surfaces: string[];
  /** Выгрузки + проваливания в отчётах. */
  exports: number;
  /** Ночных 5-мин отрезков / событий Монолитики (22:00–06:00 МСК). */
  night: number;
}

export interface RiskSignal {
  personId: string;
  kind: SignalKind;
  /** С какой даты (МСК) идёт отклонение. */
  since: string;
  /** Человеческое пояснение с цифрами нормы. */
  detail: string;
  /** Для сортировки: больше — серьёзнее. */
  weight: number;
}

export interface SignalFeedItem extends RiskSignal {
  name: string;
  role: PersonRole;
  departmentName: string | null;
  ropName: string | null;
}

export interface BotReactionRow {
  messageId: string;
  sentAt: string;
  recipientId: string;
  recipientName: string | null;
  channel: string | null;
  /** Через сколько минут открыл Монолитику (по ссылке из сообщения или любой вход), null — не открыл за 24 ч. */
  openMin: number | null;
  openedByLink: boolean;
  /** Через сколько минут — первое действие или рабочий сигнал (звонок, стадия, задача, мутация), null — нет за 24 ч. */
  actMin: number | null;
  actKind: string | null;
}

export interface BotReactionSummary {
  /** null — журнала сообщений бота ещё нет (таблица bot_message_log не накатана). */
  since: string | null;
  available: boolean;
  total: number;
  opened: number;
  acted: number;
  /** Ни открытия, ни действия за 24 ч. */
  silent: number;
  medianOpenMin: number | null;
  medianActMin: number | null;
  byChannel: { channel: string; total: number; opened: number; acted: number; medianActMin: number | null }[];
  recent: BotReactionRow[];
}

export interface SignalsResponse {
  asOf: string;
  /** С какой даты есть данные Монолитики (первый день activity_daily с mono > 0) — до неё сигналы no_mono/night/… молчат. */
  monoSince: string | null;
  signals: SignalFeedItem[];
  bot: BotReactionSummary;
}

/** Настройки дайджеста — bot_channels.config строки 'big_brother_digest'. enabled — сама строка. */
export interface DigestSettings {
  enabled: boolean;
  /** preview — шлём только previewTo («отправить мне»); live — получателям. */
  mode: 'preview' | 'live';
  recipients: string[];
  previewTo: string;
  /** Час МСК понедельника. */
  hour: number;
}

export const DIGEST_DEFAULTS: DigestSettings = { enabled: false, mode: 'preview', recipients: [], previewTo: '2098', hour: 9 };
