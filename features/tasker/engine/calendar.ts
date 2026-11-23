// Сессия РОПа → одно событие в его календаре Битрикса (фаза 1b, TASKER_SPEC.md «Темы и умное расписание»;
// право calendar у BITRIX_WEBHOOK_URL выдано 23.11). type=user, ownerId=РОП, раздел — первый из
// calendar.section.get, is_meeting=Y, host=РОП, участники — менеджеры сессии, ссылки на задачи — в описании.
// Длительность — из tasker_sessions (30 мин + 15 на каждого следующего менеджера).
//
// Вызывается из outbox (op 'calendar', features/tasker/engine/bitrix.ts) — при ошибке бросает, очередь повторит.
// Идемпотентность: синк под FOR UPDATE строки сессии; calendar.event.add — без автоповтора (writeOnce), а перед
// созданием ищем событие прошлой попытки по маркеру в описании (ответ Битрикса мог потеряться).
// Автор события в Битриксе — владелец вебхука (2098, Сергей Афанасьев): REST от имени РОПа без его OAuth-токена
// невозможен; событие лежит в календаре РОПа, организатор (host) — РОП.
import { systemDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';
import { taskWebhook, writeOnce } from '@/features/repeat-kanban/engine/createDeal';
import { appBaseUrl, bitrixTaskUrl, loadMetricDefs, loadSettings } from './config';

const TZ = 'Europe/Moscow';

const sectionCache = new Map<string, { id: number; at: number }>();
export async function sectionFor(ownerId: string): Promise<number> {
  const hit = sectionCache.get(ownerId);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.id;
  const r = await bx(taskWebhook(), 'calendar.section.get', { type: 'user', ownerId: Number(ownerId) }) as { result?: unknown };
  const list = (Array.isArray(r?.result) ? r.result : []) as { ID: string; PERM?: { add?: boolean } }[];
  // Для чужого календаря Битрикс отдаёт add=false даже админскому вебхуку, но запись проходит (проверено сессией D).
  const s = list.find(x => x.PERM?.add) ?? list[0];
  if (!s) throw new Error(`У сотрудника ${ownerId} нет календаря в Битриксе`);
  sectionCache.set(ownerId, { id: Number(s.ID), at: Date.now() });
  return Number(s.ID);
}

/** 'YYYY-MM-DD HH:MM:SS' по МСК. */
export function mskStamp(d: Date): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}
export const mskDay = (d: Date, shiftDays = 0) => new Date(d.getTime() + 3 * 3600_000 + shiftDays * 86_400_000).toISOString().slice(0, 10);

export const isNotFound = (e: unknown) => /not.?found|не найден|NOT_FOUND/i.test(e instanceof Error ? e.message : String(e));

export const sessionMarker = (sessionId: number) => `Задачник · сессия #${sessionId}`;

/** Событие прошлой попытки (ответ на add потерялся): тот же календарь и день, маркер в описании. */
export async function findCreatedEvent(ownerId: string, slot: Date, marker: string): Promise<number | null> {
  const r = await bx(taskWebhook(), 'calendar.event.get', {
    type: 'user', ownerId: Number(ownerId), from: mskDay(slot, -1), to: mskDay(slot, 1),
  }) as { result?: { ID: string; DESCRIPTION?: string }[] };
  const hit = (Array.isArray(r?.result) ? r.result : []).find(e => (e.DESCRIPTION ?? '').includes(marker));
  return hit ? Number(hit.ID) : null;
}

interface SessionRow {
  id: string; rop_bitrix_id: string; metric_id: string; slot_start: Date; duration_min: number;
  calendar_event_id: string | null; calendar_owner_id: string | null;
}

