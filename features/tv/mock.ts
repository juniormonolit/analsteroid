// «Телевизоры» — мок-режим для локальной работы над внешним видом экрана.
//
// Зачем: экран телевизора (/tv) берёт данные из /api/tv/feed, а тот ходит в боевые
// базы. У дизайнера доступа к ним нет. С TV_MOCK=1 экран получает данные отсюда:
//   TV_MOCK=1 npm run dev   →   http://localhost:3004/tv
//
// Как подключено (движок features/tv/engine и API app/api/tv НЕ менялись):
//   • app/tv/route.ts в мок-режиме рисует экран сразу по «токену экрана» — без
//     регистрации устройства и кода привязки, которым нужна база;
//   • features/tv/ui/tvScreen.ts подменяет в готовой странице адрес фида на
//     /tv/mock/feed, а адрес потока событий — на /tv/mock/stream;
//   • app/tv/mock/feed отдаёт buildMockFeed() из этого файла.
//
// БЕЗОПАСНОСТЬ. Мок включается только при TV_MOCK=1 И не в production-сборке.
// Стенд и прод запускаются production-сборкой (NODE_ENV=production), поэтому там
// переменная игнорируется, а адреса /tv/mock/* отвечают 404 — подсунуть телевизору
// в офисе ненастоящие цифры этим путём нельзя.
//
// Сцены — через адрес, можно сочетать:
//   /tv                       тёмная тема, карусель отделов
//   /tv?theme=light           светлая тема
//   /tv?scene=event           каждые 30 с прилетает «продажа» (конфетти)
//   /tv?scene=flash           то же, стиль «вспышка»
//   /tv?scene=toast           то же, стиль «уведомление в углу»
//   /tv?scene=banner          баннер-объявление поверх экрана
//   /tv?scene=full            объявление на весь экран
//   /tv?scene=pairing         экран с кодом привязки телевизора
//   /tv?scene=empty           экран без отделов
// Несколько сцен — через запятую: /tv?theme=light&scene=event,banner
// Прежнее оформление для сравнения: /tv?skin=kulikov (по умолчанию — то, что стоит на
// телевизорах, см. DEFAULT_TV_SKIN в features/tv/ui/tvScreen.ts). Сочетается со
// сценами: /tv?skin=kulikov&theme=light
//
// Все имена и цифры вымышленные.

import {
  DEFAULT_SCREEN_SETTINGS,
  type TvEventStyle, type TvFeed, type TvFeedCard, type TvFeedManager, type TvFeedMessage,
  type TvFeedOk, type TvFeedSale, type TvFeedSlide, type TvTheme,
} from './shared';

export function isTvMock(): boolean {
  return process.env.TV_MOCK === '1' && process.env.NODE_ENV !== 'production';
}

const SCENES = ['event', 'flash', 'toast', 'banner', 'full', 'pairing', 'empty'] as const;
type Scene = (typeof SCENES)[number];

/** Параметры адреса → «токен экрана». Сцена едет в токене, потому что страница
 *  дописывает к адресу фида только его (?s=<токен>), других параметров у неё нет. */
export function mockToken(params: URLSearchParams): string {
  const parts = ['mock'];
  if (params.get('theme') === 'light') parts.push('light');
  for (const s of (params.get('scene') ?? '').split(',')) {
    if ((SCENES as readonly string[]).includes(s.trim())) parts.push(s.trim());
  }
  return parts.join('-');
}
function parseToken(token: string | null): { theme: TvTheme; scenes: Set<Scene> } {
  const parts = (token ?? '').split('-');
  return {
    theme: parts.includes('light') ? 'light' : 'dark',
    scenes: new Set(parts.filter((p): p is Scene => (SCENES as readonly string[]).includes(p))),
  };
}

const DAILY_TARGET = DEFAULT_SCREEN_SETTINGS.dailyTarget;

