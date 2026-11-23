// Регулярное собрание → календарь Битрикса (как сессии РОПа, features/tasker/engine/calendar.ts).
// Одно повторяющееся событие в календаре организатора: calendar.event.add с rrule, is_meeting=Y, host=организатор,
// участники — люди отделов + отдельные люди. Правка серии = update, отмена серии = delete.
//
// Ограничения REST Битрикса (проверено на портале 23.11, тестовые события удалены):
//  - EXDATE (exdate/EXDATE, строка или массив) молча игнорируется → отмена одного вхождения живёт только в Монолитике;
//  - «n-й день недели месяца» (BYDAY '2MO', BYSETPOS) отбрасывается → для monthly_nth событие «скользящее»:
//    обычное (без повтора) на ближайшее неотменённое вхождение; фоновая задача переносит его, когда оно прошло.
//
// Синк сериализован FOR UPDATE строки собрания; никогда не бросает — итог в calendar_sync_state/error;
// pending/failed подхватывает фоновая задача «tasker» (syncStaleMeetings). Идемпотентность создания — поиск
// события прошлой попытки по маркеру в описании (ответ на add мог потеряться), add — без автоповтора.
import { systemDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';
import { taskWebhook, writeOnce } from '@/features/repeat-kanban/engine/createDeal';
import { appBaseUrl, mskToday } from '../../engine/config';
import { isNotFound, mskDay, mskStamp, sectionFor } from '../../engine/calendar';
import { addDays, expandDates, firstOccurrence, occurrenceStart, toBitrixRrule } from './recurrence';
import { MEETING_SELECT, participantsOf, recurrenceOf, seriesOf, type MeetingRow } from './store';

const TZ = 'Europe/Moscow';
export const meetingMarker = (id: number) => `Задачник · собрание #${id}`;

async function findCreated(ownerId: string, day: string, marker: string): Promise<number | null> {
  const r = await bx(taskWebhook(), 'calendar.event.get', {
    type: 'user', ownerId: Number(ownerId), from: addDays(day, -1), to: addDays(day, 1),
  }) as { result?: { ID: string; DESCRIPTION?: string }[] };
  const hit = (Array.isArray(r?.result) ? r.result : []).find(e => (e.DESCRIPTION ?? '').includes(marker));
  return hit ? Number(hit.ID) : null;
}

async function deleteEvent(id: number, owner: string): Promise<void> {
  try { await bx(taskWebhook(), 'calendar.event.delete', { id, type: 'user', ownerId: Number(owner) }); }
  catch (e) { if (!isNotFound(e)) throw e; }
}

/** Ближайшее неотменённое вхождение, которое ещё не закончилось. */
function nextLiveOccurrence(r: MeetingRow): string | null {
  const today = mskToday();
  const cancelled = new Set(r.cancelled_dates ?? []);
  const endsAt = (d: string) => new Date(occurrenceStart(d, r.start_time)).getTime() + r.duration_min * 60_000;
  for (let from = today, i = 0; i < 6; i++, from = addDays(from, 92)) {
    for (const d of expandDates(seriesOf(r), from, addDays(from, 91))) {
      if (!cancelled.has(d) && endsAt(d) > Date.now()) return d;
    }
  }
  return null;
}

export async function syncMeetingCalendar(meetingId: number): Promise<'synced' | 'failed'> {
  const client = await systemDb().connect();
  let state: 'synced' | 'failed' = 'failed';
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '20s'`);
    const r = (await client.query<MeetingRow>(`${MEETING_SELECT} WHERE m.id = $1 FOR UPDATE OF m`, [meetingId])).rows[0];
    if (!r) { await client.query('ROLLBACK'); return 'failed'; }

    let calId = r.calendar_event_id ? Number(r.calendar_event_id) : null;
    let calOwner = r.calendar_owner_id;
    let occDate: string | null = r.calendar_occ_date;
    let error: string | null = null;
    try {
      if (!taskWebhook()) throw new Error('Не задан BITRIX_WEBHOOK_URL');
      const owner = r.organizer_bitrix_id;
      const rrule = toBitrixRrule(recurrenceOf(r), r.until_date);
      const target = r.cancelled_at ? null : rrule ? firstOccurrence(seriesOf(r)) : nextLiveOccurrence(r);
      const wantRolling = !rrule;
      const haveRolling = occDate !== null;
      // Убрать старое событие: серию отменили / вхождений больше нет / сменился организатор / сменился вид события
      // (повтор ↔ скользящее — rrule через update не снимается надёжно, проще пересоздать).
      if (calId && (!target || calOwner !== owner || wantRolling !== haveRolling)) {
        await deleteEvent(calId, calOwner ?? owner);
        calId = null; calOwner = null; occDate = null;
      }
      if (target) {
        const participants = await participantsOf(r);
        const attendees = [...new Set([owner, ...participants.map(p => String(p.id))])].map(Number).filter(n => Number.isInteger(n) && n > 0);
        const start = new Date(occurrenceStart(target, r.start_time));
        const end = new Date(start.getTime() + r.duration_min * 60_000);
        const marker = meetingMarker(meetingId);
        const description = [
          r.agenda.trim() ? `Повестка:\n${r.agenda.trim()}` : '',
          r.place ? `Место: ${r.place}` : '',
          wantRolling ? 'Событие на ближайшую встречу серии — после неё Монолитика перенесёт его на следующую.' : '',
          `Регулярные собрания в Монолитике: ${appBaseUrl()}/tasker/meetings`,
          marker,
        ].filter(Boolean).join('\n\n');
        const common: Record<string, unknown> = {
          type: 'user', ownerId: Number(owner), name: r.title, description, location: r.place ?? '',
          from: mskStamp(start), to: mskStamp(end), timezone_from: TZ, timezone_to: TZ,
          is_meeting: 'Y', host: Number(owner), attendees,
          meeting: { notify: true, reinvite: false, allow_invite: false, hide_guests: false },
          private_event: 'N',
          ...(rrule ? { rrule } : {}),
        };
        if (calId) {
          try { await bx(taskWebhook(), 'calendar.event.update', { id: calId, ...common }); }
          catch (e) { if (!isNotFound(e)) throw e; calId = null; }
        }
        if (!calId) {
          calId = await findCreated(owner, mskDay(start), marker);
          if (calId) await bx(taskWebhook(), 'calendar.event.update', { id: calId, ...common });
        }
        if (!calId) {
          const id = Number(await writeOnce<number>(taskWebhook(), 'calendar.event.add', { ...common, section: await sectionFor(owner) }));
          if (!Number.isInteger(id) || id <= 0) throw new Error('Битрикс не вернул id события календаря');
          calId = id;
        }
        calOwner = owner;
        occDate = wantRolling ? target : null;
      }
      state = 'synced';
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      console.error('[tasker/meetings calendar]', meetingId, error);
    }
    await client.query(
      `UPDATE tasker_meetings SET calendar_event_id = $2, calendar_owner_id = $3, calendar_occ_date = $4, calendar_sync_state = $5,
              calendar_sync_error = $6, calendar_sync_attempts = CASE WHEN $5 = 'synced' THEN 0 ELSE calendar_sync_attempts + 1 END,
              calendar_synced_at = now()
        WHERE id = $1`,
      [meetingId, calId, calOwner, occDate, state, error]);
    await client.query('COMMIT');
    return state;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.error('[tasker/meetings calendar] сбой синка', meetingId, msg);
    await systemDb().query(
      `UPDATE tasker_meetings SET calendar_sync_state = 'failed', calendar_sync_error = $2, calendar_sync_attempts = calendar_sync_attempts + 1,
              calendar_synced_at = now() WHERE id = $1`, [meetingId, msg]).catch(() => {});
    return 'failed';
  } finally {
    client.release();
  }
}

/** Фоновая задача: несинхронизированные (повтор не чаще раза в 5 мин, < 20 попыток) и «скользящие», чьё вхождение прошло. */
export async function syncStaleMeetings(limit = 10): Promise<{ synced: number; failed: number }> {
  const r = await systemDb().query<{ id: string }>(
    `SELECT id FROM tasker_meetings
      WHERE (calendar_sync_state <> 'synced' AND calendar_sync_attempts < 20
             AND (calendar_synced_at IS NULL OR calendar_synced_at < now() - interval '5 minutes'))
         OR (cancelled_at IS NULL AND calendar_mode = 'rolling' AND calendar_sync_state = 'synced'
             AND calendar_occ_date IS NOT NULL AND calendar_occ_date < (now() AT TIME ZONE 'Europe/Moscow')::date)
      ORDER BY calendar_synced_at NULLS FIRST LIMIT $1`, [limit]);
  let synced = 0, failed = 0;
  for (const x of r.rows) (await syncMeetingCalendar(Number(x.id))) === 'synced' ? synced++ : failed++;
  return { synced, failed };
}
