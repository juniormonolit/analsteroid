#!/usr/bin/env node
/**
 * Генерирует все иконки приложения (вкладка, apple-touch, PWA) из головы робота
 * Монолитика: public/brand/monolitik-head.png (задача 9023, Сергей одобрил:
 * иконка одна для всех тем). Источник правды — только этот PNG; результат
 * коммитится, руками не править, при смене маскота перегенерировать:
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * Пишет:
 *   app/icon.png                          512 (Next file convention → <link rel="icon">)
 *   app/favicon.ico                       16/32/48 (PNG внутри ICO)
 *   app/apple-icon.png                    180 (полный квадрат, iOS скругляет сам)
 *   public/icons/icon-192.png, icon-512.png            (purpose "any", скруглённая плитка)
 *   public/icons/icon-maskable-192.png, -512.png       (purpose "maskable", поля ~10%+)
 * Фон везде — тёмная плитка #1F2937. На 16–48 px голова вписана почти впритык.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#1F2937';
const head = readFileSync(join(ROOT, 'public', 'brand', 'monolitik-head.png'));
const meta = await sharp(head).metadata();

/** @param size сторона; @param fill доля стороны под ширину головы; @param radius доля скругления плитки (0 = полный квадрат) */
async function render(size, fill, radius) {
  const w = Math.round(size * fill);
  const h = Math.round((w * meta.height) / meta.width);
  const headBuf = await sharp(head).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer();
  const r = Math.round(size * radius);
  const tile = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="${BG}"/></svg>`,
  );
  return sharp(tile)
    .composite([{ input: headBuf, left: Math.round((size - w) / 2), top: Math.round((size - h) / 2) }])
    .png()
    .toBuffer();
}

async function out(rel, buf) {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  console.log(`wrote ${rel}`);
}

// Вкладка: 16/32/48 — голова на 94% ширины; 512 — с воздухом.
await out('app/icon.png', await render(512, 0.84, 0.2));
await out('app/apple-icon.png', await render(180, 0.8, 0));
await out('public/icons/icon-192.png', await render(192, 0.84, 0.2));
await out('public/icons/icon-512.png', await render(512, 0.84, 0.2));
// maskable: безопасная зона — круг 80%; голова шире высоты, 66% ширины укладывается в круг.
await out('public/icons/icon-maskable-192.png', await render(192, 0.66, 0));
await out('public/icons/icon-maskable-512.png', await render(512, 0.66, 0));

// favicon.ico: ICO-контейнер с тремя PNG.
const sizes = [16, 32, 48];
const pngs = [];
for (const s of sizes) pngs.push(await render(s, 0.94, 0.16));
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((s, i) => {
  const o = 6 + i * 16;
  dir[o] = s; dir[o + 1] = s; dir[o + 2] = 0; dir[o + 3] = 0;
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(pngs[i].length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += pngs[i].length;
});
await out('app/favicon.ico', Buffer.concat([dir, ...pngs]));

// Превью 16/32 для показа (не часть сборки).
if (process.env.PREVIEW_DIR) {
  mkdirSync(process.env.PREVIEW_DIR, { recursive: true });
  for (const s of [16, 32]) writeFileSync(join(process.env.PREVIEW_DIR, `favicon-${s}.png`), await render(s, 0.94, 0.16));
}
