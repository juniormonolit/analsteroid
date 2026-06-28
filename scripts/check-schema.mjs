import pg from '/home/junior/analsteroid/.next/standalone/node_modules/pg/lib/index.js';
import fs from 'fs';

const raw = fs.readFileSync('/home/junior/analsteroid/.env.local', 'utf8');
const env = {};
for (const l of raw.split('\n')) {
  const i = l.indexOf('=');
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}

const ca = fs.readFileSync('/home/junior/analsteroid/certs/yandex-ca.pem').toString();

async function query(database, sql) {
  const pool = new pg.Pool({ host: env.YC_PG_HOST, port: +env.YC_PG_PORT, user: env.YC_PG_USER, password: env.YC_PG_PASSWORD, database, ssl: { ca, rejectUnauthorized: false } });
  const r = await pool.query(sql);
  await pool.end();
  return r.rows;
}

// deals columns
const dealsCols = await query(env.YC_ANALYTICS_DB, "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='deals' ORDER BY ordinal_position");
console.log('=== deals ===');
console.log(dealsCols.map(x => x.column_name + ':' + x.data_type).join('\n'));

// stages event_types
const stages = await query(env.YC_ANALYTICS_DB, "SELECT id, name, event_type FROM stages ORDER BY id");
console.log('\n=== stages ===');
console.log(stages.map(x => x.id + ' | ' + x.event_type + ' | ' + x.name).join('\n'));

// system DB org columns
const orgCols = await query(env.YC_SYSTEM_DB, "SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('employees','org_resolved_hierarchy') ORDER BY table_name, ordinal_position");
console.log('\n=== system org ===');
console.log(orgCols.map(x => x.table_name + '.' + x.column_name).join('\n'));
