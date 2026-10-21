// Общий список заказчиков компании (миграция 232; владелец 21.10: «смотреть всю компанию
// целиком»; решение — консультация Fable). Один тяжёлый расчёт по всей компании вместо
// расчёта на каждого менеджера: замер 21.10 — один менеджер 1,7 с, вся компания (22,7 тыс.
// заказчиков) ~16 с, т.е. 270 менеджеров по очереди ≈ 8 минут БД против 16 секунд.
//
// Слои: память процесса (срез по менеджеру — мгновенно) ← таблица customer_snapshot в нашей
// system-БД (переживает выкатку; Redis-кэш — нет, его namespace привязан к BUILD_ID) ←
// пересчёт в фоне. Пересчёт ровно один: промис в процессе + замок в Redis между процессами.
// Читатель никогда не ждёт пересчёта, если снимок уже есть: отдаётся текущий, а устаревший
// (старше FRESH_MS) запускает фоновое обновление. Ждать приходится только самому первому
// запуску (пустая таблица) — awaitSnapshot.
import { systemDb } from '@/lib/db/clients';
import { redisReady } from '@/lib/cache/redis';

/** Свежесть: старше — фоновый пересчёт (живые стадии/звонки/задачи доска читает поверх). */
export const SNAPSHOT_FRESH_MS = 10 * 60_000;
/** Старше этого снимок не отдаём вовсе (сломался пересчёт) — потребители идут старым путём. */
export const SNAPSHOT_MAX_AGE_MS = 36 * 3600_000;
const LOCK_KEY = 'customers:company-snapshot:lock'; // без namespace сборки: замок общий между выкатками
const LOCK_TTL_SEC = 300;
const RETRY_AFTER_FAIL_MS = 60_000;
/** Форма строки снимка. Менять ВМЕСТЕ с версией ключа customers:mgr:vN в customers.ts:
 *  снимок в БД переживает выкатку, и без версии новый код читал бы строки старой формы. */
const SHAPE_VERSION = 'v11';

export type SnapshotProducer<R> = () => Promise<Map<number, R[]>>;
interface Snap { at: number; byMgr: Map<number, unknown[]>; total: number }
interface State {
  snap: Snap | null;
  loadP: Promise<void> | null;
  refreshP: Promise<void> | null;
  lastFailAt: number;
  lastDbCheckAt: number;
}
// globalThis — переживает HMR в dev и не дублируется, если модуль попал в несколько чанков.
const g = globalThis as unknown as { __customerSnapshot?: State };
const st: State = (g.__customerSnapshot ??= { snap: null, loadP: null, refreshP: null, lastFailAt: 0, lastDbCheckAt: 0 });

async function loadFromDb(): Promise<void> {
  st.lastDbCheckAt = Date.now();
  const meta = await systemDb().query<{ at: Date; version: string | null }>(`SELECT computed_at AS at, version FROM customer_snapshot_meta WHERE id = 1`);
  if (!meta.rows[0] || meta.rows[0].version !== SHAPE_VERSION) return;
  const at = new Date(meta.rows[0].at).getTime();
  if (st.snap && st.snap.at >= at) return;
  const r = await systemDb().query<{ manager_id: string; rows: unknown[] }>(`SELECT manager_id::text AS manager_id, rows FROM customer_snapshot`);
  const byMgr = new Map(r.rows.map(x => [Number(x.manager_id), x.rows]));
  st.snap = { at, byMgr, total: r.rows.reduce((s, x) => s + x.rows.length, 0) };
}

function ensureLoaded(): Promise<void> {
  st.loadP ??= loadFromDb().catch(e => {
    console.warn('[customer-snapshot] чтение из БД:', e instanceof Error ? e.message : e);
    st.loadP = null; // следующий запрос попробует снова
  });
  return st.loadP;
}

