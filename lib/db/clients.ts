import { Pool, PoolConfig } from 'pg';
import fs from 'fs';
import path from 'path';

function makeSslConfig() {
  const caPath = process.env.YC_PG_SSL_CA_PATH;
  if (!caPath) return { rejectUnauthorized: false };
  const resolved = path.isAbsolute(caPath) ? caPath : path.join(process.cwd(), caPath);
  try {
    return { ca: fs.readFileSync(resolved).toString(), rejectUnauthorized: true };
  } catch {
    return { rejectUnauthorized: false };
  }
}

function makePool(database: string): Pool {
  const config: PoolConfig = {
    host: process.env.YC_PG_HOST!,
    port: Number(process.env.YC_PG_PORT ?? 6432),
    user: process.env.YC_PG_USER!,
    password: process.env.YC_PG_PASSWORD!,
    database,
    ssl: makeSslConfig(),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  return new Pool(config);
}

let _analytics: Pool | null = null;
let _system: Pool | null = null;

export function analyticsDb(): Pool {
  if (!_analytics) _analytics = makePool(process.env.YC_ANALYTICS_DB ?? 'analytics');
  return _analytics;
}

export function systemDb(): Pool {
  if (!_system) _system = makePool(process.env.YC_SYSTEM_DB ?? 'system');
  return _system;
}