function mgr(id: string, name: string, plan: number, salesCount: number, salesSum: number, bookCount: number, bookSum: number): TvFeedManager {
  return { id, name, avatar: null, plan, salesCount, salesSum, bookCount, bookSum };
}

// Набор нарочно неровный: лидер с перевыполнением, 451% и «12,5 млн ₽» (самая широкая
// строка плитки), менеджер без плана («—»), почти ноль, совсем ноль, длинная фамилия.
const DEPTS: Record<string, { branch: string; dept: string; ticker: string | null; managers: TvFeedManager[] }> = {
  'branch:spb': {
    branch: 'Санкт-Петербург', dept: 'СПб · Юр. лица 1', ticker: null,
    managers: [
      mgr('m01', 'Анна Соколова', 600_000, 5, 1_842_000, 3, 910_000),
      mgr('m02', 'Дмитрий Орлов', 650_000, 4, 1_250_000, 2, 480_000),
      mgr('m03', 'Екатерина Волкова', 550_000, 6, 743_000, 5, 1_120_000),
      mgr('m04', 'Максим Лебедев', 600_000, 3, 512_000, 1, 96_000),
      mgr('m05', 'Ольга Никитина', 400_000, 5, 388_500, 4, 265_000),
      mgr('m06', 'Сергей Морозов', 700_000, 2, 276_000, 0, 0),
      mgr('m07', 'Татьяна Белова', 0, 1, 148_000, 2, 73_500),
      mgr('m08', 'Артём Фёдоров', 500_000, 1, 9_400, 1, 31_000),
      mgr('m09', 'Константин Александровский-Преображенский', 450_000, 0, 0, 0, 0),
    ],
  },
  'branch:msk': {
    branch: 'Москва', dept: 'Москва · Объекты', ticker: 'Москва: до конца дня отгрузки принимаем до 17:30',
    managers: [
      mgr('m11', 'Игорь Павлов', 2_770_000, 12, 12_500_000, 7, 4_300_000),
      mgr('m12', 'Наталья Королёва', 1_500_000, 5, 1_980_000, 3, 760_000),
      mgr('m13', 'Юлия Григорьева', 900_000, 4, 640_000, 2, 315_000),
      mgr('m14', 'Павел Зайцев', 800_000, 2, 215_000, 1, 88_000),
      mgr('m15', 'Марина Кузнецова', 600_000, 0, 0, 3, 420_000),
    ],
  },
  'branch:krd': {
    branch: 'Краснодар', dept: 'Краснодар · Розница', ticker: null,
    managers: [
      mgr('m21', 'Виктория Мельникова', 350_000, 4, 402_000, 2, 118_000),
      mgr('m22', 'Роман Гусев', 350_000, 2, 187_000, 1, 54_000),
      mgr('m23', 'Алина Тихонова', 300_000, 1, 62_000, 0, 0),
    ],
  },
  'branch:ekb': {
    branch: 'Екатеринбург', dept: 'Екатеринбург · Юр. лица', ticker: null,
    managers: [
      mgr('m31', 'Денис Захаров', 500_000, 3, 530_000, 2, 240_000),
      mgr('m32', 'Светлана Борисова', 450_000, 2, 298_000, 2, 176_000),
    ],
  },
};

function totals(managers: TvFeedManager[]) {
  const sum = (f: (m: TvFeedManager) => number) => managers.reduce((s, m) => s + f(m), 0);
  const activeManagers = managers.filter(m => m.salesCount > 0 || m.bookCount > 0).length;
  const salesCount = sum(m => m.salesCount);
  const bookCount = sum(m => m.bookCount);
  return {
    planDay: sum(m => m.plan), factDay: sum(m => m.salesSum), salesCount,
    bookSum: sum(m => m.bookSum), bookCount, activeManagers,
    target: activeManagers * DAILY_TARGET, pb: salesCount + bookCount,
  };
}
const bySales = (a: TvFeedManager, b: TvFeedManager) => b.salesSum - a.salesSum;

