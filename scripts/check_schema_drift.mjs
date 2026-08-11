// Сверка схем dev (junibaseone) и prod (system) — смок деплоя.
//
// ЗАЧЕМ. 11.08.2026 выяснилось, что миграции 144 и 161 неделями не доезжали до
// прода. Магазин там отдавал 500 на каждом запросе каталога, а экран рисовал
// «Каталог пуст — добавьте первую позицию» — то есть поломка выглядела как
// пустая витрина, и никто её не замечал. Это класс бага, который нельзя ловить
// глазами: расхождение видно только сравнением схем.
//
// Проверяем СТРУКТУРУ, не данные: таблицы, колонки и CHECK-ограничения. Данные
// у дева и прода отличаются законно (дев — песочница), а схема — не должна.
//
// Использование:
//   node scripts/check_schema_drift.mjs            # отчёт, код 1 при расхождении
//   node scripts/check_schema_drift.mjs --warn     # только предупредить (код 0)

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const WARN_ONLY = process.argv.includes('--warn');
const DEV_DB = process.env.SCHEMA_DRIFT_DEV_DB || 'junibaseone';
const PROD_DB = process.env.YC_SYSTEM_DB || 'system';

const ca = (() => {
  try { return readFileSync(process.env.YC_PG_SSL_CA_PATH || 'certs/yandex-ca.pem').toString(); }
  catch { return null; }
})();

function pool(database) {
  return new Pool({
    host: process.env.YC_PG_HOST, port: Number(process.env.YC_PG_PORT ?? 6432),
    user: process.env.YC_PG_USER, password: process.env.YC_PG_PASSWORD, database,
    ssl: ca ? { ca, rejectUnauthorized: false } : { rejectUnauthorized: false }, max: 2,
  });
}

// Служебное исключаем: бэкапы миграций и таблицы-снимки живут только там, где их
// создали, и расхождением не являются.
const SKIP_TABLE = (t) => /_backup(_|$)|_bak(_|$)|_purge_|^zz_/.test(t);

async function snapshot(db) {
  const p = pool(db);
  try {
    const cols = await p.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY 1, 2`,
    );
    const checks = await p.query(
      `SELECT rel.relname AS table_name, con.conname
         FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND con.contype = 'c'
        ORDER BY 1, 2`,
    );
    const tables = new Set();
    const columns = new Set();
    for (const r of cols.rows) {
      if (SKIP_TABLE(r.table_name)) continue;
      tables.add(r.table_name);
      columns.add(`${r.table_name}.${r.column_name}`);
    }
    const constraints = new Set(
      checks.rows.filter(r => !SKIP_TABLE(r.table_name)).map(r => `${r.table_name}.${r.conname}`),
    );
    return { tables, columns, constraints };
  } finally { await p.end(); }
}

const diff = (a, b) => [...a].filter(x => !b.has(x)).sort();

const [dev, prod] = await Promise.all([snapshot(DEV_DB), snapshot(PROD_DB)]);

const report = [
  ['таблиц нет на ПРОДЕ', diff(dev.tables, prod.tables)],
  ['таблиц нет на ДЕВЕ', diff(prod.tables, dev.tables)],
  ['колонок нет на ПРОДЕ', diff(dev.columns, prod.columns).filter(c => prod.tables.has(c.split('.')[0]))],
  ['колонок нет на ДЕВЕ', diff(prod.columns, dev.columns).filter(c => dev.tables.has(c.split('.')[0]))],
  ['CHECK нет на ПРОДЕ', diff(dev.constraints, prod.constraints).filter(c => prod.tables.has(c.split('.')[0]))],
  ['CHECK нет на ДЕВЕ', diff(prod.constraints, dev.constraints).filter(c => dev.tables.has(c.split('.')[0]))],
];

let problems = 0;
console.log(`Сверка схем: ${DEV_DB} ↔ ${PROD_DB}`);
for (const [title, list] of report) {
  if (list.length === 0) continue;
  problems += list.length;
  console.log(`\n${title} (${list.length}):`);
  for (const x of list.slice(0, 40)) console.log(`  ${x}`);
  if (list.length > 40) console.log(`  … и ещё ${list.length - 40}`);
}

if (problems === 0) {
  console.log('\nСхемы совпадают.');
  process.exit(0);
}
// Колонки, которых нет на ПРОДЕ, — самый опасный случай: выкаченный код их
// селектит и падает целиком, а UI показывает «пусто».
const missingOnProd = report[2][1].length + report[0][1].length;
console.log(`\nРасхождений: ${problems}. Опасных (нет на проде): ${missingOnProd}.`);
console.log(missingOnProd > 0
  ? 'Накатите недостающие миграции на прод ДО деплоя: код уже их ожидает.'
  : 'На проде есть лишнее относительно дева — обычно это нормально (дев-эксперименты), но проверьте.');
process.exit(WARN_ONLY || missingOnProd === 0 ? 0 : 1);
