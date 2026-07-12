// Runner for SA / Misha DB migrations (schema sa/va/rop — тот же Postgres, что analyticsDb()).
// Usage: node migrations/run_sa.mjs <sql_file>
// Креды берём из .env.local (SA_PG_*), как lib/db/clients.ts::makeSaPool.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// dotenv, как в run.mjs
const { config } = await import('dotenv');
config({ path: join(__dirname, '../.env.local') });
const env = process.env;

let Pool;
try {
  ({ Pool } = require('pg'));
} catch {
  ({ Pool } = require('/home/junior/analsteroid/.next/standalone/node_modules/pg'));
}

const pool = new Pool({
  host:     env.SA_PG_HOST ?? '127.0.0.1',
  port:     Number(env.SA_PG_PORT ?? 5432),
  user:     env.SA_PG_USER,
  password: env.SA_PG_PASSWORD,
  database: 'postgres',
  ssl:      false,
  connectionTimeoutMillis: 15000,
});

const sqlFile = process.argv[2] ?? join(__dirname, '088_analsteroid_deal_metrics.sql');
const sql = readFileSync(sqlFile, 'utf8');

try {
  await pool.query(sql);
  console.log('OK:', sqlFile);
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
