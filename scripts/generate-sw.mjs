#!/usr/bin/env node
/**
 * Генерирует public/sw.js из public/sw.template.js (задача 2947) —
 * подставляет вместо __SW_VERSION__ момент запуска сборки (Date.now()).
 * Запускается автоматически перед `next build`/`next dev` (package.json →
 * "prebuild"/"predev") — версия кэша офлайн-заглушки бампается сама на
 * КАЖДОЙ сборке, без ручного шага (см. комментарий в шапке шаблона: это и
 * есть механизм, из-за которого пользователь не залипает на старой версии
 * SW после деплоя).
 *
 *   node scripts/generate-sw.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'public', 'sw.template.js');
const OUT = join(ROOT, 'public', 'sw.js');

const version = String(Date.now());
const src = readFileSync(TEMPLATE, 'utf8').replaceAll('__SW_VERSION__', version);
writeFileSync(OUT, src);
console.log(`wrote ${OUT} (SW_VERSION=${version})`);
