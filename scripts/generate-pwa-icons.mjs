#!/usr/bin/env node
/**
 * Генерирует PNG-иконки PWA из мастер-SVG (public/icons/icon-mark.svg).
 * Источник правды — только SVG; PNG в public/ и app/apple-icon.png —
 * сборочный артефакт, коммитится, но при правке логотипа перегенерировать
 * этим скриптом, руками PNG не редактировать.
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * Пишет:
 *   public/icons/icon-192.png            (маска "any")
 *   public/icons/icon-512.png            (маска "any")
 *   public/icons/icon-maskable-192.png   (маска "maskable", тот же safe-zone SVG)
 *   public/icons/icon-maskable-512.png
 *   app/apple-icon.png                   (180×180 — Next.js file convention,
 *                                          сам добавляет <link rel="apple-touch-icon">)
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_SVG = join(ROOT, 'public', 'icons', 'icon-mark.svg');
const svg = readFileSync(SRC_SVG);

const targets = [
  { out: join(ROOT, 'public', 'icons', 'icon-192.png'), size: 192 },
  { out: join(ROOT, 'public', 'icons', 'icon-512.png'), size: 512 },
  { out: join(ROOT, 'public', 'icons', 'icon-maskable-192.png'), size: 192 },
  { out: join(ROOT, 'public', 'icons', 'icon-maskable-512.png'), size: 512 },
  { out: join(ROOT, 'app', 'apple-icon.png'), size: 180 },
];

for (const t of targets) {
  mkdirSync(dirname(t.out), { recursive: true });
  await sharp(svg, { density: 384 }).resize(t.size, t.size).png().toFile(t.out);
  console.log(`wrote ${t.out} (${t.size}x${t.size})`);
}
