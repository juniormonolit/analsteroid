// Простейший in-memory лимитер для публичных ТВ-эндпоинтов («поставь запреты от
// роботов» — владелец 07.09). Прод — один процесс standalone, распределённый
// счётчик не нужен. Окно скользящее: N событий за W секунд на ключ (ip/токен).

const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimited(key: string, limit: number, windowSec: number): boolean {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, arr] of buckets) {
      const alive = arr.filter(t => now - t < windowSec * 1000 * 2);
      if (alive.length === 0) buckets.delete(k); else buckets.set(k, alive);
    }
  }
  const arr = (buckets.get(key) ?? []).filter(t => now - t < windowSec * 1000);
  if (arr.length >= limit) { buckets.set(key, arr); return true; }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}

export function tooMany(): Response {
  return Response.json({ error: 'Слишком много запросов' }, { status: 429, headers: { 'Retry-After': '30' } });
}
