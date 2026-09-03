import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';

// Server-side Redis cache for heavy analytics results (L2, shared across instances/restarts).
//
// Behaviour by design:
//  - REDIS_URL unset            → caching disabled, getRedis() returns null (local dev works
//                                 without Redis; every call falls straight through to the DB).
//  - Redis unreachable / errors → fail fast and degrade to the DB producer. A request is NEVER
//                                 rejected because of the cache; errors are logged (throttled).
//
// Namespace + version live in the key prefix. Bumping CACHE_VERSION invalidates everything at
// once (e.g. after a schema/metric change that alters cached result shapes).
//
// Инцидент 09-10.07 (рекомендация Артёма, деплой 51): Redis-кэш `as:v1:rpt:*` был
// ПРИВЯЗАН К ХАРДКОДУ 'v1', не к версии кода — после деплоя с новой логикой расчёта
// (фикс «План (месяц)» и др.) прод продолжал отдавать РЕЗУЛЬТАТЫ, посчитанные ДО
// фикса, пока не истёк TTL (до 24ч, см. HISTORICAL_TTL_SEC) или Артём не сбрасывал
// кэш вручную (invalidateReports()). Фикс — версия кэша теперь ЧИТАЕТСЯ из
// `.next/BUILD_ID` (Next.js генерирует его заново на КАЖДЫЙ `next build`, см.
// package.json::scripts.build) — новый деплой = новый BUILD_ID = новый namespace
// автоматически, без единой ручной команды. Старые ключи не удаляются активно (никто
// больше не пишет/не читает по старому namespace — TTL сам вычистит их из Redis).
//
// dev (`next dev`) не создаёт `.next/BUILD_ID` — фолбэк 'dev' (нет реального деплоя,
// версионирование кэша не имеет смысла в watch-режиме, но код не должен падать).
// L1 in-memory кэши (byManagers.ts/byProductGroups.ts::_rowCache, cardTemplates.ts,
// scoringWeights.ts и т.п.) НЕ переживают деплой в принципе — процесс перезапускается
// целиком, Map обнуляется сама. Их трогать не нужно (BUILD_ID им ничего не даёт и не
// портит) — только L2 (Redis, переживает рестарт процесса) был уязвим к этому багу.
// Кандидаты пути к BUILD_ID — порядок зависит от того, ОТКУДА реально запущен
// `node server.js` (deploy.sh/start.sh — вне этого репозитория, живёт на сервере
// Артёма, у нас нет доступа проверить cwd напрямую): официальный next.js standalone
// паттерн — cwd ВНУТРИ `.next/standalone` (тогда `.next/BUILD_ID` рядом, 1й кандидат);
// если start.sh вместо этого запускает `node .next/standalone/server.js` из корня
// проекта (cwd = корень) — верный файл лежит на 2 уровня глубже (2й кандидат).
// Пробуем оба, берём первый существующий — не падаем ни в одном из вариантов cwd.
let _buildId: string | null = null;
function resolveBuildId(): string {
  if (_buildId) return _buildId;
  const candidates = [
    path.join(process.cwd(), '.next', 'BUILD_ID'),
    path.join(process.cwd(), '.next', 'standalone', '.next', 'BUILD_ID'),
  ];
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) { _buildId = v; return _buildId; }
    } catch { /* пробуем следующий кандидат */ }
  }
  _buildId = 'dev'; // `next dev` или ни один путь не найден — вотч-режим/неизвестный запуск
  return _buildId;
}

const CACHE_VERSION = resolveBuildId();
const NS = `as:${CACHE_VERSION}:`;

let _client: Redis | null = null;
let _initTried = false;
let _lastWarnAt = 0;

// Первое подключение процесса — ОДНО на всю его жизнь (см. redisReady ниже).
// ioredis подключается асинхронно, а `enableOfflineQueue: false` означает, что
// команда, выданная ДО установления TCP-соединения, падает сразу же
// («Stream isn't writeable»). На проде это стреляло на КАЖДОМ рестарте: сразу
// после `✓ Ready` инструментация дёргает Redis-лок джобы, а первый отчёт —
// кэш; обе команды приходили раньше соединения. В логе — 123 такие строки на
// 76 рестартов (ровно по 1–2 на старт), и каждый раз пропускался тик
// widgetMetrics. Сам Redis при этом жив: PONG, ключи пишутся.
let _initialConnect: Promise<void> | null = null;
// Больше, чем connectTimeout (500 мс), чтобы хватило на пару попыток
// retryStrategy. Ждём максимум один раз за процесс — при реально лежащем
// Redis это разовая задержка на старте, а не на каждом запросе.
const INITIAL_CONNECT_WAIT_MS = 2_000;

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

  // Промис первого подключения: разрешается по первому 'ready' либо по
  // таймауту. Создаётся здесь, а не при первом запросе, чтобы отсчёт шёл с
  // момента реального старта соединения.
  _initialConnect = new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      client.removeListener('ready', finish);
      resolve();
    };
    const timer = setTimeout(finish, INITIAL_CONNECT_WAIT_MS);
    // Таймер не должен держать процесс живым (важно для скриптов/джобов).
    (timer as unknown as { unref?: () => void }).unref?.();
    client.once('ready', finish);
  });

  _client = client;
  return client;
}

