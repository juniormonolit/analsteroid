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
    cityMsk: '#7FBF95',     // цвета филиалов, заданные владельцем 09.10: Питер — синий (c-primary),
    cityKrd: '#E29A94',     // Москва — зелёный, Краснодар — красный; оба приглушённые, чтобы
                            // не спорили с зелёным и красным отклонений и не бросались в глаза
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
    cityMsk: '#5E9E74',
    cityKrd: '#B8706A',
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
