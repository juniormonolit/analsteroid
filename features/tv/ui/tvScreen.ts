// Страница телевизора с оформлением (задача: поменять внешний вид экрана ТВ, не трогая
// движок и API).
//
// Движок (features/tv/engine/page.ts) собирает страницу целиком — разметку, базовые
// стили и скрипт — и остаётся как был. Здесь к ГОТОВОЙ странице добавляется второй
// блок стилей (tvSkin.ts): он идёт после стилей движка и перекрывает в них только
// «краску» — цвета, шрифт, скругления, рамки. Геометрию (позиции, размеры плиток,
// которые считает скрипт) оформление не меняет.
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

// Оформлений два. На телевизорах всегда работает DEFAULT_TV_SKIN — выбора у экрана
// нет (для него понадобились бы настройка экрана и правка движка). Второе оставлено
// для сравнения: в мок-режиме его можно включить адресом /tv?skin=kulikov.
//   graphite — «Графит», по референсу владельца от 07.10, выбран им (tvSkinGraphite.ts)
//   kulikov  — «Дизайн Куликова», язык monolit.shop, первый вариант (tvSkin.ts)
const TV_SKINS = { graphite: TV_SKIN_GRAPHITE_CSS, kulikov: TV_SKIN_CSS } as const;
export type TvSkinId = keyof typeof TV_SKINS;
export const DEFAULT_TV_SKIN: TvSkinId = 'graphite';
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
  let html = renderTvPage(cfg);
  html = patchOnce(html, '</head>', `<style id="tv-skin" data-skin="${skin}">${TV_SKINS[skin]}</style>\n</head>`, 'оформление');
  if (isTvMock()) {
    html = patchOnce(html, '"api":"/api/tv/feed"', '"api":"/tv/mock/feed"', 'мок: фид');
    html = patchOnce(html, "new EventSource('/api/tv/stream')", "new EventSource('/tv/mock/stream')", 'мок: поток событий');
  }
  return html;
}
