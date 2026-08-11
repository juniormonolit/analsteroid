import nextEnv from '@next/env'; const { loadEnvConfig } = nextEnv;
import pg from 'pg';
loadEnvConfig(process.cwd());
const pool = new pg.Pool({ host: process.env.SA_PG_HOST, port: +(process.env.SA_PG_PORT ?? 5432),
  user: process.env.SA_PG_USER, password: process.env.SA_PG_PASSWORD, database: 'postgres', ssl:false });
console.log('search_path:', (await pool.query('SHOW search_path')).rows[0].search_path);
const r = await pool.query(`
  SELECT d.deal_id, left(d.deal_name,26) AS name, d.amount, d.current_manager_id AS mgr,
         CASE WHEN d.products IS NULL THEN 'NULL' ELSE jsonb_array_length(d.products)::text END AS prod_rows,
         s.name AS stage, s.stage_type
    FROM deals d LEFT JOIN stages s ON s.id = d.stage_id
   WHERE d.deal_id IN (220975, 233083, 231856, 229726, 229609, 235596, 220665)
   ORDER BY d.deal_id`);
console.table(r.rows);
await pool.end();
