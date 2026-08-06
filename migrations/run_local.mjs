// Прогон миграции С МАШИНЫ РАЗРАБОТЧИКА (не с сервера).
//
// Зачем отдельный раннер: run_system.mjs / run_analytics.mjs — СЕРВЕРНЫЕ, в них
// зашиты пути `/home/junior/analsteroid/.next/standalone/node_modules/pg` и
// `/home/junior/anal_v2/.pg_password`. На ноутбуке они падают с
// MODULE_NOT_FOUND, и по стектрейсу это выглядит как «сломался pg», хотя
// сломано только место запуска (наступили 06.08.2026).
//
// Здесь всё берётся из локального окружения: пакет pg из node_modules,
// хост/пользователь/пароль — из .env.local через @next/env, то есть ровно те
// же креды, с которыми ходит `npm run dev`.
//
// Использование:
//   node migrations/run_local.mjs migrations/156_report_templates.sql          # system
//   node migrations/run_local.mjs migrations/xxx.sql --db=analytics            # analytics
//
// ВНИМАНИЕ: .env.local на машине владельца смотрит на ПРОД (YC_SYSTEM_DB=system).
// Скрипт печатает базу и пользователя ДО выполнения — прочитай эту строку.

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import nextEnv from '@next/env';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

nextEnv.loadEnvConfig(join(__dirname, '..'));

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Использование: node migrations/run_local.mjs <файл.sql> [--db=system|analytics]');
  process.exit(1);
}
const dbArg = process.argv.find(a => a.startsWith('--db='))?.slice(5) ?? 'system';
const database = dbArg === 'analytics'
  ? (process.env.YC_ANALYTICS_DB ?? 'analytics')
  : (process.env.YC_SYSTEM_DB ?? 'system');

const caPath = process.env.YC_PG_SSL_CA_PATH ?? join(__dirname, '../certs/yandex-ca.pem');

const pool = new Pool({
  host: process.env.YC_PG_HOST,
  port: Number(process.env.YC_PG_PORT ?? 6432),
  user: process.env.YC_PG_USER,
  password: process.env.YC_PG_PASSWORD,
  database,
  ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

const sql = readFileSync(sqlFile, 'utf8');

try {
  const who = await pool.query('SELECT current_database() AS db, current_user AS usr');
  console.log(`Цель: база "${who.rows[0].db}", пользователь "${who.rows[0].usr}", хост ${process.env.YC_PG_HOST}`);
  await pool.query(sql);
  console.log('OK:', sqlFile);
} catch (e) {
  console.error('Ошибка:', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