async function writeToDb(byMgr: Map<number, unknown[]>, at: number, durationMs: number): Promise<void> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM customer_snapshot');
    for (const [mgr, rows] of byMgr) {
      await client.query(`INSERT INTO customer_snapshot (manager_id, rows, computed_at) VALUES ($1, $2::jsonb, $3)`,
        [mgr, JSON.stringify(rows), new Date(at)]);
    }
    const total = [...byMgr.values()].reduce((s, l) => s + l.length, 0);
    await client.query(
      `INSERT INTO customer_snapshot_meta (id, computed_at, rows_total, duration_ms, version) VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET computed_at = EXCLUDED.computed_at, rows_total = EXCLUDED.rows_total,
         duration_ms = EXCLUDED.duration_ms, version = EXCLUDED.version`,
      [new Date(at), total, durationMs, SHAPE_VERSION]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Пересчитать снимок (один на процесс и, через замок Redis, на все процессы). */
export function refreshSnapshot<R>(producer: SnapshotProducer<R>): Promise<void> {
  if (st.refreshP) return st.refreshP;
  st.refreshP = (async () => {
    const redis = await redisReady();
    const token = `${process.pid}:${Date.now()}`;
    if (redis) {
      const ok = await redis.set(LOCK_KEY, token, 'EX', LOCK_TTL_SEC, 'NX').catch(() => 'OK');
      if (!ok) {
        // Считает другой процесс — подхватим его результат из БД (не чаще раза в минуту).
        if (Date.now() - st.lastDbCheckAt > 60_000) await loadFromDb().catch(() => {});
        return;
      }
    }
    const t0 = Date.now();
    try {
      const byMgr = await producer() as Map<number, unknown[]>;
      // Время снимка — начало расчёта: данные «на момент» запуска запроса.
      st.snap = { at: t0, byMgr, total: [...byMgr.values()].reduce((s, l) => s + l.length, 0) };
      await writeToDb(byMgr, t0, Date.now() - t0);
      console.log(`[customer-snapshot] ${st.snap.total} заказчиков, ${byMgr.size} менеджеров, ${Date.now() - t0} мс`);
    } finally {
      if (redis) {
        const cur = await redis.get(LOCK_KEY).catch(() => null);
        if (cur === token) await redis.del(LOCK_KEY).catch(() => {});
      }
    }
  })().catch(e => {
    st.lastFailAt = Date.now();
    console.warn('[customer-snapshot] пересчёт не удался:', e instanceof Error ? e.message : e);
  }).finally(() => { st.refreshP = null; });
  return st.refreshP;
}

function kickIfStale<R>(producer: SnapshotProducer<R>): void {
  const age = st.snap ? Date.now() - st.snap.at : Infinity;
  if (age > SNAPSHOT_FRESH_MS && Date.now() - st.lastFailAt > RETRY_AFTER_FAIL_MS) void refreshSnapshot(producer);
}

function usable(): Snap | null {
  const s = st.snap;
  return s && Date.now() - s.at <= SNAPSHOT_MAX_AGE_MS ? s : null;
}

/** Заказчики менеджера из снимка; null — снимка нет (вызывающий идёт старым путём). */
export async function snapshotRowsOf<R>(managerId: number, producer: SnapshotProducer<R>): Promise<R[] | null> {
  await ensureLoaded();
  kickIfStale(producer);
  const s = usable();
  return s ? ((s.byMgr.get(managerId) ?? []) as R[]) : null;
}

/** Снимок целиком для многих менеджеров: если его ещё нет (самый первый запуск) — ждём
 *  пересчёта до waitMs. null — так и не готов (UI показывает «данные готовятся»). */
export async function awaitSnapshot<R>(producer: SnapshotProducer<R>, waitMs: number): Promise<{ at: number; byMgr: Map<number, R[]> } | null> {
  await ensureLoaded();
  kickIfStale(producer);
  let s = usable();
  if (!s && st.refreshP) {
    await Promise.race([st.refreshP, new Promise(r => setTimeout(r, waitMs))]);
    s = usable();
  }
  return s ? { at: s.at, byMgr: s.byMgr as Map<number, R[]> } : null;
}

export function snapshotInfo(): { at: number | null; total: number; refreshing: boolean } {
  return { at: st.snap?.at ?? null, total: st.snap?.total ?? 0, refreshing: !!st.refreshP };
}
