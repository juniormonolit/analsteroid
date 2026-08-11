import { readFileSync } from 'fs';
import nextEnv from '@next/env'; const { loadEnvConfig } = nextEnv;
import pg from 'pg';
loadEnvConfig(process.cwd());
const pool = new pg.Pool({ host: process.env.YC_PG_HOST, port: +process.env.YC_PG_PORT,
  user: process.env.YC_PG_USER, password: process.env.YC_PG_PASSWORD, database: process.env.YC_ANALYTICS_DB,
  ssl: { ca: readFileSync(process.env.YC_PG_SSL_CA_PATH,'utf8') } });
const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='deals' AND table_schema='public' ORDER BY ordinal_position`);
console.log(cols.rows.map(r=>r.column_name).join(', '));
await pool.end();
