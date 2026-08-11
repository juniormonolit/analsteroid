import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = '/Users/middle/analsteroid';

// Parse .env.local
const env = {};
for (const line of fs.readFileSync(path.join(projectRoot, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\\\$/g, '$').replace(/^"|"$/g, '');
}

const caPath = path.join(projectRoot, 'certs/yandex-ca.pem');
const ca = fs.readFileSync(caPath).toString();

const sslConfig = { ca, rejectUnauthorized: false };

export const sys = new pg.Pool({
  host: env.YC_PG_HOST,
  port: Number(env.YC_PG_PORT),
  user: env.YC_PG_USER,
  password: env.YC_PG_PASSWORD,
  database: env.YC_SYSTEM_DB || 'system',
  ssl: sslConfig,
  max: 1,
});

export const sa = new pg.Pool({
  host: env.YC_PG_HOST,
  port: Number(env.YC_PG_PORT),
  user: env.YC_PG_USER,
  password: env.YC_PG_PASSWORD,
  database: env.YC_ANALYTICS_DB || 'analytics',
  ssl: sslConfig,
  max: 1,
});

export async function q(pool, query, params) {
  return (await pool.query(query, params)).rows;
}
