// «Большой брат» — запись журнала активности Монолитики (миграция 296, таксономия — ./types.ts).
// Единственная точка записи в activity_events / activity_minutes. НИКОГДА не бросает: сбой
// журнала не должен ронять действие пользователя (образец — features/repeat-kanban/engine/log.ts).
// Вызов из мутирующих API: `void logActivity(session, {...})` — не ждём, ответ не задерживаем.
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { ACTIVITY_BUCKET_MIN, ACTIVITY_TTL_DAYS, type ActivityInput, type ActivitySurface } from './types';

type Actor = Pick<SessionUser, 'id' | 'login' | 'bitrixUserId' | 'roleName'>;

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const dealNum = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

function warn(where: string, err: unknown) {
  console.warn(`[activity] ${where} не записалось:`, err instanceof Error ? err.message : err);
}

/** Событие от имени пользователя с сессией. */
export async function logActivity(session: Actor | null | undefined, e: ActivityInput): Promise<void> {
  if (!session) return;
  try {
    await systemDb().query(
      `INSERT INTO activity_events (user_id, login, bitrix_user_id, role_name, surface, kind, action, section,
                                    entity_type, entity_id, deal_id, request_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [session.id, session.login, session.bitrixUserId, session.roleName, e.surface ?? 'server',
       e.kind, str(e.action), str(e.section), str(e.entityType), str(e.entityId), dealNum(e.dealId),
       str(e.requestId), JSON.stringify(e.payload ?? {})],
    );
  } catch (err) {
    warn(`${e.kind}/${e.action ?? ''}`, err);
  }
}

/** Событие по users.id — когда сессии ещё/уже нет (вход, выход). Данные пользователя — одним INSERT…SELECT. */
export async function logActivityByUserId(userId: string, e: ActivityInput): Promise<void> {
  try {
    await systemDb().query(
      `INSERT INTO activity_events (user_id, login, bitrix_user_id, role_name, surface, kind, action, section,
                                    entity_type, entity_id, deal_id, request_id, payload)
       SELECT u.id, u.login, u.bitrix_user_id, r.name, $2, $3, $4, $5, $6, $7, $8, $9, $10
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [userId, e.surface ?? 'server', e.kind, str(e.action), str(e.section), str(e.entityType), str(e.entityId),
       dealNum(e.dealId), str(e.requestId), JSON.stringify(e.payload ?? {})],
    );
  } catch (err) {
    warn(`${e.kind}/${e.action ?? ''}`, err);
  }
}

/** Уход со страницы: дописать active_ms / total_ms в последний mono_view этого человека по этому пути
 *  (за 12 ч, ещё без длительности). Не нашлось (просмотр не записался) — ничего. Не бросает. */
export async function recordViewLeave(s: Pick<SessionUser, 'id' | 'bitrixUserId'>, path: string, activeMs: number, totalMs: number): Promise<void> {
  try {
    await systemDb().query(
      `UPDATE activity_events SET payload = payload || jsonb_build_object('active_ms', $3::int, 'total_ms', $4::bigint)
        WHERE id = (SELECT id FROM activity_events
                     WHERE ${s.bitrixUserId ? 'bitrix_user_id = $1' : 'user_id = $1::uuid'}
                       AND ts > now() - interval '12 hours' AND kind = 'mono_view'
                       AND payload->>'path' = $2 AND NOT (payload ? 'active_ms')
                     ORDER BY ts DESC LIMIT 1)`,
      [s.bitrixUserId || s.id, path, activeMs, totalMs],
    );
  } catch (err) {
    warn('длительность просмотра', err);
  }
}

/** Ключ человека в activity_minutes: Битрикс-id, а у пользователя без него — 'u:<users.id>'. */
export const minuteKey = (s: Pick<SessionUser, 'id' | 'bitrixUserId'>) => s.bitrixUserId || `u:${s.id}`;

/** Heartbeat: отметить текущий 5-мин бакет. Повтор в том же бакете — no-op (ON CONFLICT DO NOTHING).
 *  Возвращает true, если бакет новый. */
export async function recordMinute(
  s: Pick<SessionUser, 'id' | 'bitrixUserId'>,
  p: { source?: string; surface: ActivitySurface; section: string; at?: Date },
): Promise<boolean> {
  try {
    const r = await systemDb().query(
      `INSERT INTO activity_minutes (bitrix_user_id, bucket, source, surface, section)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM $2::timestamptz) / $3) * $3), $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [minuteKey(s), (p.at ?? new Date()).toISOString(), ACTIVITY_BUCKET_MIN * 60, p.source ?? 'mono', p.surface, p.section],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    warn('activity_minutes', err);
    return false;
  }
}

/** TTL: удалить из activity_events / activity_minutes всё старше ACTIVITY_TTL_DAYS (90 дней).
 *  activity_daily не трогает (бессрочно). Порциями, чтобы не держать долгие блокировки.
 *  Планирование — runOnceADayMsk в instrumentation.ts (подключает поток C/D). Не бросает. */
export async function purgeOldActivity(days = ACTIVITY_TTL_DAYS): Promise<{ events: number; minutes: number }> {
  const out = { events: 0, minutes: 0 };
  const db = systemDb();
  try {
    for (;;) {
      const r = await db.query(
        `DELETE FROM activity_events WHERE id IN (
           SELECT id FROM activity_events WHERE ts < now() - make_interval(days => $1) LIMIT 20000)`,
        [days],
      );
      out.events += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < 20000) break;
    }
    const m = await db.query(`DELETE FROM activity_minutes WHERE bucket < now() - make_interval(days => $1)`, [days]);
    out.minutes = m.rowCount ?? 0;
  } catch (err) {
    warn('TTL-чистка', err);
  }
  return out;
}
