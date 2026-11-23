// Фоновая задача Задачника (instrumentation.ts → scheduleTasker, имя для BACKGROUND_JOBS_ALLOW: «tasker»):
//  - каждую минуту — дослать в Битрикс всё, что не ушло с первого раза (outbox);
//  - раз в 15 минут — автозамер задач с наступившей контрольной датой.
// Один исполнитель на кластер — advisory lock на отдельном соединении.
import { systemDb } from '@/lib/db/clients';
import { drainAll } from './bitrix';
import { measureDue } from './measure';

const MEASURE_EVERY_MS = 15 * 60_000;
let lastMeasure = 0;

export async function taskerTick(): Promise<{ drained: number; measured: number; failed: number } | null> {
  const client = await systemDb().connect();
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('tasker_job')) AS ok`);
    if (!lock.rows[0]?.ok) return null;
    try {
      const d = await drainAll();
      let m = { measured: 0, failed: 0 };
      if (Date.now() - lastMeasure >= MEASURE_EVERY_MS) {
        lastMeasure = Date.now();
        m = await measureDue();
      }
      return { drained: d.done, ...m };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('tasker_job'))`).catch(() => {});
    }
  } finally {
    client.release();
  }
}
