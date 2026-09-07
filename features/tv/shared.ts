// «Телевизоры» — общие типы клиента и сервера (ТЗ владельца 07.09.2026).
// Публичная ТВ-страница (/tv) написана на ES5 без React и эти типы не
// импортирует — но форма фида (TvFeed*) описана здесь как контракт, чтобы
// движок (features/tv/engine/feed.ts) и клиентский скрипт
// (features/tv/engine/client.ts) не разъезжались.

export type TvTheme = 'dark' | 'light';
export type TvMode = 'carousel' | 'merged';
export type TvMessageKind = 'ticker' | 'banner' | 'fullscreen';
export type TvEventStyle = 'confetti' | 'flash' | 'minimal';

export interface TvEventSettings {
  /** Общий выключатель «мувиков». */
  enabled: boolean;
  /** Реагировать на новую продажу. */
  sale: boolean;
  /** Реагировать на выполнение дневного плана отдела (пересечение 100%). */
  planDone: boolean;
  /** Порог суммы продажи, ниже которого не празднуем (₽). 0 = любая. */
  minAmount: number;
  /** Звук (best-effort: ТВ-браузер может не дать автоплей без жеста). */
  sound: boolean;
  /** Длительность показа, сек. */
  durationSec: number;
  style: TvEventStyle;
}

export interface TvScreenSettings {
  events: TvEventSettings;
  tickerSpeed: 'slow' | 'normal' | 'fast';
  showAvatars: boolean;
}

export const DEFAULT_EVENT_SETTINGS: TvEventSettings = {
  enabled: true, sale: true, planDone: true, minAmount: 0, sound: false, durationSec: 12, style: 'confetti',
};
export const DEFAULT_SCREEN_SETTINGS: TvScreenSettings = {
  events: DEFAULT_EVENT_SETTINGS, tickerSpeed: 'normal', showAvatars: true,
};

export interface TvDeviceInfo {
  id: string;
  label: string | null;
  userAgent: string | null;
  lastSeenAt: string | null;
  pairedAt: string | null;
  createdAt: string;
  /** Опрашивал фид меньше 90 с назад. */
  online: boolean;
}

export interface TvScreen {
  id: string;
  name: string;
  comment: string | null;
  publicToken: string;
  departmentIds: string[];
  departmentNames: string[];
  mode: TvMode;
  theme: TvTheme;
  rotateSec: number;
  tickerText: string | null;
  tickerEnabled: boolean;
  settings: TvScreenSettings;
  createdAt: string;
  updatedAt: string;
  devices: TvDeviceInfo[];
}

export interface TvScreenInput {
  name: string;
  comment: string | null;
  departmentIds: string[];
  mode: TvMode;
  theme: TvTheme;
  rotateSec: number;
  tickerText: string | null;
  tickerEnabled: boolean;
  settings: TvScreenSettings;
}

export interface TvMessage {
  id: string;
  kind: TvMessageKind;
  text: string;
  /** null = все экраны. */
  targetScreenIds: string[] | null;
  targetScreenNames: string[] | null;
  startsAt: string;
  endsAt: string;
  createdByName: string | null;
  createdAt: string;
  active: boolean;
}

export interface TvMessageInput {
  kind: TvMessageKind;
  text: string;
  targetScreenIds: string[] | null;
  /** Минут показа от «сейчас» (1..1440) — либо явное endsAt. */
  minutes?: number;
  endsAt?: string;
}

// ── Фид (то, что телевизор получает раз в N секунд) ─────────────────────────

export interface TvFeedManager {
  id: string;
  name: string;
  avatar: string | null;
  plan: number;        // дневной план продаж, ₽ (0 — плана нет)
  salesCount: number;
  salesSum: number;
  bookCount: number;
  bookSum: number;
}

export interface TvFeedSlide {
  key: string;
  dept: string;        // заголовок слайда («Отдел металлопроката», «ОС МСК + ЖБИ МСК»)
  planDay: number;
  factDay: number;
  salesCount: number;
  bookSum: number;
  bookCount: number;
  managers: TvFeedManager[];
}

export interface TvFeedSale {
  id: string;          // deal_id
  managerId: string;
  managerName: string;
  amount: number;
  at: string;          // ISO sold_at
}

export interface TvFeedMessage {
  id: string;
  kind: TvMessageKind;
  text: string;
  until: string;
}

export interface TvFeedOk {
  state: 'ok';
  /** BUILD_ID сервера — клиент перезагружает страницу при смене (деплой). */
  v: string;
  now: string;
  day: string;         // YYYY-MM-DD МСК — «сегодня» фида
  screen: {
    id: string;
    name: string;
    theme: TvTheme;
    mode: TvMode;
    rotateSec: number;
    ticker: string | null;   // собственный текст экрана (если включён)
    settings: TvScreenSettings;
  };
  slides: TvFeedSlide[];
  messages: TvFeedMessage[];
  /** Продажи сегодня по менеджерам экрана (для событий), новые — первыми. */
  sales: TvFeedSale[];
}

export interface TvFeedPairing {
  state: 'pairing';
  v: string;
  now: string;
  code: string;
  expiresInSec: number;
}

export interface TvFeedError {
  state: 'unknown_device' | 'unknown_screen' | 'error';
  v: string;
  now: string;
  message?: string;
}

export type TvFeed = TvFeedOk | TvFeedPairing | TvFeedError;

/** Интервал опроса фида телевизором, сек. */
export const TV_POLL_SEC = 15;
/** Устройство «онлайн», если опрашивало фид не позже чем N секунд назад. */
export const TV_ONLINE_SEC = 90;
/** Алфавит кода привязки — без 0/O/1/I, чтобы не путать с пульта. */
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_CODE_LEN = 4;
export const PAIR_CODE_TTL_MIN = 20;

export function normalizeSettings(raw: unknown): TvScreenSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ev = (r.events && typeof r.events === 'object' ? r.events : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const num = (v: unknown, d: number, min: number, max: number) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const style: TvEventStyle = ev.style === 'flash' || ev.style === 'minimal' ? ev.style : 'confetti';
  const speed = r.tickerSpeed === 'slow' || r.tickerSpeed === 'fast' ? r.tickerSpeed : 'normal';
  return {
    events: {
      enabled: bool(ev.enabled, DEFAULT_EVENT_SETTINGS.enabled),
      sale: bool(ev.sale, DEFAULT_EVENT_SETTINGS.sale),
      planDone: bool(ev.planDone, DEFAULT_EVENT_SETTINGS.planDone),
      minAmount: num(ev.minAmount, 0, 0, 1e12),
      sound: bool(ev.sound, false),
      durationSec: num(ev.durationSec, DEFAULT_EVENT_SETTINGS.durationSec, 3, 120),
      style,
    },
    tickerSpeed: speed,
    showAvatars: bool(r.showAvatars, true),
  };
}
