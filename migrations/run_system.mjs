// Runner for YC system DB migrations
// Usage: node migrations/run_system.mjs <sql_file>
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Pool } = require('/home/junior/analsteroid/.next/standalone/node_modules/pg');

const pgPassword = readFileSync('/home/junior/anal_v2/.pg_password', 'utf8').trim();
const ca = readFileSync(join(__dirname, '../certs/yandex-ca.pem'), 'utf8');

const pool = new Pool({
  host: 'rc1b-o2tqrr9j3gq09svq.mdb.yandexcloud.net',
  port: 6432,
  user: 'JanCloude',
  password: pgPassword,
  database: 'system',
  ssl: { ca, rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

const sqlFile = process.argv[2] ?? join(__dirname, '010_system_short_login.sql');
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
