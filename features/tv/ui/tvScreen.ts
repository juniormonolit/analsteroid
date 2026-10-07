// Страница телевизора с оформлением (задача: поменять внешний вид экрана ТВ, не трогая
// движок и API).
//
// Движок (features/tv/engine/page.ts) собирает страницу целиком — разметку, базовые
// стили и скрипт — и остаётся как был. Здесь к ГОТОВОЙ странице перед </head>
// добавляется оформление:
//   • блок стилей — идёт после стилей движка и перекрывает их;
//   • у оформления «Кольца» ещё и скрипт вида (tvViewRings.ts): макет владельца меняет
//     расположение блоков, а разметку выдаёт движок, поэтому вид перерисовывает то,
//     что движок уже нарисовал. Как именно и что будет, если он не запустится, —
//     в шапках tvViewRings.ts и tvSkinRings.ts.
//
// В мок-режиме (TV_MOCK=1, только не в production — см. features/tv/mock.ts) в той же
// готовой странице подменяются два адреса: фид и поток событий.
//
// Подмены сделаны по точным строкам из страницы движка. Если движок их изменит,
// подмена не найдёт строку — тогда страница отдаётся как есть (без оформления или
// без мока), а в лог сервера пишется, какая именно строка пропала.

import { renderTvPage, type TvPageConfig } from '../engine/page';
import { isTvMock } from '../mock';
import { TV_SKIN_CSS } from './tvSkin';
import { TV_SKIN_GRAPHITE_CSS } from './tvSkinGraphite';
import { TV_SKIN_RINGS_CSS } from './tvSkinRings';
import { TV_VIEW_RINGS_JS } from './tvViewRings';

// Оформлений три. На телевизорах всегда работает DEFAULT_TV_SKIN — выбора у экрана
// нет (для него понадобились бы настройка экрана и правка движка). Остальные оставлены
// для сравнения: в мок-режиме их можно включить адресом, например /tv?skin=graphite.
//   rings    — «Кольца», макет владельца от 07.10 (вид и расположение), выбран им
//   graphite — «Графит», предыдущий вариант: только перекраска разметки движка
//   kulikov  — «Дизайн Куликова», язык monolit.shop, первый вариант
interface TvSkin { css: string; js?: string }
const TV_SKINS = {
  rings: { css: TV_SKIN_RINGS_CSS, js: TV_VIEW_RINGS_JS },
  graphite: { css: TV_SKIN_GRAPHITE_CSS },
  kulikov: { css: TV_SKIN_CSS },
} satisfies Record<string, TvSkin>;
export type TvSkinId = keyof typeof TV_SKINS;
export const DEFAULT_TV_SKIN: TvSkinId = 'rings';
export function isTvSkinId(v: string | null): v is TvSkinId {
  return v !== null && Object.prototype.hasOwnProperty.call(TV_SKINS, v);
}

function patchOnce(html: string, find: string, replacement: string, what: string): string {
  const at = html.indexOf(find);
  if (at === -1) {
    console.error(`[tv/screen] не найдена строка для подмены (${what}): ${find}`);
    return html;
  }
  return html.slice(0, at) + replacement + html.slice(at + find.length);
}

export function renderTvScreen(cfg: TvPageConfig, skin: TvSkinId = DEFAULT_TV_SKIN): string {
  const s: TvSkin = TV_SKINS[skin];
  let html = renderTvPage(cfg);
  const view = s.js ? `<script id="tv-view">${s.js}</script>\n` : '';
  html = patchOnce(html, '</head>', `<style id="tv-skin" data-skin="${skin}">${s.css}</style>\n${view}</head>`, 'оформление');
  if (isTvMock()) {
    html = patchOnce(html, '"api":"/api/tv/feed"', '"api":"/tv/mock/feed"', 'мок: фид');
    html = patchOnce(html, "new EventSource('/api/tv/stream')", "new EventSource('/tv/mock/stream')", 'мок: поток событий');
  }
  return html;
}
