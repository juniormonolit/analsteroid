#!/usr/bin/env node
/**
 * Генерирует iOS splash-экраны (apple-touch-startup-image, задача 2947,
 * П2.9 плана мобильной готовности) из того же брендового знака, что PWA-
 * иконки/фавикон (public/icons/icon-mark.svg, см. scripts/generate-pwa-icons.mjs)
 * — только БЕЗ белого фона из мастер-SVG, поскольку фон сплэша должен
 * подстраиваться под тему (светлая/тёмная), а не быть всегда белым квадратом.
 * Геометрия трёх столбиков продублирована здесь вручную (BAR_SVG ниже) —
 * при правке знака в icon-mark.svg поправить и здесь (координаты идентичны).
 *
 * В отличие от sw.js (генерируется на КАЖДОЙ сборке, timestamp-версия) —
 * это детерминированная сборочная задача, как generate-pwa-icons.mjs:
 * запускать руками при смене логотипа/списка устройств, результат
 * коммитится (public/icons/splash/*.png + manifest.json).
 *
 *   node scripts/generate-splash-screens.mjs
 *
 * Список устройств — практичный набор «основных размеров» активных iPhone/
 * iPad (не исчерпывающий каталог всех моделей когда-либо выпущенных):
 * от iPhone SE2/3 до iPhone 15/16 Pro Max + 2 самых массовых iPad. Формат
 * media — канон Apple (device-width/height в CSS-пунктах +
 * -webkit-device-pixel-ratio + orientation), с ДОПОЛНИТЕЛЬНЫМ
 * prefers-color-scheme — Safari корректно учитывает его в apple-touch-
 * startup-image media, поэтому светлая/тёмная тема получают разные сплэши.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'icons', 'splash');
mkdirSync(OUT_DIR, { recursive: true });

// { label, ptW, ptH, dpr } — device-width/height в CSS-пунктах (то, что реально
// матчится в media query), dpr — -webkit-device-pixel-ratio. Физические px
// экрана = pt × dpr (portrait; альбомная ориентация не генерируется — манифест
// приложения объявляет orientation: 'portrait-primary').
const DEVICES = [
  { label: 'iphone-se23', ptW: 375, ptH: 667, dpr: 2 },   // iPhone SE 2/3 gen, 6/7/8
  { label: 'iphone-11-xr', ptW: 414, ptH: 896, dpr: 2 },  // iPhone 11, XR
  { label: 'iphone-x-11pro', ptW: 375, ptH: 812, dpr: 3 }, // iPhone X/XS/11 Pro
  { label: 'iphone-12-14', ptW: 390, ptH: 844, dpr: 3 },   // iPhone 12/12 Pro/13/13 Pro/14
  { label: 'iphone-14pro-16', ptW: 393, ptH: 852, dpr: 3 }, // iPhone 14 Pro/15/15 Pro/16
  { label: 'iphone-xsmax-11promax', ptW: 414, ptH: 896, dpr: 3 }, // XS Max/11 Pro Max
  { label: 'iphone-12-14-max', ptW: 428, ptH: 926, dpr: 3 }, // 12/13 Pro Max, 14 Plus
  { label: 'iphone-14-16-promax', ptW: 430, ptH: 932, dpr: 3 }, // 14 Pro Max/15 Plus/15 Pro Max/16 Plus
  { label: 'ipad-97', ptW: 768, ptH: 1024, dpr: 2 },   // iPad 9.7"
  { label: 'ipad-pro11', ptW: 834, ptH: 1194, dpr: 2 }, // iPad Pro 11"
];

const THEMES = {
  light: '#f8f9fa', // = --color-bg светлой темы, app/globals.css
  dark: '#14161b',  // = --color-bg тёмной темы, app/globals.css
};

// Геометрия — 1:1 копия трёх столбиков icon-mark.svg, без фонового <rect>.
const BAR_SVG = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect x="112" y="157" width="72" height="198" rx="36" fill="#3b82f6"/>
  <rect x="220" y="238" width="72" height="117" rx="36" fill="#ef4444"/>
  <rect x="328" y="157" width="72" height="198" rx="36" fill="#22c55e"/>
</svg>`;

const manifest = [];

for (const d of DEVICES) {
  const width = d.ptW * d.dpr;
  const height = d.ptH * d.dpr;
  const iconPx = Math.round(Math.min(width, height) * 0.22);
  const iconBuf = await sharp(Buffer.from(BAR_SVG), { density: 384 }).resize(iconPx, iconPx).png().toBuffer();

  for (const [theme, bg] of Object.entries(THEMES)) {
    const fileName = `apple-splash-${d.label}-${width}x${height}-${theme}.png`;
    const outPath = join(OUT_DIR, fileName);
    await sharp({ create: { width, height, channels: 4, background: bg } })
      .composite([{ input: iconBuf, gravity: 'center' }])
      .png()
      .toFile(outPath);
    manifest.push({
      href: `/icons/splash/${fileName}`,
      media: `(device-width: ${d.ptW}px) and (device-height: ${d.ptH}px) and (-webkit-device-pixel-ratio: ${d.dpr}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`,
    });
    console.log(`wrote ${outPath}`);
  }
}

writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${join(OUT_DIR, 'manifest.json')} (${manifest.length} entries)`);
