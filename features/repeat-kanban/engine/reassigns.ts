// Смена менеджера из Монолитики видна сразу (баг Леонида Коваленко 27.10: «при смене менеджера всё
// создаётся чётко, но карточка остаётся у Кожукаря»). Заказчик принадлежит менеджеру последней сделки
// по общему снимку заказчиков, а снимок пересчитывается раз в 10 минут — до пересчёта карточка висела
// у прежнего. Без лишних запросов в Битрикс: берём свои записи о смене (журнал канбана «И сменить
// менеджера на…» и выданные из очереди позиции со сменой) и поверх снимка переносим заказчика к новому
// менеджеру. Окно — 2 часа: к этому времени снимок давно догнал (а если бизнес-процесс в Битриксе не
// отработал — карточка честно вернётся к прежнему).
import { systemDb } from '@/lib/db/clients';

const WINDOW_MS = 2 * 3600_000;

export interface Reassign { from: string; to: string; at: string }

/** Последняя смена менеджера по каждому заказчику за окно (ключ — client_key, как записан). */
export async function fetchRecentReassigns(now = Date.now()): Promise<Map<string, Reassign>> {
  const since = new Date(now - WINDOW_MS).toISOString();
  const r = await systemDb().query<{ client_key: string; from_id: string | null; to_id: string; at: Date }>(
    `SELECT client_key, payload->>'from' AS from_id, payload->>'to' AS to_id, ts AS at
       FROM repeat_kanban_events
      WHERE event_type = 'manager_reassigned' AND ts >= $1 AND client_key IS NOT NULL AND payload->>'to' IS NOT NULL
     UNION ALL
     SELECT client_key, manager_id, new_responsible_id, issued_at
       FROM repeat_task_queue
      WHERE status = 'issued' AND new_responsible_id IS NOT NULL AND issued_at >= $1
     ORDER BY at`,
    [since],
  ).catch(() => ({ rows: [] as { client_key: string; from_id: string | null; to_id: string; at: Date }[] }));
  const out = new Map<string, Reassign>();
  for (const x of r.rows) {
    if (!x.from_id || x.from_id === x.to_id) continue;
    out.set(x.client_key, { from: x.from_id, to: x.to_id, at: new Date(x.at).toISOString() });
  }
  return out;
}
