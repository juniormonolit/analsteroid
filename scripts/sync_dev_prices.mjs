// Синхронизация цен наград dev-БД (junibaseone) с боевыми (system) — задача 64.
//
// ЗАЧЕМ. Оба ребаланса (`rebalance_economy.mjs`, `rebalance_v2.mjs`) подключались
// к `database: 'system'` жёстко, поэтому дев остался на ДОребалансных ценах:
// 58 из 107 позиций разошлись. Симуляция экономики на деве из-за этого врёт —
// ровно та ловушка, на которой уже обожглись 06.08.2026 (WORKLOG).
//
// ЧТО СЧИТАЕМ ПРАВИЛЬНЫМ СОСТОЯНИЕМ ДЕВА. Не «копию прода», а
// **прод + отложенные дев-эксперименты**. Сейчас такой эксперимент один —
// миграция 160 (срез цен кросс-селла вдвое, на прод не накатана). Поэтому
// порядок: скопировать прод, затем ЗАНОВО применить правило 160 поверх.
//
// ПОЧЕМУ ЗАНОВО, А НЕ «ОСТАВИТЬ КАК ЕСТЬ». Миграция 160 отработала на деве по
// ДОребалансным ценам и дала не те числа, которые получились бы на проде:
// crosssell_plity_teplo на деве 25, а прод после 160 стал бы 40 (79 ÷ 2).
// То есть дев показывал не «прод после среза», а третье, ни на что не похожее
// состояние. Пересчёт от прод-цен это чинит.
//
// БЕЗОПАСНОСТЬ. Пишем ТОЛЬКО в junibaseone; прод открывается на чтение и
// никогда не участвует в UPDATE. Перед записью — бэкап в
// badge_prices_backup_sync_<дата> и skill_branch_steps_backup_sync_<дата>.
//
// Запуск:  node scripts/sync_dev_prices.mjs           — сухой прогон (по умолчанию)
//          node scripts/sync_dev_prices.mjs --apply   — записать

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\\\$/g, '$').replace(/^"|"$/g, '');
}
const ca = fs.readFileSync(path.join(ROOT, 'certs/yandex-ca.pem')).toString();
const pool = (database) => new pg.Pool({
  host: env.YC_PG_HOST, port: Number(env.YC_PG_PORT ?? 6432),
  user: env.YC_PG_USER, password: env.YC_PG_PASSWORD,
  database, ssl: { ca, rejectUnauthorized: false }, max: 2,
});

const DEV_DB = 'junibaseone';
const PROD_DB = 'system';
// Правило миграции 160: эти ключи на деве живут вдвое дешевле прода.
const isCut = (badgeKey) => badgeKey.startsWith('crosssell') || badgeKey === 'combo_master';
const half = (v) => Math.max(1, Math.round(v * 0.5));

const dev = pool(DEV_DB);
const prod = pool(PROD_DB);

