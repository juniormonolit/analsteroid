// «Дашборд тест» — оформление, общее для всех видов страницы: палитра (светлая и тёмная),
// шрифт и выбранная тема. Стиль сайта monolit.shop по макетам владельца
// (docs/design/monolitika-redesign-monolitshop-20261006, токены — 00-stil.html).

// Палитра задана здесь явно, а не токенами темы приложения: страница должна выглядеть
// как макет в любой теме приложения. Светлая и тёмная палитры — токены макета
// (:root и :root[data-theme="dark"] в 00-stil.html); слева имя цвета, справа токен.
export const THEMES = {
  light: {
    bg: '#F3F6F7',          // c-bg
    surface: '#FFFFFF',     // c-surface
    mutedBg: '#F3F4F6',     // c-muted-bg
    line: '#D1D5DB',        // c-border-strong
    text: '#343433',        // c-text
    muted: '#5F6672',       // c-text-muted-bg
    primary: '#005CA9',     // c-primary
    onPrimary: '#FFFFFF',   // c-on-primary — текст на синей плашке
    accent: '#F2CC7F',      // c-accent — жёлтый сайта: фильтр «Департамент» (у «Филиала» — синий)
    onAccent: '#343433',    // текст на жёлтой плашке (как счётчик .cnt в макете)
    primarySoft: '#E5EEF6', // c-primary-soft — плашка названия отдела в подробных видах
    group: '#E6EBEE',       // подложка блока города на вкладке «Все» (чуть темнее c-bg)
    success: '#009B22',     // c-success
    successText: '#007A1B', // c-success-text
    error: '#D40000',       // c-error
    warn: '#E0B45A',        // c-accent-hover — жёлтый сайта, на белом читается лучше c-accent
    track: '#E5E7EB',       // c-border — дорожка кольца
    base: '#B4BAC4',        // серый «с чем сравниваем» на графиках периодов
    city2: '#E08A1E',       // цвета филиалов на графике «Сделки по филиалам»: первый — c-primary,
    city3: '#12A08F',       // дальше оранжевый, бирюзовый, фиолетовый
    city4: '#8B5CD6',
    // Цвета филиалов (владелец 10.10: «Краснодар красный оставим, Питер и Москву придумать, чтобы
    // цвет не повторялся» — с цветами этапов: жёлтый, голубой, синий, зелёный). Питер — фиолетовый,
    // Москва — оранжевый, Краснодар — красный. До 10.10: Питер синий, Москва зелёная. Затем
    // (10.10, «Питер не нравится») Питер — бирюза Зимнего дворца, и все три — нежнее.
    citySpb: '#6CC2B5',
    cityMsk: '#F2A866',
    cityKrd: '#E88882',
    // департаменты выбранного филиала на графиках «по департаментам» — свои цвета, не филиалов и не этапов
    dept1: '#5F6B7A', dept2: '#D2589B', dept3: '#A37444', dept4: '#8A7FC4',
    // Цвета этапов (внутреннее ранжирование владельца, 10.10): сделки — нежно-жёлтый, брони —
    // нежно-голубой, продажи — нежно-синий, отгрузки — нежно-зелёный. *Bg — подложка блока,
    // без суффикса — линия под заголовком и метка.
    dealsBg: '#F9EECD', deals: '#E3B552',
    resvBg: '#D9F1F8', resv: '#4FB4D8',
    salesBg: '#DCE3F5', sales: '#2F6BBF',
    shipBg: '#DCF0E2', ship: '#4AA66A',
    // столбцы и линии текущего периода в блоке этапа (владелец 10.10: «столбцы подкрасим, только
    // не нежным цветом, а обычным»); *Ink — тот же цвет темнее, для чисел и дат (жёлтое на белом
    // не читается). У продаж — синий сайта (primary).
    dealsBar: '#EDB437', dealsInk: '#94650C',
    resvBar: '#38AADB', resvInk: '#1A78A3',
    shipBar: '#3FA463', shipInk: '#247A41',
  },
  dark: {
    bg: '#141B24',
    surface: '#1F2937',
    mutedBg: '#273343',
    line: '#3D4A5C',
    text: '#E7ECEF',
    muted: '#A3ABB8',
    primary: '#4C9BE0',
    onPrimary: '#0B1420',
    accent: '#F2CC7F',
    onAccent: '#1B2330',
    primarySoft: '#16314A',
    group: '#0E141B',       // подложка блока города — чуть темнее c-bg
    success: '#2FBF4F',
    successText: '#4CD068',
    error: '#FF5A5A',
    warn: '#F2CC7F',        // c-accent — на тёмном читается лучше c-accent-hover
    track: '#2E3A4A',       // c-border
    base: '#66738A',
    city2: '#F2B45C',
    city3: '#3CC9B6',
    city4: '#B39AF0',
    citySpb: '#5CB3A6',
    cityMsk: '#E39A5C',
    cityKrd: '#D6807A',
    dept1: '#8C98A8', dept2: '#E57DB5', dept3: '#C99868', dept4: '#A99BE0',
    dealsBg: '#2E2919', deals: '#D9B260',
    resvBg: '#132F3B', resv: '#5CB9DC',
    salesBg: '#1A2342', sales: '#5C93E0',
    shipBg: '#183023', ship: '#55B577',
    dealsBar: '#E3B04A', dealsInk: '#F0C46A',
    resvBar: '#4DB8E3', resvInk: '#72C8EB',
    shipBar: '#4CB872', shipInk: '#72CC91',
  },
} as const;
export type ThemeName = keyof typeof THEMES;
type ColorName = keyof typeof THEMES.light;
const COLOR_NAMES = Object.keys(THEMES.light) as ColorName[];
// Цвета в разметке — ссылки на переменные; сами значения задаёт корень страницы
// (.dt-root) по выбранной теме, поэтому переключение не перерисовывает карточки.
export const C = Object.fromEntries(COLOR_NAMES.map(k => [k, `var(--dt-${k})`])) as Record<ColorName, string>;
const themeVars = (t: ThemeName) => COLOR_NAMES.map(k => `--dt-${k}:${THEMES[t][k]}`).join(';');
export const THEME_CSS = `.dt-root{${themeVars('light')};color-scheme:light}.dt-root[data-dt-theme="dark"]{${themeVars('dark')};color-scheme:dark}`
  // .dt-click — всё, что открывает окно «Менеджеры»: при наведении синяя обводка
  + `.dt-click{cursor:pointer;transition:box-shadow .12s}.dt-click:hover,.dt-click:focus-visible{box-shadow:0 0 0 2px var(--dt-primary);outline:none}`
  // вкладки периода: невыбранная при наведении подсвечивается, фокус с клавиатуры виден
  + `.dt-tab[aria-selected="false"]:hover{background:var(--dt-mutedBg)}.dt-tab:focus-visible{outline:2px solid var(--dt-accent);outline-offset:2px}`;

// Выбранная тема страницы живёт в браузере пользователя (localStorage); если хранилище
// недоступно — в памяти до закрытия вкладки. На сервере и при первом показе — светлая.
const THEME_KEY = 'dashboard-test-theme';
let themeMem: ThemeName | null = null;
const themeListeners = new Set<() => void>();
export function readTheme(): ThemeName {
  if (themeMem) return themeMem;
  try { return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
export function writeTheme(t: ThemeName) {
  themeMem = t;
  try { window.localStorage.setItem(THEME_KEY, t); } catch { /* хранилище закрыто — тема останется до закрытия вкладки */ }
  themeListeners.forEach(fn => fn());
}
export function subscribeTheme(fn: () => void) {
  themeListeners.add(fn);
  return () => { themeListeners.delete(fn); };
}

export const FONT = "'MontserratTV', 'Montserrat', 'Segoe UI', Arial, sans-serif";
// Montserrat уже лежит в public/tv/assets — подключаем его же, чтобы шрифт не зависел
// от выбранной темы приложения.
export const FONT_FACES = [400, 500, 700]
  .map(w => `@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-${w}.woff2) format("woff2");font-weight:${w};font-style:normal;font-display:swap}`)
  .join('');
