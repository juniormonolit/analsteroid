import { sys, sa } from './db.mjs';

console.log('=== MLT ВАЛЮТА: АУДИТ ПОДОЗРИТЕЛЬНОЙ АКТИВНОСТИ ===\n');

// ГИПОТЕЗА 1: ДРОБЛЕНИЕ СДЕЛОК
console.log('1️⃣  ДРОБЛЕНИЕ СДЕЛОК (низкий средний чек + высокое количество)\n');

const deals_per_mgr = await sa.query(`
  SELECT
    current_manager_id,
    COUNT(*) as deal_count,
    AVG(amount) as avg_check,
    MIN(amount) as min_check,
    MAX(amount) as max_check
  FROM deals
  GROUP BY current_manager_id
  HAVING COUNT(*) > 20
  ORDER BY avg_check ASC
  LIMIT 5
`);

if (deals_per_mgr.rows.length > 0) {
  console.log('Менеджеры с подозрительно низким средним чеком (>20 сделок):');
  deals_per_mgr.rows.forEach(r => {
    const avg = r.avg_check ? Math.round(Number(r.avg_check)) : '?';
    console.log(`  mgr_id ${r.current_manager_id}: ${r.deal_count} сделок, ср.чек ${avg} (${r.min_check}-${r.max_check})`);
  });
} else {
  console.log('✓ Менеджеров с >20 сделками не найдено либо средний чек в норме');
}

// Сделки одного клиента в один день
const same_day_deals = await sa.query(`
  SELECT
    DATE(created_at) as day,
    COUNT(*) as cnt
  FROM deals
  GROUP BY DATE(created_at)
  HAVING COUNT(*) > 50
  ORDER BY cnt DESC
  LIMIT 3
`);

if (same_day_deals.rows.length > 0) {
  console.log('\nАномально много сделок в один день:');
  same_day_deals.rows.forEach(r => {
    console.log(`  ${r.day}: ${r.cnt} сделок`);
  });
} else {
  console.log('\n✓ Дневной объём сделок в норме');
}

// ГИПОТЕЗА 2: НАГРАДЫ БОЛЬШЕ ЧЕМ ПРОДАЖ
console.log('\n2️⃣  НАГРАДЫ / ПРОДАЖИ (топ-10 по отношению MLT к количеству сделок)\n');

// Сначала получаем сделки по менеджерам из analytics
const user_deals = await sa.query(`
  SELECT
    current_manager_id,
    COUNT(*) as deal_count
  FROM deals
  GROUP BY current_manager_id
`);

// Потом получаем MLT из system
const user_mlt = await sys.query(`
  SELECT
    bitrix_id,
    COALESCE(SUM(amount), 0) as total_mlt
  FROM badge_coin_ledger
  GROUP BY bitrix_id
`);

// Присоединяем в памяти
const mlt_map = new Map(user_mlt.rows.map(r => [r.bitrix_id, r.total_mlt]));
const deals_map = new Map(user_deals.rows.map(r => [r.current_manager_id, r.deal_count]));

const mlt_per_deal = [];
for (const [mgr_id, deal_count] of deals_map) {
  const total_mlt = mlt_map.get(mgr_id) || 0;
  const ratio = total_mlt / deal_count;
  mlt_per_deal.push({
    bitrix_id: mgr_id,
    total_mlt,
    deal_count,
    mlt_per_deal: ratio
  });
}
mlt_per_deal.sort((a, b) => b.mlt_per_deal - a.mlt_per_deal);

console.log('Топ-10 по MLT на одну продажу:');
mlt_per_deal.slice(0, 10).forEach((r, i) => {
  const ratio = Number(r.mlt_per_deal).toFixed(1);
  console.log(`  ${i+1}. bitrix_id ${r.bitrix_id}: ${r.total_mlt} MLT / ${r.deal_count} сделок = ${ratio}/сделка`);
});

// ГИПОТЕЗА 3: ЛЁГКИЕ НАГРАДЫ (>20 раз одному человеку)
console.log('\n3️⃣  ЛЁГКИЕ НАГРАДЫ (>20 раз одному = фармибельные)\n');

const repeated_awards = await sys.query(`
  SELECT
    ba.bitrix_id,
    ba.badge_key,
    ba.tier,
    COUNT(*) as times_awarded
  FROM badge_awards ba
  GROUP BY ba.bitrix_id, ba.badge_key, ba.tier
  HAVING COUNT(*) > 20
  ORDER BY COUNT(*) DESC
  LIMIT 5
`);

if (repeated_awards.rows.length > 0) {
  console.log('Повторяемые награды (>20 раз одному человеку):');
  repeated_awards.rows.forEach(r => {
    console.log(`  bitrix_id ${r.bitrix_id}, "${r.badge_key}" (tier ${r.tier}): ${r.times_awarded} раз`);
  });
} else {
  console.log('✓ Никто не получал одну и ту же награду >20 раз');
}

// ГИПОТЕЗА 4: МЁРТВЫЕ ДУШИ (валюта есть, продаж нет)
console.log('\n4️⃣  МЁРТВЫЕ ДУШИ (MLT есть, но сделок НЕТУ)\n');

// Получаем все bitrix_id с MLT
const ledger_users = await sys.query(`SELECT DISTINCT bitrix_id FROM badge_coin_ledger`);

// Получаем все menеджеры с продажами
const deal_users = await sa.query(`SELECT DISTINCT current_manager_id FROM deals`);

const deal_users_set = new Set(deal_users.rows.map(r => r.current_manager_id));

// Находим тех, у кого MLT есть, но продаж нет
const ghosts = [];
for (const row of ledger_users.rows) {
  if (!deal_users_set.has(row.bitrix_id)) {
    ghosts.push(row.bitrix_id);
  }
}

// Получаем их статистику
if (ghosts.length > 0) {
  const ghost_stats = await sys.query(`
    SELECT
      bitrix_id,
      COALESCE(SUM(amount), 0) as total_mlt,
      COUNT(*) as transaction_count
    FROM badge_coin_ledger
    WHERE bitrix_id = ANY($1)
    GROUP BY bitrix_id
    ORDER BY total_mlt DESC
    LIMIT 10
  `, [ghosts]);

  console.log('Пользователи с MLT, но БЕЗ продаж:');
  ghost_stats.rows.forEach((r, i) => {
    console.log(`  ${i+1}. bitrix_id ${r.bitrix_id}: ${r.total_mlt} MLT (${r.transaction_count} транзакций)`);
  });
} else {
  console.log('✓ Все получатели MLT имеют хотя бы одну продажу');
}

console.log('\n=== КОНЕЦ АУДИТА ===\n');

await sys.end();
await sa.end();
