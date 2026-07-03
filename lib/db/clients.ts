import { Pool, PoolConfig } from 'pg';
import fs from 'fs';
import path from 'path';

function makeYcSslConfig() {
  const caPath = process.env.YC_PG_SSL_CA_PATH;
  if (!caPath) return { rejectUnauthorized: false };
  const resolved = path.isAbsolute(caPath) ? caPath : path.join(process.cwd(), caPath);
  try {
    return { ca: fs.readFileSync(resolved).toString(), rejectUnauthorized: true };
  } catch {
    return { rejectUnauthorized: false };
  }
}

// Poolers (YC odyssey, Supabase Supavisor) terminate idle server connections with a
// FATAL message. node-pg surfaces that as an 'error' event on the idle client; without a
// listener it bubbles to an unhandled error and crashes the process. Swallow it — the Pool
// already evicts the dead client and opens a fresh one on the next query.
function attachIdleErrorHandler(pool: Pool): Pool {
  pool.on('error', (err) => {
    console.warn('[db] idle pool connection error (ignored):', err.message);
  });
  return pool;
}

function makeYcPool(database: string): Pool {
  const config: PoolConfig = {
    host: process.env.YC_PG_HOST!,
    port: Number(process.env.YC_PG_PORT ?? 6432),
    user: process.env.YC_PG_USER!,
    password: process.env.YC_PG_PASSWORD!,
    database,
    ssl: makeYcSslConfig(),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  return attachIdleErrorHandler(new Pool(config));
}

// Misha's self-hosted Supabase, schema `sa`
function makeSaPool(): Pool {
  return attachIdleErrorHandler(new Pool({
    host:     process.env.SA_PG_HOST ?? '127.0.0.1',
    port:     Number(process.env.SA_PG_PORT ?? 5432),
    user:     process.env.SA_PG_USER!,
    password: process.env.SA_PG_PASSWORD!,
    database: 'postgres',
    ssl:      false,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  }));
}

let _analytics: Pool | null = null;
let _ycAnalytics: Pool | null = null;
let _system: Pool | null = null;

// Misha's SA DB: deals, deal_events, funnels, stages, product_groups, head_groups
export function analyticsDb(): Pool {
  if (!_analytics) {
    _analytics = process.env.SA_PG_USER
      ? makeSaPool()
      : makeYcPool(process.env.YC_ANALYTICS_DB ?? 'analytics');
  }
  return _analytics;
}

// Yandex analytics DB: employees, sales_plans, metrics, report_configs, etc.
export function ycAnalyticsDb(): Pool {
  if (!_ycAnalytics) _ycAnalytics = makeYcPool(process.env.YC_ANALYTICS_DB ?? 'analytics');
  return _ycAnalytics;
}

export function systemDb(): Pool {
  if (!_system) _system = makeYcPool(process.env.YC_SYSTEM_DB ?? 'system');
  return _system;
}
