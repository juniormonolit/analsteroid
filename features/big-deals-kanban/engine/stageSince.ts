// Когда задача попала в текущую колонку: свой журнал (Битрикс время смены стадии не отдаёт).
// Redis-хеш bigdeals:since: taskId → `column|iso`. Без Redis — память процесса.
import { redisReady } from '@/lib/cache/redis';
import type { BigColumnKey } from './config';

const KEY = 'bigdeals:since';
const mem = new Map<string, string>();

export interface SinceInput { id: number; column: BigColumnKey; firstSeen: string }

/** Возвращает taskId → iso попадания в колонку. Сменилась колонка — пишем «сейчас»;
 *  первое наблюдение — firstSeen (changedAt задачи). */
export async function resolveSince(items: SinceInput[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const redis = await redisReady().catch(() => null);
  let stored: Record<string, string> = {};
  if (redis) {
    try { stored = await redis.hgetall(KEY); } catch { stored = Object.fromEntries(mem); }
  } else stored = Object.fromEntries(mem);
  const now = new Date().toISOString();
  const writes: Record<string, string> = {};
  for (const it of items) {
    const prev = stored[String(it.id)];
    const [col, iso] = prev ? prev.split('|') : [null, null];
    if (col === it.column && iso) { out.set(it.id, iso); continue; }
    const at = prev ? now : it.firstSeen;
    out.set(it.id, at);
    writes[String(it.id)] = `${it.column}|${at}`;
  }
  for (const [k, v] of Object.entries(writes)) mem.set(k, v);
  if (redis && Object.keys(writes).length) await redis.hset(KEY, writes).catch(() => {});
  return out;
}

/** Действие сменило колонку — фиксируем сразу (чтобы «в колонке 0 дн.» был виден до пересборки). */
export async function markColumn(taskId: number, column: BigColumnKey): Promise<void> {
  const v = `${column}|${new Date().toISOString()}`;
  mem.set(String(taskId), v);
  const redis = await redisReady().catch(() => null);
  if (redis) await redis.hset(KEY, String(taskId), v).catch(() => {});
}
