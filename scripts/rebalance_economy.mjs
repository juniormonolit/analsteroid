// Ребаланс экономики MLT (решение владельца 06.08: курс 5 ₽ фиксирован, айфон
// 29 000 MLT, эмиссия ≤ 200 000 ₽/мес = 40 000 MLT/мес, и хотя бы один человек
// должен накопить на айфон за год).
//
// ЗАДАЧА, КОТОРУЮ РЕШАЕМ. Сегодня эмиссия 97 670 MLT/мес (488 тыс ₽) и она
// РАЗМАЗАНА: ни одна награда не даёт больше 7%, лучший получает лишь вдвое
// больше среднего. Простое «подрезать всё» уводит в бюджет, но окончательно
// хоронит накопление на айфон. Поэтому делаем ДВА действия сразу:
//   1) МАСШТАБ: все цены наград × SCALE — убирает перерасход, сохраняя
//      относительный баланс между наградами (никого не «обнуляем» вручную);
//   2) КОНЦЕНТРАЦИЯ: топы продаж/отгрузок/повторных начисляются только за
//      МЕСЯЦ и ГОД (не за день/неделю), а платина (лучший в стране) стоит
//      дорого — победа становится событием, а не ежедневной капелью.
// Итог: середина получает меньше, вершина — заметно больше, сумма влезает в бюджет.
//
// Запуск: node scripts/rebalance_economy.mjs [--apply]
//   без --apply — только показывает расчёт.

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\\\$/g, '$').replace(/^"|"$/g, '');
}

const SCALE = 0.30;                    // множитель ко всем текущим ценам
const TOP_KEYS = ['top_sales', 'top_shipments', 'top_repeat_sales'];
const TOP_PERIODS = ['month', 'year']; // день и неделю больше не награждаем
// Цены топов после ребаланса: платина = лучший в стране за месяц.
// Бронза (лучший в СВОЁМ отделе) обнулена намеренно: 29 отделов × 3 топа
// каждый месяц — это и есть главная массовая капель. Победа начинается с
// уровня департамента.
// Точный расчёт по факту выдач (в месяц: 52 бронзы, 8 серебра, 10 золота,
// 5 платины на все три топа). Бронза обнулена — «лучший в своём отделе» каждый
// месяц и есть главная массовая капель. Платина дорогая: это и есть механизм,
// которым чемпион копит на айфон.
const TOP_PRICES = { bronze: 0, silver: 100, gold: 250, platinum: 2600 };
const COVERAGE_MONTHS = 4.1;
const RATE = 5;
const apply = process.argv.includes('--apply');

const db = new Pool({
  host: env.YC_PG_HOST, port: Number(env.YC_PG_PORT), user: env.YC_PG_USER,
  password: env.YC_PG_PASSWORD, database: 'system',
  ssl: { ca: readFileSync(env.YC_PG_SSL_CA_PATH, 'utf8'), rejectUnauthorized: false }, max: 1,
});

// Факт: сколько печатает каждая награда сейчас (MLT/мес) и сколько наград выдано.
const stats = (await db.query(`
  SELECT a.badge_key k, a.tier, count(*)::int n, sum(l.amount)::int mlt
    FROM badge_coin_ledger l JOIN badge_awards a ON a.id = l.badge_award_id
   WHERE l.amount > 0 GROUP BY 1, 2`)).rows;
const prices = (await db.query('SELECT badge_key, tier, price FROM badge_prices')).rows;
const priceOf = new Map(prices.map(r => [`${r.badge_key}:${r.tier ?? '-'}`, Number(r.price)]));

const monthNow = stats.reduce((s, r) => s + r.mlt, 0) / COVERAGE_MONTHS;
console.log(`СЕЙЧАС: ${Math.round(monthNow).toLocaleString('ru-RU')} MLT/мес = ${Math.round(monthNow * RATE).toLocaleString('ru-RU')} ₽/мес`);

