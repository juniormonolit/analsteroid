// Брак снимается сам, когда сделку заказчика после брака открыли у ДРУГОГО менеджера (владелец 13.11: «Да, снимай брак
// при смене ответственного»). Живой случай — «Нейда», контакт 151678: Ян Руденко отправил в брак, а сделку 275194 в
// Битриксе передали Софье Захаровой и снова открыли — карточка висела в «Браке» с плашкой «сделка открыта — закройте».
// Логика: брак (customer_marks no_call) + открытая повторная сделка (воронки 2/3, не отказ и не отгружена), чей
// ответственный ≠ менеджер, который вёл заказчика ДО брака (manager_id последнего события канбана раньше брака; «Нейда»:
// Руденко сначала передал сделку Софье, потом брак — на момент брака карточка уже Софьина, а вела её Хаткевич).
// Тот же менеджер — оставляем как есть (плашка «закройте сделку»). Менеджер при браке неизвестен — не трогаем.
// Запускается из фоновой сверки задач (taskReview.refreshOpenTaskStatuses, раз в 30 мин в рабочее время) — без Битрикса.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { CLIENT_KEY_SQL } from '@/features/customers/engine/clientKey';
import { newRequestId } from './log';

export async function liftBrakOnReassign(): Promise<{ checked: number; lifted: string[] }> {
  const db = systemDb();
  const marks = (await db.query<{ client_key: string; created_at: Date; brak_mgr: string | null }>(
    `SELECT m.client_key, m.created_at,
            coalesce(
              -- кто вёл заказчика ДО брака: последнее событие канбана раньше самого брака (минута на событие брака);
              (SELECT e.manager_id FROM repeat_kanban_events e
                WHERE e.client_key = m.client_key AND e.manager_id IS NOT NULL AND e.ts < m.created_at - interval '1 minute'
                ORDER BY e.ts DESC LIMIT 1),
              -- событий до брака нет — менеджер карточки в момент брака.
              (SELECT e.manager_id FROM repeat_kanban_events e
                WHERE e.client_key = m.client_key AND e.manager_id IS NOT NULL AND e.ts <= m.created_at + interval '5 minutes'
                ORDER BY e.ts DESC LIMIT 1)) AS brak_mgr
       FROM customer_marks m WHERE m.kind = 'no_call'`,
  )).rows.filter(m => m.brak_mgr);
  if (!marks.length) return { checked: 0, lifted: [] };
  const open = (await analyticsDb().query<{ k: string; deal_id: string; mgr: string | null }>(
    `SELECT k, deal_id::text, mgr FROM (
       SELECT (${CLIENT_KEY_SQL}) AS k, d.deal_id, d.current_manager_id::text AS mgr
         FROM sa.deals d LEFT JOIN sa.stages s ON s.id = d.stage_id
        WHERE d.funnel_id IN (2, 3) AND coalesce(s.event_type NOT IN ('lost', 'shipped'), false)
     ) t WHERE k = ANY($1::text[])`,
    [marks.map(m => m.client_key)],
  )).rows;
  const lifted: string[] = [];
  for (const m of marks) {
    const d = open.find(x => x.k === m.client_key && x.mgr && x.mgr !== m.brak_mgr);
    if (!d) continue;
    const del = await db.query(`DELETE FROM customer_marks WHERE client_key = $1 AND kind = 'no_call' AND created_at = $2`, [m.client_key, m.created_at]);
    if (!del.rowCount) continue; // брак успели поставить заново — не трогаем
    lifted.push(m.client_key);
    const why = `Брак снят автоматически: сделка #${d.deal_id} снова открыта у другого менеджера`;
    await db.query(
      `INSERT INTO customer_mark_history (client_key, action, snooze_until, reason, comment, created_by, created_by_user_id)
       VALUES ($1, 'clear', NULL, NULL, $2, 'Канбан повторных (авто)', NULL)`, [m.client_key, why],
    ).catch(() => {});
    await db.query(
      `INSERT INTO repeat_kanban_events (request_id, actor_type, actor_name, event_type, client_key, manager_id, deal_id, payload)
       VALUES ($1, 'system', 'Канбан повторных (авто)', 'brak_lifted_reassign', $2, $3, $4, $5)`,
      [newRequestId(), m.client_key, d.mgr, Number(d.deal_id), JSON.stringify({ from: m.brak_mgr, to: d.mgr, brakAt: m.created_at })],
    ).catch(e => console.warn('[repeat-kanban] журнал автоснятия брака:', e instanceof Error ? e.message : e));
  }
  if (lifted.length) console.log(`[repeat-kanban] брак снят (сделка открыта у другого менеджера): ${lifted.join(', ')}`);
  return { checked: marks.length, lifted };
}
