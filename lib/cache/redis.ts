import Redis from 'ioredis';

// Server-side Redis cache for heavy analytics results (L2, shared across instances/restarts).
//
// Behaviour by design:
//  - REDIS_URL unset            → caching disabled, getRedis() returns null (local dev works
//                                 without Redis; every call falls straight through to the DB).
//  - Redis unreachable / errors → fail fast and degrade to the DB producer. A request is NEVER
//                                 rejected because of the cache; errors are logged (throttled).
//
// Namespace + version live in the key prefix. Bump CACHE_VERSION to invalidate everything at
// once (e.g. after a schema/metric change that alters cached result shapes).

const CACHE_VERSION = 'v1';
const NS = `as:${CACHE_VERSION}:`;

let _client: Redis | null = null;
let _initTried = false;
let _lastWarnAt = 0;

function warnThrottled(msg: string, err: unknown) {
  const now = Date.now();
  if (now - _lastWarnAt < 30_000) return;
  _lastWarnAt = now;
  console.warn(`[cache] ${msg}:`, err instanceof Error ? err.message : err);
}

export function getRedis(): Redis | null {
  if (_initTried) return _client;
  _initTried = true;

  const url = process.env.REDIS_URL;
  if (!url) return null; // caching disabled

  const client = new Redis(url, {
    enableOfflineQueue: false,     // fail fast when down → producer (DB) runs instead of queueing
    maxRetriesPerRequest: 1,
    connectTimeout: 500,
    // Keep trying to reconnect in the background, backing off up to 10s.
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });

  // Without an 'error' listener ioredis lets the event bubble to an unhandled error and crashes
  // the process (same footgun as node-pg idle clients). Swallow + log throttled; the client
  // reconnects on its own.
  client.on('error', (err) => warnThrottled('redis connection error', err));

  _client = client;
  return client;
}

/**
 * Cache-aside helper. Returns the cached JSON value for `key` if present; otherwise runs
 * `producer()`, stores the result under `key` with a `ttlSec` expiry, and returns it.
 * Any Redis failure is swallowed and `producer()` is used directly.
 */
export async function cached<T>(key: string, ttlSec: number, producer: () => Promise<T>): Promise<T> {
  const client = getRedis();
  const fullKey = NS + key;

  if (client) {
    try {
      const hit = await client.get(fullKey);
      if (hit != null) return JSON.parse(hit) as T;
    } catch (err) {
      warnThrottled('get failed', err);
    }
  }

  const value = await producer();

  if (client) {
    try {
      await client.set(fullKey, JSON.stringify(value), 'EX', ttlSec);
    } catch (err) {
      warnThrottled('set failed', err);
    }
  }
  return value;
}

const LIVE_TTL_SEC = 10 * 60;             // 10 min — matches the previous in-memory behaviour
const HISTORICAL_TTL_SEC = 24 * 60 * 60;  // 24 h

/**
 * TTL policy for report caches. A period whose exclusive upper bound is still in the future
 * (i.e. it includes today) keeps changing as deals sync in → short TTL. A fully-past period is
 * stable → long TTL. `toExclIso` is the exclusive end (start of the day after the range end).
 */
export function reportTtl(toExclIso: string): number {
  return new Date(toExclIso).getTime() >= Date.now() ? LIVE_TTL_SEC : HISTORICAL_TTL_SEC;
}

/**
 * Best-effort invalidation of all report caches — e.g. to call after an offline deals sync.
 * Returns the number of keys removed (0 if caching is disabled or Redis is unreachable).
 */
export async function invalidateReports(): Promise<number> {
  const client = getRedis();
  if (!client) return 0;

  const pattern = `${NS}rpt:*`;
  let cursor = '0';
  let removed = 0;
  try {
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) removed += await client.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    warnThrottled('invalidate failed', err);
  }
  return removed;
}
