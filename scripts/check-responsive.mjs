#!/usr/bin/env node
/**
 * Линтер правил адаптивности (см. CLAUDE.md, раздел «Адаптивность»).
 *
 * Сканирует app/, components/, features/ и ищет паттерны, ломающие мобильную
 * вёрстку. Существующий долг зафиксирован в scripts/responsive-baseline.json —
 * скрипт падает только на НОВЫХ нарушениях (счётчик по файлу+правилу вырос).
 *
 *   node scripts/check-responsive.mjs                — проверка (exit 1 при новых)
 *   node scripts/check-responsive.mjs --update-baseline — перезаписать baseline
 *   node scripts/check-responsive.mjs --all          — показать все нарушения, включая baseline
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_PATH = join(ROOT, 'scripts', 'responsive-baseline.json');
const SCAN_DIRS = ['app', 'components', 'features'];
const EXT = /\.(tsx|ts|css)$/;

// Правила: name → { test(line) | testFile(src), message }
const LINE_RULES = [
  {
    name: 'fixed-width-no-max',
    message: 'Фиксированная ширина ≥320px без max-w-ограничителя (правило 1 CLAUDE.md)',
    test: (line) => {
      // min-w-[...] внутри scroll-обёртки — правильный паттерн, не ловим.
      // Ширины с responsive-префиксом (md:w-[...]) или с w-full/max-w рядом — тоже ок.
      const m = line.match(/(?<![\w:-])w-\[(\d+)px\]/);
      if (m && Number(m[1]) >= 320 && !/max-w|w-full/.test(line)) return true;
      const s = line.match(/width:\s*(\d+)\b(?!.*%)/);
      if (s && Number(s[1]) >= 320 && !/maxWidth|max-w/.test(line)) return true;
      return false;
    },
  },
  {
    name: 'hover-only-control',
    message: 'Hover-only элемент — на таче недоступен; использовать класс hover-reveal (правило 5)',
    test: (line) => /opacity-0[^"'`]*group-hover:opacity-100|group-hover:opacity-100[^"'`]*opacity-0/.test(line),
  },
  {
    name: 'manual-popover-positioning',
    message: 'Позиционирование поповера через getBoundingClientRect — использовать components/ui/Popover (правило 4)',
    test: (line) => /getBoundingClientRect/.test(line),
  },
  {
    name: 'h-screen',
    message: 'h-screen ломается в мобильном Safari — использовать h-dvh (правило 7)',
    test: (line) => /[\s"'`]h-screen\b/.test(line),
  },
];

const FILE_RULES = [
  {
    name: 'table-without-scroll-wrapper',
    message: 'Файл содержит <table> без scroll-x / overflow-x-auto обёртки (правило 2)',
    test: (src) => /<table[\s>]/.test(src) && !/scroll-x|overflow-x-auto|overflow-auto/.test(src),
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'api') continue; // api-роуты — не UI
      yield* walk(p);
    } else if (EXT.test(name)) {
      yield p;
    }
  }
}

const violations = []; // { key: 'file::rule', file, line, rule, message, excerpt }
for (const dir of SCAN_DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      // Строки-комментарии не ловим — там паттерны упоминаются в пояснениях
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const rule of LINE_RULES) {
        if (rule.test(line)) {
          violations.push({
            key: `${rel}::${rule.name}`, file: rel, line: i + 1,
            rule: rule.name, message: rule.message, excerpt: line.trim().slice(0, 120),
          });
        }
      }
    });
    for (const rule of FILE_RULES) {
      if (rule.test(src)) {
        violations.push({
          key: `${rel}::${rule.name}`, file: rel, line: 0,
          rule: rule.name, message: rule.message, excerpt: '',
        });
      }
    }
  }
}

// counts per file::rule
const counts = {};
for (const v of violations) counts[v.key] = (counts[v.key] ?? 0) + 1;

if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + '\n');
  console.log(`Baseline обновлён: ${Object.keys(counts).length} записей, ${violations.length} нарушений.`);
  process.exit(0);
}

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
const showAll = process.argv.includes('--all');

let fresh = 0;
const grouped = new Map();
for (const v of violations) grouped.set(v.key, [...(grouped.get(v.key) ?? []), v]);

for (const [key, list] of grouped) {
  const allowed = baseline[key] ?? 0;
  const isNew = list.length > allowed;
  if (!isNew && !showAll) continue;
  if (isNew) fresh += list.length - allowed;
  const status = isNew ? 'НОВОЕ' : 'baseline';
  for (const v of list.slice(0, isNew ? undefined : 3)) {
    console.log(`[${status}] ${v.file}${v.line ? ':' + v.line : ''} — ${v.message}`);
    if (v.excerpt) console.log(`         ${v.excerpt}`);
  }
}

console.log(`\nИтого: ${violations.length} нарушений (${fresh} новых сверх baseline).`);
if (fresh > 0) {
  console.log('Новые нарушения правил адаптивности — исправь перед коммитом (см. CLAUDE.md).');
  console.log('Если нарушение осознанное и согласовано — node scripts/check-responsive.mjs --update-baseline');
  process.exit(1);
}
