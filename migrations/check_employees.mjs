import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Pool } = require('/home/junior/analsteroid/.next/standalone/node_modules/pg');

const pgPassword = readFileSync('/home/junior/anal_v2/.pg_password', 'utf8').trim();
const ca = readFileSync(join(__dirname, '../certs/yandex-ca.pem'), 'utf8');

const pool = new Pool({ host: 'rc1b-o2tqrr9j3gq09svq.mdb.yandexcloud.net', port: 6432, user: 'JanCloude', password: pgPassword, database: 'system', ssl: { ca, rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });

const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='employees' ORDER BY ordinal_position");
console.log('employees columns:', cols.rows.map(r => r.column_name).join(', '));

const sample = await pool.query("SELECT * FROM employees LIMIT 5");
console.log('sample:', JSON.stringify(sample.rows, null, 2));

const orgSample = await pool.query("SELECT manager_bitrix_user_id, manager_name, short_login FROM org_resolved_hierarchy WHERE is_active=true LIMIT 5");
console.log('org sample:', JSON.stringify(orgSample.rows, null, 2));

await pool.end();
