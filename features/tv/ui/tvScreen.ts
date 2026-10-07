// Страница телевизора с оформлением «Дизайн Куликова» (задача: поменять внешний вид
// экрана ТВ, не трогая движок и API).
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

function patchOnce(html: string, find: string, replacement: string, what: string): string {
  const at = html.indexOf(find);
  if (at === -1) {
    console.error(`[tv/screen] не найдена строка для подмены (${what}): ${find}`);
    return html;
  }
  return html.slice(0, at) + replacement + html.slice(at + find.length);
}

export function renderTvScreen(cfg: TvPageConfig): string {
  let html = renderTvPage(cfg);
  html = patchOnce(html, '</head>', `<style id="tv-skin">${TV_SKIN_CSS}</style>\n</head>`, 'оформление');
  if (isTvMock()) {
    html = patchOnce(html, '"api":"/api/tv/feed"', '"api":"/tv/mock/feed"', 'мок: фид');
    html = patchOnce(html, "new EventSource('/api/tv/stream')", "new EventSource('/tv/mock/stream')", 'мок: поток событий');
  }
  return html;
}
