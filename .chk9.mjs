import nextEnv from '@next/env'; const { loadEnvConfig } = nextEnv;
import pg from 'pg';
loadEnvConfig(process.cwd());
const pool = new pg.Pool({ host: process.env.SA_PG_HOST, port: +(process.env.SA_PG_PORT ?? 5432),
  user: process.env.SA_PG_USER, password: process.env.SA_PG_PASSWORD, database: 'postgres', ssl:false });
console.log('--- стадии со stage_type = NEW ---');
console.table((await pool.query(`SELECT id, funnel_id, name, event_type, stage_type FROM stages WHERE stage_type='NEW' ORDER BY funnel_id, sort_order`)).rows);
console.log('--- какие вообще бывают event_type / stage_type ---');
console.table((await pool.query(`SELECT stage_type, event_type, count(*)::int n FROM stages GROUP BY 1,2 ORDER BY 1,2`)).rows);
await pool.end();
