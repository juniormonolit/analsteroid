// Обучения → календарь Битрикса (фаза 1b, 23.11; вебхук BITRIX_WEBHOOK_URL получил право calendar).
// Событие обучения = calendar.event.add в календаре тренера (type=user, ownerId=тренер, раздел — из
// calendar.section.get, is_meeting=Y); записанные менеджеры — участники (calendar.event.update при записи/отписке);
// отмена — calendar.event.delete. id события в Битриксе — tasker_training_events.calendar_event_id.
//
// Ошибка календаря НЕ ломает событие в Монолитике: calendar_sync_state='failed' + текст ошибки; повтор — кнопкой
// тренера (POST /api/tasker/trainings/:id/sync) и лениво при чтении расписания (retryStaleCalendarSyncs).
// Синк события сериализован блокировкой строки (FOR UPDATE): две записи подряд не создадут два события.
import 'server-only';
import { bx } from '@/lib/bitrix/notify';
import { systemDb } from '@/lib/db/clients';

const webhook = () => (process.env.BITRIX_WEBHOOK_URL ?? '').replace(/\/+$/, '');
const APP = () => (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.ru').replace(/\/$/, '');
const TZ = 'Europe/Moscow';

/** Раздел (календарь) пользователя: первый, куда можно писать. Кэш в памяти — разделы почти не меняются. */
const sectionCache = new Map<string, { id: number; at: number }>();
async function sectionFor(ownerId: string): Promise<number> {
  const hit = sectionCache.get(ownerId);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.id;
  const r = await bx(webhook(), 'calendar.section.get', { type: 'user', ownerId: Number(ownerId) });
  const list = (Array.isArray(r?.result) ? r.result : []) as { ID: string; PERM?: { add?: boolean; edit?: boolean } }[];
  // Для чужого календаря Битрикс отдаёт add=false даже админскому вебхуку, но запись проходит — берём первый.
  const s = list.find(x => x.PERM?.add) ?? list[0];
  if (!s) throw new Error(`У сотрудника ${ownerId} нет календаря в Битриксе`);
  const id = Number(s.ID);
  sectionCache.set(ownerId, { id, at: Date.now() });
  return id;
}

/** 'YYYY-MM-DD HH:MM:SS' по МСК (Москва без перехода на летнее время). */
function mskStamp(d: Date): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

const isNotFound = (e: unknown) => /not.?found|не найден|NOT_FOUND|ERROR_CORE.*event/i.test(e instanceof Error ? e.message : String(e));

interface Row {
  id: string; title: string; description: string; start_at: Date; duration_min: number; place: string | null;
  trainer_bitrix_user_id: string | null; cancelled_at: Date | null;
  calendar_event_id: string | null; calendar_owner_id: string | null;
}

export type CalendarSyncState = 'pending' | 'synced' | 'failed';

/**
 * Привести событие в календаре Битрикса к состоянию в Монолитике. Никогда не бросает: итог пишется в
 * calendar_sync_state / calendar_sync_error. Возвращает итоговое состояние.
 */
export async function syncTrainingCalendar(eventId: number): Promise<CalendarSyncState> {
  const client = await systemDb().connect();
  let state: CalendarSyncState = 'failed';
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '20s'`);
    const r = await client.query<Row>(
      `SELECT id, title, description, start_at, duration_min, place, trainer_bitrix_user_id, cancelled_at,
              calendar_event_id, calendar_owner_id
         FROM tasker_training_events WHERE id = $1 FOR UPDATE`, [eventId],
    );
    const e = r.rows[0];
    if (!e) { await client.query('ROLLBACK'); return 'failed'; }
    const managers = (await client.query<{ m: string }>(
      'SELECT manager_bitrix_user_id AS m FROM tasker_training_enrollments WHERE event_id = $1 ORDER BY created_at', [eventId],
    )).rows.map(x => x.m);

    let calId: number | null = e.calendar_event_id ? Number(e.calendar_event_id) : null;
    let calOwner: string | null = e.calendar_owner_id;
    let error: string | null = null;
    try {
      if (!webhook()) throw new Error('Не задан BITRIX_WEBHOOK_URL');
      const owner = e.trainer_bitrix_user_id;

      // Старое событие убрать: отмена, тренера сняли или сменили (событие живёт в календаре владельца).
      if (calId && (e.cancelled_at || !owner || calOwner !== owner)) {
        try {
          await bx(webhook(), 'calendar.event.delete', { id: calId, type: 'user', ownerId: Number(calOwner ?? owner) });
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
        calId = null;
        calOwner = null;
      }

      if (!e.cancelled_at) {
        if (!owner) throw new Error('У обучения не указан тренер — некуда ставить событие в календарь');
        const end = new Date(e.start_at.getTime() + e.duration_min * 60_000);
        const attendees = [...new Set([owner, ...managers])].map(Number).filter(n => Number.isFinite(n) && n > 0);
        const description = [
          e.description.trim(),
          e.place ? `Место: ${e.place}` : '',
          `Расписание обучений в Монолитике: ${APP()}/tasker/trainings`,
        ].filter(Boolean).join('\n\n');
        const common = {
          type: 'user',
          ownerId: Number(owner),
          name: `Обучение: ${e.title}`,
          description,
          location: e.place ?? '',
          from: mskStamp(e.start_at),
          to: mskStamp(end),
          timezone_from: TZ,
          timezone_to: TZ,
          is_meeting: 'Y',
          host: Number(owner),
          attendees,
          // Приглашение приходит записанным менеджерам от Битрикса; перенос — повторное приглашение.
          meeting: { notify: true, reinvite: false, allow_invite: false, hide_guests: false },
          private_event: 'N',
        };
        if (calId) {
          try {
            await bx(webhook(), 'calendar.event.update', { id: calId, ...common });
          } catch (err) {
            if (!isNotFound(err)) throw err;
            calId = null; // удалили руками в Битриксе — создадим заново
          }
        }
        if (!calId) {
          const res = await bx(webhook(), 'calendar.event.add', { ...common, section: await sectionFor(owner) });
          const id = Number(res?.result);
          if (!Number.isFinite(id) || id <= 0) throw new Error('Битрикс не вернул id события календаря');
          calId = id;
          calOwner = owner;
        }
      }
      state = 'synced';
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      state = 'failed';
      console.error('[tasker/trainings calendar]', eventId, error);
    }
    await client.query(
      `UPDATE tasker_training_events
          SET calendar_event_id = $2, calendar_owner_id = $3, calendar_sync_state = $4, calendar_sync_error = $5,
              calendar_sync_attempts = CASE WHEN $4 = 'synced' THEN 0 ELSE calendar_sync_attempts + 1 END,
              calendar_synced_at = now()
        WHERE id = $1`,
      [eventId, calId, calOwner, state, error],
    );
    await client.query('COMMIT');
    return state;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[tasker/trainings calendar] сбой синка', eventId, err instanceof Error ? err.message : err);
    // Пометить «не синхронизировано» вне транзакции (best effort), чтобы событие подхватил повтор.
    await systemDb().query(
      `UPDATE tasker_training_events SET calendar_sync_state = 'failed', calendar_sync_error = $2,
              calendar_sync_attempts = calendar_sync_attempts + 1, calendar_synced_at = now() WHERE id = $1`,
      [eventId, (err instanceof Error ? err.message : String(err)).slice(0, 500)],
    ).catch(() => {});
    return 'failed';
  } finally {
    client.release();
  }
}

/** Пометить «нужно синхронизировать» — до вызова синка (если процесс упадёт посередине, повтор подхватит). */
export async function markCalendarDirty(eventId: number): Promise<void> {
  await systemDb().query(`UPDATE tasker_training_events SET calendar_sync_state = 'pending' WHERE id = $1`, [eventId]);
}

/**
 * Ленивый повтор: при чтении расписания досинхронизировать «зависшие» события (pending/failed, не трогались
 * ≥ 5 минут, < 20 попыток, не прошедшие). Не чаще раза в минуту на инстанс, в фоне — ответ не ждёт.
 */
let lastRetryAt = 0;
export function retryStaleCalendarSyncs(): void {
  if (!webhook() || Date.now() - lastRetryAt < 60_000) return;
  lastRetryAt = Date.now();
  void (async () => {
    try {
      const r = await systemDb().query<{ id: string }>(
        `SELECT id FROM tasker_training_events
          WHERE calendar_sync_state <> 'synced'
            AND calendar_sync_attempts < 20
            AND (calendar_synced_at IS NULL OR calendar_synced_at < now() - interval '5 minutes')
            AND (cancelled_at IS NULL OR calendar_event_id IS NOT NULL)
            AND start_at + make_interval(mins => duration_min) > now()
          ORDER BY start_at LIMIT 5`,
      );
      for (const row of r.rows) await syncTrainingCalendar(Number(row.id));
    } catch (e) {
      console.error('[tasker/trainings calendar retry]', e instanceof Error ? e.message : e);
    }
  })();
}
