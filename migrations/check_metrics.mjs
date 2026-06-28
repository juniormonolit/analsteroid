import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Pool } = require('/home/junior/analsteroid/.next/standalone/node_modules/pg');

const pgPassword = readFileSync('/home/junior/anal_v2/.pg_password', 'utf8').trim();
const ca = readFileSync(join(__dirname, '../certs/yandex-ca.pem'), 'utf8');

async function q(database, sql) {
  const pool = new Pool({ host: 'rc1b-o2tqrr9j3gq09svq.mdb.yandexcloud.net', port: 6432, user: 'JanCloude', password: pgPassword, database, ssl: { ca, rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  const r = await pool.query(sql);
  await pool.end();
  return r.rows;
}

console.log('=== analytics DB: metrics count by hidden status ===');
const counts = await q('analytics', "SELECT is_hidden_in_ui, COUNT(*) FROM metrics GROUP BY is_hidden_in_ui ORDER BY is_hidden_in_ui");
console.log(counts);

console.log('\n=== analytics DB: all metrics (id, is_hidden_in_ui) ===');
const all = await q('analytics', "SELECT id, is_hidden_in_ui FROM metrics ORDER BY sort_order");
console.log(all.map(r => `${r.is_hidden_in_ui ? '[H]' : '[V]'} ${r.id}`).join('\n'));

console.log('\n=== system DB: org_resolved_hierarchy columns ===');
const orgCols = await q('system', "SELECT column_name FROM information_schema.columns WHERE table_name='org_resolved_hierarchy' ORDER BY ordinal_position");
console.log(orgCols.map(r => r.column_name).join(', '));
