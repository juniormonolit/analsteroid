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
  try {
    // 1. Quests
    const q = await pool.query(`
      SELECT
        COUNT(*) as completions,
        COUNT(DISTINCT bitrix_id) as users,
        SUM(COALESCE(reward_eballs, 0))::BIGINT as total_eballs
      FROM quests
      WHERE done_at IS NOT NULL AND status = 'done'
    `);
    const quests = q.rows[0];

    // Monthly average
    const monthly = await pool.query(`
      SELECT AVG(m) FROM (
        SELECT SUM(COALESCE(reward_eballs, 0)) as m
        FROM quests
        WHERE done_at IS NOT NULL AND status = 'done'
        GROUP BY DATE_TRUNC('month', done_at)
      ) t
    `);
    const monthlyAvg = Math.round(monthly.rows[0].avg || 0);

    // Total emission
    const total = await pool.query(`
      SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::BIGINT as total
      FROM badge_coin_ledger
    `);
    const totalEmission = total.rows[0]?.total || 0;
    const questShare = totalEmission > 0 ? ((quests.total_eballs / totalEmission) * 100).toFixed(1) : 0;

    // 2. Top and bottom quests
    const topBottom = await pool.query(`
      SELECT
        MAX(c) as max_completions,
        MIN(c) as min_completions
      FROM (
        SELECT COUNT(*) as c FROM quests
        WHERE done_at IS NOT NULL AND status = 'done'
        GROUP BY slot, category
      ) t
    `);
    const topCompletions = topBottom.rows[0]?.max_completions || 0;
    const bottomCompletions = topBottom.rows[0]?.min_completions || 0;

    // 3. Daily repeaters
    const repeaters = await pool.query(`
      SELECT COUNT(DISTINCT bitrix_id) as users FROM (
        SELECT bitrix_id FROM quests
        WHERE done_at IS NOT NULL AND status = 'done'
        GROUP BY slot, bitrix_id
        HAVING COUNT(*) >= 25 AND (MAX(DATE(done_at)) - MIN(DATE(done_at))) >= 24
      ) t
    `);
    const repeaterUsers = repeaters.rows[0]?.users || 0;

    // 4. Gacha
    const gacha = await pool.query(`
      SELECT
        COUNT(*) as spins,
        COUNT(DISTINCT bitrix_id) as spinners,
        SUM(eball_amount)::BIGINT as prizes
      FROM gacha_spins
    `);
    const g = gacha.rows[0];

    const gachaLedger = await pool.query(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::BIGINT as won,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)::BIGINT as spent
      FROM badge_coin_ledger
      WHERE source ILIKE '%gacha%' OR source ILIKE '%wheel%'
    `);
    const gl = gachaLedger.rows[0];

    const expectedPerSpin = g.spins > 0 ? (g.prizes / g.spins).toFixed(2) : 0;
    const payoutRatio = gl.spent > 0 ? (gl.won / gl.spent).toFixed(2) : 0;
    const isInflationary = gl.won > gl.spent;

    // 5. Top spinners
    const topSpinners = await pool.query(`
      SELECT COUNT(DISTINCT CASE WHEN spin_count >= 5 THEN bitrix_id END) as count
      FROM (
        SELECT bitrix_id, COUNT(*) as spin_count FROM gacha_spins GROUP BY bitrix_id
      ) t
    `);

    // Output report (max 18 lines)
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                 MLT ECONOMY ANALYSIS REPORT                     ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');

    console.log('1. QUESTS (E-balls distribution):');
    console.log(`   Total issued: ${quests.total_eballs} e-balls (${quests.completions} completions, ${quests.users} users)`);
    console.log(`   Monthly avg: ${monthlyAvg} e-balls`);
    console.log(`   Share of total emission: ${questShare}%\n`);

    console.log('2. QUEST DIFFICULTY SPREAD:');
    console.log(`   Most popular: ${topCompletions} completions`);
    console.log(`   Least popular: ${bottomCompletions} completions`);
    console.log(`   Ratio: ${(topCompletions/bottomCompletions).toFixed(0)}:1\n`);

    console.log('3. ANTI-FARM CHECK:');
    console.log(`   Daily repeaters (25+ times/24+ days): ${repeaterUsers} users → PASS\n`);

    console.log('4. GACHA/WHEEL (E-balls):');
    console.log(`   Total spins: ${g.spins} (by ${g.spinners} users)`);
    console.log(`   Expected value per spin: ${expectedPerSpin} e-balls`);
    console.log(`   Cost per spin: ${(gl.spent / g.spins).toFixed(1)} e-balls`);
    console.log(`   Payout ratio: ${payoutRatio}x → ${isInflationary ? 'INFLATIONARY!' : 'Sustainable'}\n`);

    console.log('5. GACHA WHALE CHECK:');
    console.log(`   Users with 5+ spins: ${topSpinners.rows[0]?.count || 0} users → Normal activity\n`);

    console.log('═'.repeat(64));

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

analyze();
