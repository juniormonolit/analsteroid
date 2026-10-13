import { Pool, type PoolConfig } from 'pg';
import fs from 'fs';
import path from 'path';

function makeYcSslConfig() {
  const caPath = process.env.YC_PG_SSL_CA_PATH;
  if (!caPath) return { rejectUnauthorized: false };
  // turbopackIgnore: путь из env — без пометки Next 16.3 трассирует весь проект
  // в .next/standalone (#8256).
  const resolved = path.isAbsolute(caPath) ? caPath : path.join(/*turbopackIgnore: true*/ process.cwd(), caPath);
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

// Размер пула из env: пул тенанта Supavisor (session-mode) всего 15 соединений на всё
// приложение, поэтому по умолчанию 8 на каждый из пулов (#8968).
function poolMax(envName: string, fallback = 8): number {
  const n = Number(process.env[envName]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Пулы живут в globalThis: отдельные чанки Next и HMR иначе импортируют модуль заново
// и плодят дубли пулов (#8968). YC-пулы — по имени БД.
declare global {
  // eslint-disable-next-line no-var
  var __analsteroidSaPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __analsteroidYcPool: Map<string, Pool> | undefined;
}

// Хотфикс (инцидент YC 08.10): system/analytics можно увести на локальный Postgres
// через SYS_PG_*; без них — прежние YC-значения. SYS_PG_SSL: 'disable' (по умолчанию
// для SYS_PG_HOST) | 'require' (без проверки CA) | 'yc' (как у YC, с CA из YC_PG_SSL_CA_PATH).
function ycConnection(): Pick<PoolConfig, 'host' | 'port' | 'user' | 'password' | 'ssl'> {
  const env = process.env;
  if (env.SYS_PG_HOST) {
    const sslMode = (env.SYS_PG_SSL ?? 'disable').toLowerCase();
    return {
      host: env.SYS_PG_HOST,
      port: Number(env.SYS_PG_PORT ?? 5432),
      user: env.SYS_PG_USER ?? env.YC_PG_USER,
      password: env.SYS_PG_PASSWORD ?? env.YC_PG_PASSWORD,
      ssl: sslMode === 'yc' ? makeYcSslConfig() : sslMode === 'require' ? { rejectUnauthorized: false } : false,
    };
  }
  return {
    host: env.YC_PG_HOST!,
    port: Number(env.YC_PG_PORT ?? 6432),
    user: env.YC_PG_USER!,
    password: env.YC_PG_PASSWORD!,
    ssl: makeYcSslConfig(),
  };
}

function makeYcPool(database: string): Pool {
  const cache = (globalThis.__analsteroidYcPool ??= new Map<string, Pool>());
  const cached = cache.get(database);
  if (cached) return cached;
  const config: PoolConfig = {
    ...ycConnection(),
    database,
    max: poolMax('YC_PG_POOL_MAX'),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  };
  const pool = attachIdleErrorHandler(new Pool(config));
  cache.set(database, pool);
  return pool;
}

// Misha's self-hosted Supabase, schema `sa`
function makeSaPool(): Pool {
  if (globalThis.__analsteroidSaPool) return globalThis.__analsteroidSaPool;
  return (globalThis.__analsteroidSaPool = attachIdleErrorHandler(new Pool({
    host:     process.env.SA_PG_HOST ?? '127.0.0.1',
    port:     Number(process.env.SA_PG_PORT ?? 5432),
    user:     process.env.SA_PG_USER!,
    password: process.env.SA_PG_PASSWORD!,
    database: 'postgres',
    ssl:      false,
    max: poolMax('SA_PG_POOL_MAX'),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  })));
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

// База Диспетчера (схема sd — зеркало 1С) живёт в том же MLT Supabase, что и
// sa: роль SA_PG_USER имеет на sd USAGE+SELECT. Отдельный пул не нужен — это тот
// же Postgres; раздел «Реализация» (задача #8034) читает sd только SELECT'ами.
// Без SA-подключения (YC-фолбэк analyticsDb) схемы sd нет — честная ошибка.
export function sdDb(): Pool {
  if (!process.env.SA_PG_USER) throw new Error('sd недоступна: не задано подключение SA_PG_* (MLT Supabase)');
  return analyticsDb();
}
