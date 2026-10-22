// Чтение живых позиций очереди для доски (плашка «в очереди» на карточке). Отдельно от queue.ts:
// тот импортирует доску (buildRepeatBoard), доска — это; без разделения был бы циклический импорт.
import { systemDb } from '@/lib/db/clients';

export interface QueuedMark { id: number; managerId: string; queuedByName: string | null; createdAt: string }

export async function fetchQueuedByClient(keys: string[]): Promise<Map<string, QueuedMark>> {
  if (!keys.length) return new Map();
  const r = await systemDb().query<{ id: string; client_key: string; manager_id: string; queued_by_name: string | null; created_at: Date }>(
    `SELECT id::text, client_key, manager_id, queued_by_name, created_at FROM repeat_task_queue
      WHERE status IN ('queued', 'issuing') AND client_key = ANY($1::text[])`, [keys],
  ).catch(() => ({ rows: [] as { id: string; client_key: string; manager_id: string; queued_by_name: string | null; created_at: Date }[] }));
  return new Map(r.rows.map(x => [x.client_key, { id: Number(x.id), managerId: x.manager_id, queuedByName: x.queued_by_name, createdAt: new Date(x.created_at).toISOString() }]));
}