/**
 * Клиент, которым прямо сейчас можно пользоваться, — или null, и тогда вызывающий
 * считает без кэша.
 *
 * Отличие от getRedis(): на САМОМ ПЕРВОМ обращении после старта процесса ждёт
 * установления соединения (до INITIAL_CONNECT_WAIT_MS), вместо того чтобы
 * выдать команду в ещё не открытый сокет и получить «Stream isn't writeable».
 * Дальше — прежняя политика fail-fast: не 'ready' значит реальный обрыв, ждать
 * нечего, отдаём null и идём в БД. Ожидание бывает не более одного раза за
 * процесс: `_initialConnect` после первого срабатывания уже разрешён.
 */
export async function redisReady(): Promise<Redis | null> {
  const client = getRedis();
  if (!client) return null; // кэш выключен (REDIS_URL не задан)
  if (client.status !== 'ready' && _initialConnect) await _initialConnect;
  if (client.status === 'ready') return client;
  // Сюда попадаем при настоящей недоступности Redis — это стоит видеть в логе,
  // но не чаще раза в 30 секунд (warnThrottled).
  warnThrottled('Redis недоступен, считаем без кэша', `status=${client.status}`);
  return null;
}

/**
 * Cache-aside helper. Returns the cached JSON value for `key` if present; otherwise runs
 * `producer()`, stores the result under `key` with a `ttlSec` expiry, and returns it.
 * Any Redis failure is swallowed and `producer()` is used directly.
 */
export async function cached<T>(key: string, ttlSec: number, producer: () => Promise<T>): Promise<T> {
  const client = await redisReady();
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

  // Предохранитель (инцидент 17.08, OOM прода): не пытаться сериализовать заведомо
  // необъятное. JSON.stringify гигантского массива сам аллоцирует гигабайты и до
  // своего «Invalid string length» успевает продавить кучу к OOM. 100 тыс. элементов —
  // с запасом выше любого легитимного кэшируемого результата (потолки движков — до
  // 10 тыс. строк); в лог пишем ключ и размер, чтобы виновник был виден сразу, а не
  // как обезличенное «set failed».
  const oversized = Array.isArray(value) && value.length > 100_000;
  if (oversized) {
    warnThrottled(`skip oversized set: ${key} (${(value as unknown[]).length} элементов)`, null);
  }

  if (client && !oversized) {
    try {
      await client.set(fullKey, JSON.stringify(value), 'EX', ttlSec);
    } catch (err) {
      warnThrottled(`set failed: ${key}`, err);
    }
  }
  return value;
}

const LIVE_TTL_SEC = 10 * 60;             // 10 min — matches the previous in-memory behaviour
const HISTORICAL_TTL_SEC = 24 * 60 * 60;  // 24 h
// «Свежезакончившийся» период ещё меняется задним числом: синк доносит вчерашние
// продажи и правки сумм в течение следующего дня. Инцидент 03.09: отчёт за 02.09,
// открытый в ~05:00, замёрз на 24 ч с 2 315 605 ₽; к 10:13 синк донёс продажу
// #250078 и +101 650 к сумме #249736 — живой дрилл показывал 2 491 255 ₽, и
// расхождение с кэшем не рассасывалось до вечера. 48 ч форы решают и «вчера», и
// стык месяца/выходных.
const RECENT_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * TTL policy for report caches. A period whose exclusive upper bound is still in the future
 * (i.e. it includes today) keeps changing as deals sync in → short TTL. A period that ended
 * less than RECENT_GRACE_MS ago still receives backdated sync edits → short TTL too. Only a
 * long-finished period is stable → long TTL. `toExclIso` is the exclusive end (start of the
 * day after the range end).
 */
export function reportTtl(toExclIso: string): number {
  const toExclMs = new Date(toExclIso).getTime();
  if (toExclMs >= Date.now()) return LIVE_TTL_SEC;
  return Date.now() - toExclMs < RECENT_GRACE_MS ? LIVE_TTL_SEC : HISTORICAL_TTL_SEC;
}

/**
 * Best-effort invalidation of all report caches — e.g. to call after an offline deals sync.
 * Returns the number of keys removed (0 if caching is disabled or Redis is unreachable).
 */
export async function invalidateReports(): Promise<number> {
  const client = await redisReady();
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
