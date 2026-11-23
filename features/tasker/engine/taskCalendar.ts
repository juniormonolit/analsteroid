// Задача со слотом, но без сессии → событие в календаре исполнителя (РОП или тренер), менеджер — участник
// (правка 23.11, TASKER_FEEDBACK_2026-11-23.md п.10: «должно отображаться в календаре у менеджера, оповещение»).
// У задач в сессии событие одно на сессию (calendar.ts) — здесь их не трогаем.
// Вызывается из outbox (op 'task_calendar'); при ошибке бросает — очередь повторит. Идемпотентность — как у сессий:
// FOR UPDATE строки, add без автоповтора, перед созданием ищем событие прошлой попытки по маркеру.
// Автор события в Битриксе — владелец вебхука (2098); организатор (host) — исполнитель.
import { systemDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';
import { taskWebhook, writeOnce } from '@/features/repeat-kanban/engine/createDeal';
import { TASKER_KIND_LABELS, type TaskerTaskKind } from '../types';
import { appBaseUrl, bitrixTaskUrl, loadMetricDefs, loadSettings } from './config';
import { findCreatedEvent, isNotFound, mskStamp, sectionFor } from './calendar';

const TZ = 'Europe/Moscow';
export const taskMarker = (taskId: number) => `Задачник · задача #${taskId}`;

interface Row {
  id: string; slot_start: Date | null; slot_end: Date | null; duration_min: number; session_id: string | null; cancelled_at: Date | null;
  assignee_bitrix_id: string | null; manager_bitrix_id: string; manager_name: string | null; metric_id: string; kind: TaskerTaskKind | null;
  bitrix_task_id: string | null; calendar_event_id: string | null; calendar_owner_id: string | null;
}

async function dropEvent(id: number, owner: string | null): Promise<void> {
  try { await bx(taskWebhook(), 'calendar.event.delete', { id, type: 'user', ownerId: Number(owner ?? 0) }); }
  catch (e) { if (!isNotFound(e)) throw e; }
}

export async function syncTaskCalendar(taskId: number): Promise<{ eventId: number | null; skipped?: string }> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '20s'`);
    const t = (await client.query<Row>(
      `SELECT id, slot_start, slot_end, duration_min, session_id, cancelled_at, assignee_bitrix_id, manager_bitrix_id, manager_name,
              metric_id, kind, bitrix_task_id, calendar_event_id, calendar_owner_id
         FROM tasker_tasks WHERE id = $1 FOR UPDATE`, [taskId])).rows[0];
    if (!t) { await client.query('ROLLBACK'); return { eventId: null, skipped: 'задачи нет' }; }
    const owner = t.assignee_bitrix_id && /^\d+$/.test(t.assignee_bitrix_id) ? t.assignee_bitrix_id : null;
    const want = !!t.slot_start && !t.session_id && !t.cancelled_at && !!owner;
    let calId = t.calendar_event_id ? Number(t.calendar_event_id) : null;

    // Слот сняли / задача ушла в сессию / сменился исполнитель — старое событие убрать.
    if (calId && (!want || (t.calendar_owner_id && t.calendar_owner_id !== owner))) {
      await dropEvent(calId, t.calendar_owner_id);
      calId = null;
    }
    if (!want) {
      await client.query(`UPDATE tasker_tasks SET calendar_event_id = NULL, calendar_owner_id = NULL WHERE id = $1`, [taskId]);
      await client.query('COMMIT');
      return { eventId: null, skipped: 'событие не нужно' };
    }

    const [{ groupId }, metrics] = await Promise.all([loadSettings(), loadMetricDefs()]);
    const label = metrics.find(m => m.id === t.metric_id)?.label ?? t.metric_id;
    const who = t.manager_name ?? `#${t.manager_bitrix_id}`;
    const marker = taskMarker(taskId);
    const start = new Date(t.slot_start!);
    const end = t.slot_end ? new Date(t.slot_end) : new Date(start.getTime() + t.duration_min * 60_000);
    const kind = t.kind ? `${TASKER_KIND_LABELS[t.kind]}: ` : '';
    const description = [
      `${kind}${label} — работа с менеджером ${who}.`,
      t.bitrix_task_id ? `Задача: ${bitrixTaskUrl(Number(t.bitrix_task_id), groupId)}` : '',
      `Задачник в Монолитике: ${appBaseUrl()}/tasker?task=${taskId}`,
      marker,
    ].filter(Boolean).join('\n\n');
    const attendees = [...new Set([owner!, t.manager_bitrix_id])].map(Number).filter(n => Number.isInteger(n) && n > 0);
    const common = {
      type: 'user', ownerId: Number(owner), name: `${kind}${label} — ${who}`, description,
      from: mskStamp(start), to: mskStamp(end), timezone_from: TZ, timezone_to: TZ,
      is_meeting: 'Y', host: Number(owner), attendees,
      meeting: { notify: true, reinvite: false, allow_invite: false, hide_guests: false },
      private_event: 'N',
    };

    if (calId) {
      try { await bx(taskWebhook(), 'calendar.event.update', { id: calId, ...common }); }
      catch (e) { if (!isNotFound(e)) throw e; calId = null; } // удалили руками — создадим заново
    }
    if (!calId) {
      calId = await findCreatedEvent(owner!, start, marker);
      if (calId) await bx(taskWebhook(), 'calendar.event.update', { id: calId, ...common });
    }
    if (!calId) {
      const id = Number(await writeOnce<number>(taskWebhook(), 'calendar.event.add', { ...common, section: await sectionFor(owner!) }));
      if (!Number.isInteger(id) || id <= 0) throw new Error('Битрикс не вернул id события календаря');
      calId = id;
    }
    await client.query(`UPDATE tasker_tasks SET calendar_event_id = $2, calendar_owner_id = $3 WHERE id = $1`, [taskId, calId, owner]);
    await client.query('COMMIT');
    return { eventId: calId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
