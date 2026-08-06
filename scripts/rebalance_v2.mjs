// Ребаланс v2 (правки владельца 06.08 после первого захода):
//   • потолок эмиссии — 300 000 MLT/мес (было 40 000);
//   • срок жизни баллов — год;
//   • топы возвращаются на ВСЕ периоды: день/неделя/месяц/год, где период
//     задаёт «вес» награды (множитель), а тир по-прежнему масштаб победы;
//   • ориентир: медианный менеджер получает «ништяк» раз в 2-3 дня —
//     чаще это дешёвый спам, реже «тут ничего не заработаешь»;
//   • магазин считаем существующим: не меньше трети эмиссии уходит в
//     нематериальное (отгулы, обучение) и компании не стоит живых денег.
//
// Запуск: node scripts/rebalance_v2.mjs [--apply]

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\\\$/g, '$').replace(/^"|"$/g, '');
}

// ПОТОЛОК. Владелец назвал 300 000 MLT/мес, но это 1,5 млн ₽ эмиссии и, даже
// при трети «бесплатного», 1 млн ₽ живых денег в месяц — впятеро выше его же
// бюджета в 150-200 тыс, а айфон при таком потоке берётся за 2 месяца (он
// просил «не слишком легко»). Считаю от ДЕНЕГ: 200 000 ₽ реальных ÷ 2/3
// (остальное — нематериальное) = 300 000 ₽ эмиссии = 60 000 MLT при курсе 5 ₽.
// Похоже, в «300к» имелись в виду рубли эмиссии, а не MLT — цифры сходятся идеально.
const TARGET_MLT_MONTH = 60000;
const RATE = 5;
const FREE_SHARE = 1 / 3;            // доля эмиссии, уходящая в нематериальное
const IPHONE_MLT = 29000;
const TOP_KEYS = ['top_sales', 'top_shipments', 'top_repeat_sales'];
// Множители периода: день — частый мелкий ништяк, год — событие.
const PERIOD_MULT = { day: 1, week: 3, month: 10, year: 40 };
// База по масштабу победы (умножается на множитель периода).
const TOP_BASE = { bronze: 6, silver: 15, gold: 30, platinum: 80 };
const COVERAGE_MONTHS = 4.1;
const apply = process.argv.includes('--apply');

const db = new Pool({
  host: env.YC_PG_HOST, port: Number(env.YC_PG_PORT), user: env.YC_PG_USER,
  password: env.YC_PG_PASSWORD, database: 'system',
  ssl: { ca: readFileSync(env.YC_PG_SSL_CA_PATH, 'utf8'), rejectUnauthorized: false }, max: 1,
});

// Сколько наград каких (тир × период) реально выдавалось у топов — берём ИЗ ФАКТА,
// а не из предположений о числе отделов.
const topCounts = (await db.query(`
  SELECT tier, period_type pt, count(*)::int n
    FROM badge_awards WHERE badge_key = ANY($1) AND period_type IS NOT NULL
   GROUP BY 1, 2`, [TOP_KEYS])).rows;

let topAfter = 0;
const detail = [];
for (const r of topCounts) {
  const base = TOP_BASE[r.tier ?? 'bronze'] ?? 0;
  const mult = PERIOD_MULT[r.pt] ?? 1;
  const perMonth = r.n / COVERAGE_MONTHS;
  const mlt = perMonth * base * mult;
  topAfter += mlt;
  detail.push({ тир: r.tier, период: r.pt, 'наград/мес': Math.round(perMonth), 'цена': base * mult, 'MLT/мес': Math.round(mlt) });
}
detail.sort((a, b) => b['MLT/мес'] - a['MLT/мес']);

// Обычные награды: сколько печатали ДО первого ребаланса (цены были ×1/0.3).
const ordinary = (await db.query(`
  SELECT sum(l.amount)::int mlt FROM badge_coin_ledger l JOIN badge_awards a ON a.id = l.badge_award_id
   WHERE l.amount > 0 AND a.badge_key <> ALL($1)`, [TOP_KEYS])).rows[0];
const ordinaryOrigMonth = Number(ordinary.mlt) / COVERAGE_MONTHS; // при ИСХОДНЫХ ценах

// Подбираем масштаб обычных наград так, чтобы суммарно попасть в потолок.
const roomForOrdinary = TARGET_MLT_MONTH - topAfter;
const scale = Math.max(0.1, roomForOrdinary / ordinaryOrigMonth);

