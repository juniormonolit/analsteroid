const pg = require('pg');
const fs = require('fs');
const path = require('path');

// Parse .env.local manually
const envPath = path.join(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = { ...process.env };

envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex);
      const value = trimmed.substring(eqIndex + 1);
      // Handle escaped $ characters
      env[key] = value.replace(/\\\$/g, '$');
    }
  }
});

const caPath = path.join(__dirname, '../certs/yandex-ca.pem');
const ca = fs.readFileSync(caPath).toString();

const pool = new pg.Pool({
  host: env.YC_PG_HOST,
  port: Number(env.YC_PG_PORT),
  user: env.YC_PG_USER,
  password: env.YC_PG_PASSWORD,
  database: env.YC_SYSTEM_DB,
  ssl: { rejectUnauthorized: false, ca },
  connectionTimeoutMillis: 10000,
});

async function analyze() {
  console.log('=== MLT Economy Analysis ===\n');

  try {
    // 1. MLT issued through quests (e-balls are the reward currency)
    const questsRes = await pool.query(`
      SELECT
        COUNT(*) as total_completions,
        COUNT(DISTINCT bitrix_id) as unique_users,
        SUM(COALESCE(reward_eballs, 0))::BIGINT as total_eballs,
        ROUND(AVG(COALESCE(reward_eballs, 0))::NUMERIC, 2) as avg_eballs_per_completion
      FROM quests
      WHERE done_at IS NOT NULL AND status = 'done'
    `);

    const questStats = questsRes.rows[0];
    console.log('1. QUESTS MLT EMISSION (via e-balls):');
    console.log(`   Total completions: ${questStats.total_completions}`);
    console.log(`   Unique users: ${questStats.unique_users}`);
    console.log(`   Total e-balls issued: ${questStats.total_eballs}`);
    console.log(`   Avg per completion: ${questStats.avg_eballs_per_completion}`);

    // Monthly average
    const monthlyRes = await pool.query(`
      SELECT
        DATE_TRUNC('month', done_at)::DATE as month,
        SUM(COALESCE(reward_eballs, 0))::BIGINT as eballs_issued,
        COUNT(*) as completions
      FROM quests
      WHERE done_at IS NOT NULL AND status = 'done'
      GROUP BY DATE_TRUNC('month', done_at)
      ORDER BY month DESC
      LIMIT 12
    `);

    let monthlyTotal = 0;
    let monthCount = 0;
    monthlyRes.rows.forEach(row => {
      monthlyTotal += parseInt(row.eballs_issued);
      monthCount++;
    });
    const monthlyAvg = monthCount > 0 ? Math.round(monthlyTotal / monthCount) : 0;
    console.log(`   Monthly average: ${monthlyAvg} e-balls`);

    // Total emission to compare (check badge_coin_ledger)
    const totalEmissionRes = await pool.query(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::BIGINT as total_issued
      FROM badge_coin_ledger
    `);

    const totalEmission = totalEmissionRes.rows[0]?.total_issued || 0;
    const questShare = totalEmission > 0 ? ((questStats.total_eballs / totalEmission) * 100).toFixed(1) : 0;
    console.log(`   Quest share of badge_coin_ledger: ${questShare}%`);
    console.log();

    // 2. Top and bottom quests
    const topQuestsRes = await pool.query(`
      SELECT
        slot,
        category,
        COUNT(*) as completions,
        ROUND(AVG(COALESCE(reward_eballs, 0))::NUMERIC, 0) as avg_reward
      FROM quests
      WHERE done_at IS NOT NULL AND status = 'done'
      GROUP BY slot, category
      ORDER BY completions DESC
      LIMIT 5
    `);

    console.log('2. TOP 5 QUESTS (by completions):');
    topQuestsRes.rows.forEach((row, i) => {
      console.log(`   ${i+1}. ${row.category}/${row.slot}: ${row.completions} done, avg ${row.avg_reward} e-balls`);
    });
    console.log();

    const bottomQuestsRes = await pool.query(`
      SELECT
        slot,
        category,
        COUNT(*) as completions,
        ROUND(AVG(COALESCE(reward_eballs, 0))::NUMERIC, 0) as avg_reward
      FROM quests
      WHERE done_at IS NOT NULL AND status = 'done'
      GROUP BY slot, category
      ORDER BY completions ASC
      LIMIT 5
    `);

    console.log('3. BOTTOM 5 QUESTS (least completed):');
    bottomQuestsRes.rows.forEach((row, i) => {
      console.log(`   ${i+1}. ${row.category}/${row.slot}: ${row.completions} done, avg ${row.avg_reward} e-balls`);
    });
    console.log();

    // 3. Daily repeaters (too easy quests) - users completing same quest 25+ times in 24+ days
    const dailyRepeaterRes = await pool.query(`
      SELECT
        slot,
        bitrix_id,
        COUNT(*) as completions_this_user,
        MAX(DATE(done_at)) as last_completion,
        MIN(DATE(done_at)) as first_completion,
        (MAX(DATE(done_at)) - MIN(DATE(done_at))) as days_span,
        ROUND(AVG(COALESCE(reward_eballs, 0))::NUMERIC, 0) as avg_reward
      FROM quests
      WHERE done_at IS NOT NULL AND status = 'done'
      GROUP BY slot, bitrix_id
      HAVING COUNT(*) >= 25
      AND (MAX(DATE(done_at)) - MIN(DATE(done_at))) >= 24
      ORDER BY completions_this_user DESC
      LIMIT 10
    `);

    if (dailyRepeaterRes.rows.length > 0) {
      console.log('4. SUSPICIOUS DAILY REPEATERS:');
      console.log(`   Found ${dailyRepeaterRes.rows.length} user-quest pairs with 25+ completions over 24+ days`);
      const example = dailyRepeaterRes.rows[0];
      console.log(`   Example: User ${example.bitrix_id}, Quest ${example.slot} - ${example.completions_this_user} times, avg ${example.avg_reward} e-balls`);
    } else {
      console.log('4. SUSPICIOUS DAILY REPEATERS: None found (good sign)');
    }
    console.log();

    // 4. Gacha (Wheel of Fortune) analysis - check gacha_spins and badge_coin_ledger
    const gachaSpinsRes = await pool.query(`
      SELECT
        COUNT(*) as total_spins,
        COUNT(DISTINCT bitrix_id) as unique_spinners,
        SUM(eball_amount)::BIGINT as total_prizes_from_spins
      FROM gacha_spins
    `);

    const gachaSpins = gachaSpinsRes.rows[0];

    // Check all gacha-related ledger entries
    const gachaLedgerRes = await pool.query(`
      SELECT
        COUNT(*) as ledger_rows,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::BIGINT as total_won,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)::BIGINT as total_spent
      FROM badge_coin_ledger
      WHERE source ILIKE '%gacha%' OR source ILIKE '%wheel%' OR source ILIKE '%fortune%'
    `);

    const gachaLedger = gachaLedgerRes.rows[0];

    const expectedValue = gachaSpins.total_spins > 0
      ? (gachaSpins.total_prizes_from_spins / gachaSpins.total_spins).toFixed(2)
      : 0;

    // Get gacha spend price from ledger
    const gachaSpendBySourceRes = await pool.query(`
      SELECT
        source,
        COUNT(*) as count,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)::BIGINT as total_spent_value,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::BIGINT as total_won_value
      FROM badge_coin_ledger
      WHERE source ILIKE '%gacha%' OR source ILIKE '%wheel%' OR source ILIKE '%fortune%'
      GROUP BY source
      ORDER BY count DESC
    `);

    console.log('5. GACHA/WHEEL OF FORTUNE:');
    console.log(`   Total spins: ${gachaSpins.total_spins}`);
    console.log(`   Unique spinners: ${gachaSpins.unique_spinners}`);
    console.log(`   Total prizes distributed: ${gachaSpins.total_prizes_from_spins} e-balls`);
    console.log();
    console.log('   Ledger breakdown by source:');
    gachaSpendBySourceRes.rows.forEach(row => {
      console.log(`     ${row.source}: ${row.count} rows, spent ${row.total_spent_value}, won ${row.total_won_value}`);
    });

    const totalWon = gachaLedger.total_won || 0;
    const totalSpent = gachaLedger.total_spent || 0;

    if (totalSpent > 0) {
      const ratio = (totalWon / totalSpent).toFixed(3);
      const isInflationary = totalWon > totalSpent;
      console.log();
      console.log(`   SUMMARY: Payout ratio ${ratio}x (${isInflationary ? 'INFLATIONARY' : 'Sustainable'})`);
      console.log(`   Expected value per spin: ${expectedValue} e-balls (from actual rewards)`);
    }
    console.log();

    // 5. Anomalous gacha spinners
    const anomalousSpinnersRes = await pool.query(`
      SELECT
        bitrix_id,
        COUNT(*) as spin_count,
        SUM(eball_amount)::BIGINT as total_won,
        MAX(created_at) as last_spin
      FROM gacha_spins
      GROUP BY bitrix_id
      HAVING COUNT(*) >= 5
      ORDER BY COUNT(*) DESC
      LIMIT 5
    `);

    console.log('6. TOP GACHA SPINNERS (5+ spins):');
    if (anomalousSpinnersRes.rows.length > 0) {
      anomalousSpinnersRes.rows.forEach((row, i) => {
        console.log(`   ${i+1}. User ${row.bitrix_id}: ${row.spin_count} spins, won ${row.total_won} e-balls`);
      });
    } else {
      console.log('   No users with 5+ gacha spins found');
    }

    console.log('\n=== END REPORT ===');

  } catch (error) {
    console.error('Query error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

analyze();