function deptSlide(id: string): TvFeedSlide {
  const d = DEPTS[id];
  const managers = [...d.managers].sort(bySales);
  return { key: id, dept: d.dept, ...totals(managers), cards: [], ticker: d.ticker, managers };
}
function rootSlide(): TvFeedSlide {
  const all = Object.values(DEPTS).flatMap(d => d.managers).sort(bySales);
  const cards: TvFeedCard[] = Object.entries(DEPTS)
    .map(([id, d]) => ({ id, name: d.branch, ...totals(d.managers) }))
    .sort((a, b) => b.factDay - a.factDay);
  return { key: 'root', dept: 'Монолит', ...totals(all), cards, ticker: null, managers: all.slice(0, 6) };
}

const SCREEN_TICKER = 'Доброе утро, коллеги! План дня — на экране слева. Отгрузки на завтра оформляем до 16:00.';
// «Продажи» для сцен event/flash/toast: каждые 30 секунд у фида появляется новая
// запись — страница видит незнакомый id и запускает поздравление.
const EVENT_EVERY_MS = 30_000;
const EVENT_SALES: [string, string, number][] = [
  ['m01', 'Анна Соколова', 486_000],
  ['m11', 'Игорь Павлов', 1_240_000],
  ['m03', 'Екатерина Волкова', 97_500],
  ['m21', 'Виктория Мельникова', 215_000],
];

/** Фид для страницы телевизора в мок-режиме. token — то, что страница прислала в ?s=,
 *  node — узел при «проваливании» в карточку филиала (?node=). */
export function buildMockFeed(token: string | null, node: string | null): TvFeed {
  const { theme, scenes } = parseToken(token);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const v = 'mock';
  if (scenes.has('pairing')) return { state: 'pairing', v, now, code: 'K7QM', expiresInSec: 20 * 60 };

  let slides: TvFeedSlide[];
  if (node) {
    if (!DEPTS[node]) return { state: 'error', v, now, message: 'Узел вне экрана' };
    slides = [deptSlide(node)];
  } else {
    slides = scenes.has('empty') ? [] : [rootSlide(), deptSlide('branch:spb'), deptSlide('branch:msk')];
  }
  // У отдела без собственной строки показываем строку экрана — как делает настоящий фид.
  slides = slides.map(s => ({ ...s, ticker: s.ticker ?? SCREEN_TICKER }));

  const until = new Date(nowMs + 10 * 60_000).toISOString();
  const messages: TvFeedMessage[] = [];
  if (scenes.has('banner')) messages.push({ id: 'mock-banner', kind: 'banner', text: 'Планёрка в 15:00 в большой переговорной', until });
  if (scenes.has('full')) messages.push({ id: 'mock-full', kind: 'fullscreen', text: 'С днём рождения, Анна!', until });

  const style: TvEventStyle | null = scenes.has('toast') ? 'minimal' : scenes.has('flash') ? 'flash' : scenes.has('event') ? 'confetti' : null;
  const sales: TvFeedSale[] = [];
  if (style) {
    const n = Math.floor(nowMs / EVENT_EVERY_MS);
    const [managerId, managerName, amount] = EVENT_SALES[n % EVENT_SALES.length];
    sales.push({ id: `mock-sale-${n}`, managerId, managerName, amount, at: new Date(n * EVENT_EVERY_MS).toISOString() });
  }

  const feed: TvFeedOk = {
    state: 'ok', v, now,
    day: new Date(nowMs + 3 * 3600_000).toISOString().slice(0, 10), // «сегодня» по Москве
    screen: {
      id: 'mock', name: 'Демо-экран (мок)', theme, mode: 'carousel', rotateSec: 20, ticker: SCREEN_TICKER,
      settings: {
        ...DEFAULT_SCREEN_SETTINGS,
        events: { ...DEFAULT_SCREEN_SETTINGS.events, enabled: style !== null, style: style ?? 'confetti', durationSec: 10 },
      },
    },
    slides, messages, sales,
  };
  return feed;
}