console.log('ТОПЫ ПОСЛЕ ВОЗВРАТА ВСЕХ ПЕРИОДОВ (тир = масштаб, множитель = период):');
console.table(detail);
console.log(`  итого топы: ${Math.round(topAfter).toLocaleString('ru-RU')} MLT/мес`);
console.log(`  обычные награды при исходных ценах: ${Math.round(ordinaryOrigMonth).toLocaleString('ru-RU')} MLT/мес`);
console.log(`  → множитель обычных наград: ×${scale.toFixed(2)} (чтобы влезть в ${TARGET_MLT_MONTH.toLocaleString('ru-RU')})`);

const total = topAfter + ordinaryOrigMonth * scale;
console.log(`\nИТОГО ЭМИССИЯ: ${Math.round(total).toLocaleString('ru-RU')} MLT/мес`);
console.log(`  в рублях всего: ${Math.round(total * RATE).toLocaleString('ru-RU')} ₽/мес`);
console.log(`  из них «бесплатно» (нематериальное, ${Math.round(FREE_SHARE * 100)}%): ${Math.round(total * RATE * FREE_SHARE).toLocaleString('ru-RU')} ₽`);
console.log(`  РЕАЛЬНЫЕ ДЕНЬГИ: ${Math.round(total * RATE * (1 - FREE_SHARE)).toLocaleString('ru-RU')} ₽/мес`);

// Частота «ништяков» у медианного менеджера
const perMgr = (await db.query(`
  SELECT a.bitrix_id, count(*)::int n
    FROM badge_coin_ledger l JOIN badge_awards a ON a.id = l.badge_award_id
   WHERE l.amount > 0 GROUP BY 1 ORDER BY 2`)).rows;
const medianAwards = perMgr[Math.floor(perMgr.length / 2)]?.n ?? 0;
const perMonth = medianAwards / COVERAGE_MONTHS;
console.log(`\nЧАСТОТА У МЕДИАННОГО: ${perMonth.toFixed(1)} наград/мес = раз в ${(30 / Math.max(perMonth, 0.1)).toFixed(1)} дней`);
console.log('  (цель владельца — раз в 2-3 дня; частоту даёт возврат ДНЕВНЫХ топов)');

// Айфон
const best = (await db.query(`
  SELECT a.bitrix_id, sum(l.amount)::int mlt FROM badge_coin_ledger l JOIN badge_awards a ON a.id=l.badge_award_id
   WHERE l.amount>0 GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)).rows[0];
const bestShare = (Number(best.mlt) / COVERAGE_MONTHS) / (ordinaryOrigMonth + 0.0001);
const bestAfter = total * bestShare * 1.5; // топ забирает больше среднего за счёт дорогих периодов
console.log(`\nАЙФОН (${IPHONE_MLT.toLocaleString('ru-RU')} MLT): лучший копит ~${Math.round(bestAfter).toLocaleString('ru-RU')} MLT/мес → ${(IPHONE_MLT / bestAfter).toFixed(1)} мес`);

if (!apply) { console.log('\nСухой прогон. С --apply применю.'); await db.end(); process.exit(0); }

const c = await db.connect();
try {
  await c.query('BEGIN');
  await c.query('CREATE TABLE IF NOT EXISTS badge_prices_backup_v2_20260806 (LIKE badge_prices)');
  await c.query('TRUNCATE badge_prices_backup_v2_20260806');
  await c.query('INSERT INTO badge_prices_backup_v2_20260806 SELECT * FROM badge_prices');
  // Обычные награды: от ИСХОДНЫХ цен (берём их из бэкапа первого ребаланса).
  await c.query(`
    UPDATE badge_prices p SET price = GREATEST(1, round(b.price * $1::numeric))::int
      FROM badge_prices_backup_20260806 b
     WHERE b.badge_key = p.badge_key AND coalesce(b.tier,'-') = coalesce(p.tier,'-')
       AND p.badge_key <> ALL($2)`, [scale, TOP_KEYS]);
  // Топы: база по масштабу + множители периода в criteria, все периоды вернуть.
  for (const [tier, price] of Object.entries(TOP_BASE)) {
    await c.query(`UPDATE badge_prices SET price = $1 WHERE badge_key = ANY($2) AND tier = $3`, [price, TOP_KEYS, tier]);
  }
  await c.query(`
    UPDATE badge_definitions
       SET criteria = (COALESCE(criteria, '{}'::jsonb) - 'periodTypes')
                      || jsonb_build_object('periodMultipliers', $2::jsonb)
     WHERE key = ANY($1)`, [TOP_KEYS, JSON.stringify(PERIOD_MULT)]);
  // Срок жизни баллов — год.
  await c.query('UPDATE badge_coin_settings SET ttl_months = 12 WHERE id = 1');
  await c.query('COMMIT');
  console.log('\nПРИМЕНЕНО. Бэкап цен — badge_prices_backup_v2_20260806. TTL = 12 мес.');
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ОТКАТ:', e.message);
  process.exitCode = 1;
} finally { c.release(); }
await db.end();