/** Привести событие сессии в календаре к состоянию в Монолитике. Бросает при ошибке Битрикса. */
export async function syncSessionCalendar(sessionId: number): Promise<{ eventId: number | null; skipped?: string }> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '20s'`);
    const s = (await client.query<SessionRow>(
      `SELECT id, rop_bitrix_id, metric_id, slot_start, duration_min, calendar_event_id, calendar_owner_id
         FROM tasker_sessions WHERE id = $1 FOR UPDATE`, [sessionId])).rows[0];
    if (!s) { await client.query('ROLLBACK'); return { eventId: null, skipped: 'сессия удалена' }; }
    const owner = /^\d+$/.test(s.rop_bitrix_id) ? s.rop_bitrix_id : null;
    if (!owner) {
      await client.query(`UPDATE tasker_sessions SET calendar_sync_state = 'skipped', calendar_sync_error = $2 WHERE id = $1`,
        [sessionId, 'у сессии нет РОПа с Bitrix ID — событие не ставим']);
      await client.query('COMMIT');
      return { eventId: null, skipped: 'нет РОПа' };
    }

    const tasks = (await client.query<{ manager_bitrix_id: string; manager_name: string | null; bitrix_task_id: string | null; title: string }>(
      `SELECT manager_bitrix_id, manager_name, bitrix_task_id, title FROM tasker_tasks
        WHERE session_id = $1 AND cancelled_at IS NULL ORDER BY id`, [sessionId])).rows;
    const [{ groupId }, metrics] = await Promise.all([loadSettings(), loadMetricDefs()]);
    const label = metrics.find(m => m.id === s.metric_id)?.label ?? s.metric_id;
    const marker = sessionMarker(sessionId);
    const lines = tasks.map(t => {
      const who = t.manager_name ?? `#${t.manager_bitrix_id}`;
      return t.bitrix_task_id ? `• ${who}: ${bitrixTaskUrl(Number(t.bitrix_task_id), groupId)}` : `• ${who}: задача создаётся`;
    });
    const description = [
      `Сессия по теме «${label}» — разбор задач менеджеров.`,
      lines.join('\n'),
      `Задачник в Монолитике: ${appBaseUrl()}/tasker`,
      marker,
    ].filter(Boolean).join('\n\n');
    const start = new Date(s.slot_start);
    const end = new Date(start.getTime() + s.duration_min * 60_000);
    const attendees = [...new Set([owner, ...tasks.map(t => t.manager_bitrix_id)])].map(Number).filter(n => Number.isInteger(n) && n > 0);
    const common = {
      type: 'user', ownerId: Number(owner), name: `Сессия: ${label}`, description,
      from: mskStamp(start), to: mskStamp(end), timezone_from: TZ, timezone_to: TZ,
      is_meeting: 'Y', host: Number(owner), attendees,
      meeting: { notify: true, reinvite: false, allow_invite: false, hide_guests: false },
      private_event: 'N',
    };

    let calId = s.calendar_event_id ? Number(s.calendar_event_id) : null;
    // РОП у сессии не меняется, но если событие жило в другом календаре — убрать старое.
    if (calId && s.calendar_owner_id && s.calendar_owner_id !== owner) {
      try { await bx(taskWebhook(), 'calendar.event.delete', { id: calId, type: 'user', ownerId: Number(s.calendar_owner_id) }); }
      catch (e) { if (!isNotFound(e)) throw e; }
      calId = null;
    }
    if (calId) {
      try { await bx(taskWebhook(), 'calendar.event.update', { id: calId, ...common }); }
      catch (e) { if (!isNotFound(e)) throw e; calId = null; } // удалили руками — создадим заново
    }
    if (!calId) calId = await findCreatedEvent(owner, start, marker);
    if (calId && !s.calendar_event_id) {
      // Нашли событие прошлой попытки — приводим к актуальному составу.
      await bx(taskWebhook(), 'calendar.event.update', { id: calId, ...common });
    }
    if (!calId) {
      const id = Number(await writeOnce<number>(taskWebhook(), 'calendar.event.add', { ...common, section: await sectionFor(owner) }));
      if (!Number.isInteger(id) || id <= 0) throw new Error('Битрикс не вернул id события календаря');
      calId = id;
    }
    await client.query(
      `UPDATE tasker_sessions SET calendar_event_id = $2, calendar_owner_id = $3, calendar_sync_state = 'synced', calendar_sync_error = NULL WHERE id = $1`,
      [sessionId, calId, owner]);
    await client.query('COMMIT');
    return { eventId: calId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await systemDb().query(`UPDATE tasker_sessions SET calendar_sync_state = 'failed', calendar_sync_error = $2 WHERE id = $1`,
      [sessionId, (e instanceof Error ? e.message : String(e)).slice(0, 500)]).catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
