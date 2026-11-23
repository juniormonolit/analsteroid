// Фоновая задача Задачника (instrumentation.ts → scheduleTasker, имя для BACKGROUND_JOBS_ALLOW: «tasker»):
//  - каждую минуту — дослать в Битрикс всё, что не ушло с первого раза (outbox);
//  - раз в 15 минут — автозамер задач с наступившей контрольной датой;
//  - обучения (features/tasker/trainings/engine/measure.ts → trainingsTick): запись из задач, замер эффективности;
//  - при старте и раз в 15 минут — прогрев снимков («Сейчас» карточек и снимок формы), warm.ts;
//  - каждую минуту — календарь регулярных собраний: повтор несинхронизированных и перенос «скользящих».
// Один исполнитель на кластер — advisory lock на отдельном соединении.
import { systemDb } from '@/lib/db/clients';
import { drainAll } from './bitrix';
import { measureDue } from './measure';
import { maybeWarm } from './warm';
import { syncStaleMeetings } from '../meetings/engine/calendar';

const MEASURE_EVERY_MS = 15 * 60_000;
let lastMeasure = 0;

export async function taskerTick(): Promise<{ drained: number; measured: number; failed: number } | null> {
  const client = await systemDb().connect();
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('tasker_job')) AS ok`);
    if (!lock.rows[0]?.ok) return null;
    try {
      const d = await drainAll();
      // Прогрев снимков (при старте и раз в 15 мин; свой лок, не ждём — досылка не стоит за ним).
      maybeWarm();
      // Таблицы собраний (миграция 278) может ещё не быть — это не повод ронять остальное.
      await syncStaleMeetings().catch(e => { if ((e as { code?: string }).code !== '42P01') throw e; });
      let m = { measured: 0, failed: 0 };
      if (Date.now() - lastMeasure >= MEASURE_EVERY_MS) {
        lastMeasure = Date.now();
        m = await measureDue();
      }
      // Обучения (сессия D): запись «из формы задачи» + замер эффективности (свой интервал внутри).
      const { trainingsTick } = await import('../trainings/engine/measure');
      const t = await trainingsTick();
      return { drained: d.done, measured: m.measured + t.measured, failed: m.failed + t.failed };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('tasker_job'))`).catch(() => {});
    }
  } finally {
    client.release();
  }
}
