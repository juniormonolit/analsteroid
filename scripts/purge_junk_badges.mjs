// Разовая чистка мусорных начислений наград (разрешение владельца 05.08:
// «можешь хоть сейчас почистить — нет проблем»).
//
// ЗАЧЕМ: аудит движка нашёл 9 видов начислений, нарушающих правило релевантной
// выборки («лучший из одного», «дисциплина» без броней, «рекорд» против одного
// дня и т.п.). Исправления в движке предотвращают НОВЫЕ такие начисления, но
// пересчёт устроен как INSERT ... ON CONFLICT DO NOTHING — он только добавляет
// и никогда не удаляет, поэтому уже выданный мусор сам не исчезнет.
//
// ЧТО ДЕЛАЕТ: складывает удаляемое в таблицы-бэкапы *_purge_20260805 (откат
// возможен без гаданий), затем удаляет награды затронутых типов и связанные с
// ними строки badge_coin_ledger. Заслуженные вернёт ближайший пересчёт — уже по
// новым правилам.
//
// ПРЕДУСЛОВИЕ: на проде должен стоять код С ИСПРАВЛЕНИЯМИ (иначе пересчёт
// вернёт тот же мусор). Режим «до релиза» разрешает такие операции: живых
// пользователей на этих цифрах пока нет.
//
// Запуск: node scripts/purge_junk_badges.mjs [--apply]
//   без --apply — только показывает, что будет удалено.

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\\\$/g, '$').replace(/^"|"$/g, '');
}

// Типы наград, чьи правила изменил аудит (+ все кастомные топы по префиксу).
const KEYS = [
  'top_sales', 'top_shipments', 'top_repeat_sales', 'planning_discipline',
  'clean_week', 'personal_day_record', 'faster_than_median', 'early_bird',
  'comeback', 'category_keykeeper', 'xp_first_group',
];
const WHERE = `(badge_key = ANY($1) OR badge_key LIKE 'custom_%')`;
const apply = process.argv.includes('--apply');

const db = new Pool({
  host: env.YC_PG_HOST, port: Number(env.YC_PG_PORT), user: env.YC_PG_USER,
  password: env.YC_PG_PASSWORD, database: 'system',
  ssl: { ca: readFileSync(env.YC_PG_SSL_CA_PATH, 'utf8'), rejectUnauthorized: false }, max: 1,
});

const byKey = await db.query(
  `SELECT badge_key, count(*)::int n FROM badge_awards WHERE ${WHERE} GROUP BY 1 ORDER BY 2 DESC`, [KEYS]);
const totals = await db.query(
  `SELECT (SELECT count(*)::int FROM badge_awards WHERE ${WHERE}) awards,
          (SELECT count(*)::int FROM badge_awards) all_awards,
          (SELECT count(*)::int FROM badge_coin_ledger WHERE badge_award_id IN (SELECT id FROM badge_awards WHERE ${WHERE})) led,
          (SELECT COALESCE(sum(amount),0)::int FROM badge_coin_ledger WHERE badge_award_id IN (SELECT id FROM badge_awards WHERE ${WHERE})) mlt`,
  [KEYS]);
const t = totals.rows[0];
console.table(byKey.rows);
console.log(`Наград под чистку: ${t.awards} из ${t.all_awards}; строк леджера ${t.led} на ${t.mlt.toLocaleString('ru-RU')} MLT`);

if (!apply) {
  console.log('\nЭто был сухой прогон. Запуск с --apply выполнит чистку.');
  await db.end();
  process.exit(0);
}

const c = await db.connect();
try {
  await c.query('BEGIN');
  await c.query('CREATE TABLE IF NOT EXISTS badge_awards_purge_20260805 (LIKE badge_awards)');
  await c.query('CREATE TABLE IF NOT EXISTS badge_coin_ledger_purge_20260805 (LIKE badge_coin_ledger)');
  const b1 = await c.query(`INSERT INTO badge_awards_purge_20260805 SELECT * FROM badge_awards WHERE ${WHERE}`, [KEYS]);
  const b2 = await c.query(
    `INSERT INTO badge_coin_ledger_purge_20260805 SELECT * FROM badge_coin_ledger WHERE badge_award_id IN (SELECT id FROM badge_awards WHERE ${WHERE})`, [KEYS]);
  console.log(`бэкап: наград ${b1.rowCount}, строк леджера ${b2.rowCount}`);
  const d1 = await c.query(
    `DELETE FROM badge_coin_ledger WHERE badge_award_id IN (SELECT id FROM badge_awards WHERE ${WHERE})`, [KEYS]);
  const d2 = await c.query(`DELETE FROM badge_awards WHERE ${WHERE}`, [KEYS]);
  await c.query('COMMIT');
  console.log(`УДАЛЕНО: строк леджера ${d1.rowCount}, наград ${d2.rowCount}`);
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ОТКАТ, ничего не изменено:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
}

const left = await db.query('SELECT count(*)::int n FROM badge_awards');
console.log('осталось наград (нетронутые типы):', left.rows[0].n);
await db.end();
