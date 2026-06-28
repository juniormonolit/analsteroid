import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use dotenv to parse env file
const { config } = await import('dotenv');
config({ path: path.join(__dirname, '../.env.local') });
const env = process.env;

const caPath = path.join(__dirname, '../certs/yandex-ca.pem');
const ca = fs.readFileSync(caPath).toString();

const pool = new pg.Pool({
  host: env.YC_PG_HOST,
  port: Number(env.YC_PG_PORT),
  user: env.YC_PG_USER,
  password: env.YC_PG_PASSWORD,
  database: env.YC_SYSTEM_DB,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

const sql = fs.readFileSync(path.join(__dirname, '001_saved_reports.sql'), 'utf8');

try {
  await pool.query(sql);
  console.log('Migration OK');
} catch (e) {
  console.error('Error:', e.message);
} finally {
  await pool.end();
}