// Прогноз ПОСЛЕ: обычные награды × SCALE; топы — только месяц/год по новым ценам.
let after = 0;
const perKeyAfter = new Map();
for (const r of stats) {
  const isTop = TOP_KEYS.includes(r.k);
  let mlt;
  if (isTop) {
    // Награды за день/неделю исчезают. Доля месячных/годовых в общем числе
    // выдач топов оценивается по факту: считаем их отдельно ниже.
    mlt = 0;
  } else {
    mlt = r.mlt * SCALE;
  }
  after += mlt;
  perKeyAfter.set(r.k, (perKeyAfter.get(r.k) ?? 0) + mlt);
}
// Топы после ребаланса: сколько месячных/годовых наград реально выдавалось.
const topPeriodic = (await db.query(`
  SELECT badge_key k, tier, count(*)::int n
    FROM badge_awards WHERE badge_key = ANY($1) AND period_type = ANY($2)
   GROUP BY 1, 2`, [TOP_KEYS, TOP_PERIODS])).rows;
let topAfter = 0;
for (const r of topPeriodic) {
  const price = TOP_PRICES[r.tier ?? 'bronze'] ?? 0;
  topAfter += r.n * price;
}
after += topAfter;
const afterMonth = after / COVERAGE_MONTHS;
console.log(`ПОСЛЕ:   ${Math.round(afterMonth).toLocaleString('ru-RU')} MLT/мес = ${Math.round(afterMonth * RATE).toLocaleString('ru-RU')} ₽/мес (цель ≤ 40 000 / 200 000 ₽)`);
console.log(`  обычные награды ×${SCALE}: ${Math.round((after - topAfter) / COVERAGE_MONTHS).toLocaleString('ru-RU')} MLT/мес`);
console.log(`  топы (только месяц/год): ${Math.round(topAfter / COVERAGE_MONTHS).toLocaleString('ru-RU')} MLT/мес\n`);

// Что получит лучший: его обычные награды × SCALE + платина за месяц.
const best = (await db.query(`
  SELECT a.bitrix_id, sum(l.amount)::int mlt
    FROM badge_coin_ledger l JOIN badge_awards a ON a.id = l.badge_award_id
   WHERE l.amount > 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)).rows[0];
const bestOrdinaryYear = (best.mlt / COVERAGE_MONTHS) * SCALE * 12;
console.log('ЛУЧШИЙ МЕНЕДЖЕР ЗА ГОД:');
console.log(`  обычные награды: ${Math.round(bestOrdinaryYear).toLocaleString('ru-RU')} MLT`);
for (const wins of [6, 9, 12]) {
  const total = bestOrdinaryYear + wins * TOP_PRICES.platinum;
  console.log(`  + платина ${wins} мес × ${TOP_PRICES.platinum} = ${Math.round(total).toLocaleString('ru-RU')} MLT ${total >= 29000 ? '✅ айфон берётся' : '❌ не хватает'}`);
}

if (!apply) { console.log('\nСухой прогон. С --apply применю.'); await db.end(); process.exit(0); }

const c = await db.connect();
try {
  await c.query('BEGIN');
  await c.query('CREATE TABLE IF NOT EXISTS badge_prices_backup_20260806 (LIKE badge_prices)');
  await c.query('TRUNCATE badge_prices_backup_20260806');
  await c.query('INSERT INTO badge_prices_backup_20260806 SELECT * FROM badge_prices');
  // 1) Масштаб обычных наград
  await c.query(
    `UPDATE badge_prices SET price = GREATEST(1, round(price * $1::numeric))::int WHERE badge_key <> ALL($2)`,
    [SCALE, TOP_KEYS]);
  // 2) Топы: новые цены + только месяц/год
  for (const [tier, price] of Object.entries(TOP_PRICES)) {
    await c.query(
      `UPDATE badge_prices SET price = $1 WHERE badge_key = ANY($2) AND tier = $3`,
      [price, TOP_KEYS, tier]);
  }
  await c.query(
    `UPDATE badge_definitions
        SET criteria = COALESCE(criteria, '{}'::jsonb) || jsonb_build_object('periodTypes', $2::jsonb)
      WHERE key = ANY($1)`,
    [TOP_KEYS, JSON.stringify(TOP_PERIODS)]);
  await c.query('COMMIT');
  console.log('\nПРИМЕНЕНО. Бэкап цен — badge_prices_backup_20260806.');
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ОТКАТ:', e.message);
  process.exitCode = 1;
} finally { c.release(); }
await db.end();
