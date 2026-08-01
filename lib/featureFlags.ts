// Универсальные фиче-флаги (миграция 132, задача владельца 01.08): включение/
// выключение фичи без выкатки. Первое применение — «Планёрка» (Серёга: «не
// нравится как получилась — убери», решение владельца: не удалять код, спрятать
// флагом). Фолбэк ВСЕГДА false (скрыто), если таблицы/строки ещё нет — безопасно
// на случай рассинхрона порядка деплоя кода/миграции.

import { systemDb } from '@/lib/db/clients';

const CACHE_TTL_MS = 60_000; // как daily_plan_mode — быстро подхватывается, не дёргает БД на каждый реквест
const cache = new Map<string, { value: boolean; at: number }>();

export async function isFeatureEnabled(key: string): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = false;
  try {
    const res = await systemDb().query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags WHERE key = $1`,
      [key],
    );
    value = res.rows[0]?.enabled === true;
  } catch {
    /* таблицы ещё нет (до миграции 132) — остаёмся выключенными */
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

export function invalidateFeatureFlagCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
