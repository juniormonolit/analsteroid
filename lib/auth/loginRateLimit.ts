import crypto from 'crypto';
import { redisReady } from '../cache/redis';

// Лимит неудачных входов (аудит безопасности 29.09, #8256, находка A2).
//
// Считаются только НЕУДАЧНЫЕ попытки, в фиксированном окне, двумя счётчиками:
//  - по логину — перебор пароля одного аккаунта (в т.ч. с разных IP);
//  - по IP — перебор множества логинов с одного адреса (IP — из X-Forwarded-For
//    от нашего Caddy, см. lib/http/clientIp.ts).
// Счётчик по логину сбрасывается успешным входом. Порог достигнут — 429 с
// Retry-After до конца окна, пароль при этом даже не сверяется.
//
// Хранилище: Redis (REDIS_URL, тот же клиент, что у кэша отчётов) — счётчики
// общие для процессов и переживают рестарт. Без REDIS_URL или при недоступном
// Redis — память процесса (прод — один процесс standalone; после рестарта
// счётчики обнуляются — это осознанная деградация, вход не блокируется из-за
// падения Redis).
//
// Настройки (env, дефолты в скобках): LOGIN_RATE_WINDOW_SEC (900),
// LOGIN_RATE_MAX_PER_LOGIN (10), LOGIN_RATE_MAX_PER_IP (50 — офис за одним NAT).

export interface RateCount { count: number; ttlSec: number }

export interface RateStore {
  incr(key: string, windowSec: number): Promise<RateCount>;
  get(key: string): Promise<RateCount>;
  del(key: string): Promise<void>;
}

export class MemoryRateStore implements RateStore {
  private map = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  private alive(key: string) {
    const t = this.now();
    if (t - this.lastSweep > 60_000) {
      this.lastSweep = t;
      for (const [k, v] of this.map) if (v.resetAt <= t) this.map.delete(k);
    }
    const e = this.map.get(key);
    if (e && e.resetAt <= t) { this.map.delete(key); return undefined; }
    return e;
  }
  async incr(key: string, windowSec: number): Promise<RateCount> {
    const t = this.now();
    let e = this.alive(key);
    if (!e) { e = { count: 0, resetAt: t + windowSec * 1000 }; this.map.set(key, e); }
    e.count++;
    return { count: e.count, ttlSec: Math.ceil((e.resetAt - t) / 1000) };
  }
  async get(key: string): Promise<RateCount> {
    const e = this.alive(key);
    return e ? { count: e.count, ttlSec: Math.ceil((e.resetAt - this.now()) / 1000) } : { count: 0, ttlSec: 0 };
  }
  async del(key: string): Promise<void> { this.map.delete(key); }
}

/** Redis с откатом на память процесса при недоступности (не блокирует вход). */
export class RedisRateStore implements RateStore {
  private fallback: RateStore;
  constructor(fallback: RateStore = new MemoryRateStore()) { this.fallback = fallback; }

  async incr(key: string, windowSec: number): Promise<RateCount> {
    const r = await redisReady();
    if (!r) return this.fallback.incr(key, windowSec);
    try {
      // SET NX EX открывает окно (работает на любой версии Redis, в отличие от EXPIRE NX).
      const res = await r.multi().set(key, '0', 'EX', windowSec, 'NX').incr(key).ttl(key).exec();
      const count = Number(res?.[1]?.[1] ?? 0);
      const ttl = Number(res?.[2]?.[1] ?? windowSec);
      return { count, ttlSec: ttl > 0 ? ttl : windowSec };
    } catch {
      return this.fallback.incr(key, windowSec);
    }
  }
  async get(key: string): Promise<RateCount> {
    const r = await redisReady();
    if (!r) return this.fallback.get(key);
    try {
      const res = await r.multi().get(key).ttl(key).exec();
      const count = Number(res?.[0]?.[1] ?? 0) || 0;
      const ttl = Number(res?.[1]?.[1] ?? 0);
      return { count, ttlSec: ttl > 0 ? ttl : 0 };
    } catch {
      return this.fallback.get(key);
    }
  }
  async del(key: string): Promise<void> {
    await this.fallback.del(key);
    const r = await redisReady();
    if (!r) return;
    try { await r.del(key); } catch { /* не критично */ }
  }
}

export interface LoginLimiterOptions {
  store: RateStore;
  windowSec: number;
  maxPerLogin: number;
  maxPerIp: number;
  prefix?: string;
}

export interface LoginLimiter {
  /** null — можно пробовать; иначе через сколько секунд. */
  blocked(ip: string | null, login: string): Promise<{ retryAfterSec: number } | null>;
  recordFailure(ip: string | null, login: string): Promise<void>;
  recordSuccess(ip: string | null, login: string): Promise<void>;
}

function loginKey(prefix: string, login: string): string {
  const norm = String(login).toLowerCase().trim();
  return `${prefix}login:${crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32)}`;
}
function ipKey(prefix: string, ip: string | null): string {
  return `${prefix}ip:${ip ?? 'unknown'}`;
}

export function createLoginLimiter(o: LoginLimiterOptions): LoginLimiter {
  const prefix = o.prefix ?? 'as:rl:auth:';
  return {
    async blocked(ip, login) {
      const [l, i] = await Promise.all([o.store.get(loginKey(prefix, login)), o.store.get(ipKey(prefix, ip))]);
      const waits: number[] = [];
      if (l.count >= o.maxPerLogin) waits.push(l.ttlSec);
      if (i.count >= o.maxPerIp) waits.push(i.ttlSec);
      if (!waits.length) return null;
      return { retryAfterSec: Math.max(1, ...waits) };
    },
    async recordFailure(ip, login) {
      await Promise.all([
        o.store.incr(loginKey(prefix, login), o.windowSec),
        o.store.incr(ipKey(prefix, ip), o.windowSec),
      ]);
    },
    async recordSuccess(_ip, login) {
      await o.store.del(loginKey(prefix, login));
    },
  };
}

function envInt(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

let _default: LoginLimiter | null = null;
/** Лимитер входа/проверки пароля с настройками из env (один на процесс). */
export function authLimiter(): LoginLimiter {
  if (_default) return _default;
  _default = createLoginLimiter({
    store: new RedisRateStore(),
    windowSec: envInt('LOGIN_RATE_WINDOW_SEC', 900, 10, 86_400),
    maxPerLogin: envInt('LOGIN_RATE_MAX_PER_LOGIN', 10, 1, 10_000),
    maxPerIp: envInt('LOGIN_RATE_MAX_PER_IP', 50, 1, 100_000),
  });
  return _default;
}

export function tooManyAttempts(retryAfterSec: number): Response {
  const min = Math.max(1, Math.ceil(retryAfterSec / 60));
  return Response.json(
    { error: `Слишком много неудачных попыток входа. Попробуйте через ${min} мин.` },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  );
}