try {
  // ── что должно стать ──────────────────────────────────────────────────────
  const prodPrices = (await prod.query(
    `SELECT badge_key, tier, price FROM badge_prices`,
  )).rows;
  const devPrices = new Map((await dev.query(
    `SELECT badge_key, tier, price FROM badge_prices`,
  )).rows.map(r => [`${r.badge_key}:${r.tier ?? '-'}`, Number(r.price)]));

  const planPrices = [];
  for (const r of prodPrices) {
    const k = `${r.badge_key}:${r.tier ?? '-'}`;
    const want = isCut(r.badge_key) ? half(Number(r.price)) : Number(r.price);
    const have = devPrices.get(k);
    if (have === undefined) { planPrices.push({ k, ...r, have: null, want, why: 'нет на деве' }); continue; }
    if (have !== want) planPrices.push({ k, ...r, have, want, why: isCut(r.badge_key) ? 'прод ÷2 (миграция 160)' : 'прод' });
  }
  const onlyDev = [...devPrices.keys()].filter(k => !prodPrices.some(r => `${r.badge_key}:${r.tier ?? '-'}` === k));

  const prodSteps = (await prod.query(`SELECT branch_key, step, price FROM skill_branch_steps`)).rows;
  const devSteps = new Map((await dev.query(
    `SELECT branch_key, step, price FROM skill_branch_steps`,
  )).rows.map(r => [`${r.branch_key}:${r.step}`, Number(r.price)]));
  const planSteps = [];
  for (const r of prodSteps) {
    const k = `${r.branch_key}:${r.step}`;
    const want = r.branch_key === 'crosssell' ? half(Number(r.price)) : Number(r.price);
    const have = devSteps.get(k);
    if (have !== undefined && have !== want) planSteps.push({ k, ...r, have, want });
  }

  // ── отчёт ─────────────────────────────────────────────────────────────────
  console.log(`Цены наград: на деве ${devPrices.size}, на проде ${prodPrices.length}.`);
  console.log(`К изменению ${planPrices.length}, только на деве (не трогаем) ${onlyDev.length}.\n`);
  for (const p of planPrices) {
    console.log(`  ${p.k.padEnd(38)} ${String(p.have ?? '—').padStart(6)} → ${String(p.want).padStart(6)}   ${p.why}`);
  }
  console.log(`\nСтупени веток скиллов: к изменению ${planSteps.length}.`);
  for (const p of planSteps) {
    console.log(`  ${p.k.padEnd(38)} ${String(p.have).padStart(6)} → ${String(p.want).padStart(6)}`);
  }

  if (!APPLY) {
    console.log('\nСухой прогон. Записать: node scripts/sync_dev_prices.mjs --apply');
    process.exit(0);
  }

  // ── запись (только dev) ───────────────────────────────────────────────────
  const stamp = (await dev.query(`SELECT to_char(now(), 'YYYYMMDD') AS d`)).rows[0].d;
  const client = await dev.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TABLE IF NOT EXISTS badge_prices_backup_sync_${stamp} AS SELECT * FROM badge_prices`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS skill_branch_steps_backup_sync_${stamp} AS SELECT * FROM skill_branch_steps`,
    );
    for (const p of planPrices) {
      if (p.have === null) {
        await client.query(
          `INSERT INTO badge_prices (badge_key, tier, price) VALUES ($1,$2,$3)`,
          [p.badge_key, p.tier, p.want],
        );
      } else {
        await client.query(
          `UPDATE badge_prices SET price=$3, updated_at=now()
            WHERE badge_key=$1 AND tier IS NOT DISTINCT FROM $2`,
          [p.badge_key, p.tier, p.want],
        );
      }
    }
    for (const p of planSteps) {
      await client.query(
        `UPDATE skill_branch_steps SET price=$3 WHERE branch_key=$1 AND step=$2`,
        [p.branch_key, p.step, p.want],
      );
    }
    await client.query('COMMIT');
    console.log(`\nЗаписано. Бэкапы: badge_prices_backup_sync_${stamp}, skill_branch_steps_backup_sync_${stamp}.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // ── проверка после записи ─────────────────────────────────────────────────
  const after = new Map((await dev.query(
    `SELECT badge_key, tier, price FROM badge_prices`,
  )).rows.map(r => [`${r.badge_key}:${r.tier ?? '-'}`, Number(r.price)]));
  let bad = 0;
  for (const r of prodPrices) {
    const k = `${r.badge_key}:${r.tier ?? '-'}`;
    const want = isCut(r.badge_key) ? half(Number(r.price)) : Number(r.price);
    if (after.get(k) !== want) { bad++; console.log(`  РАСХОЖДЕНИЕ ${k}: ${after.get(k)} вместо ${want}`); }
  }
  console.log(bad === 0
    ? 'Проверка: дев = прод (кросс-селл и «Мастер комбо» — вдвое дешевле, как задумано миграцией 160).'
    : `Проверка: осталось ${bad} расхождений.`);
} finally {
  await dev.end();
  await prod.end();
}
