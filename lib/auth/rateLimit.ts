import type { NextRequest } from 'next/server';

// In-memory brute-force guard for the login endpoint. Assumes a single Node process per
// deployed instance — the same assumption instrumentation.ts already makes for the
// plan-summary cron (deploy is SSH+tar+nohup on a bare VPS, no multi-instance fan-out).
// If that ever changes, back this with Redis (getRedis() is already available) instead.

const WINDOW_MS = 15 * 60 * 1000;  // window in which failures accumulate
const MAX_ATTEMPTS = 5;            // failures allowed per (ip, login) within the window
const LOCK_MS = 15 * 60 * 1000;    // lockout duration once the threshold is hit

interface Bucket { failures: number; firstFailureAt: number; lockedUntil: number }
const buckets = new Map<string, Bucket>();

// Periodic cleanup so the Map doesn't grow unbounded under scanning/enumeration attempts.
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now - b.firstFailureAt > WINDOW_MS && b.lockedUntil < now) buckets.delete(key);
  }
}, WINDOW_MS);
cleanup.unref();

function clientIp(req: NextRequest): string {
  // Caddy sits in front of the app (see lib/http/publicOrigin.ts) and sets this.
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

function bucketKey(req: NextRequest, login: string): string {
  return `${clientIp(req)}|${login.toLowerCase().trim()}`;
}

export function checkLoginRateLimit(req: NextRequest, login: string): { blocked: boolean; retryAfterSec: number } {
  const b = buckets.get(bucketKey(req, login));
  if (!b) return { blocked: false, retryAfterSec: 0 };
  const now = Date.now();
  if (b.lockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

export function recordLoginFailure(req: NextRequest, login: string): void {
  const key = bucketKey(req, login);
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.firstFailureAt > WINDOW_MS) {
    buckets.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }
  b.failures += 1;
  if (b.failures >= MAX_ATTEMPTS) {
    b.lockedUntil = now + LOCK_MS;
  }
}

export function recordLoginSuccess(req: NextRequest, login: string): void {
  buckets.delete(bucketKey(req, login));
}
