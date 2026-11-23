// Какая задача — «Теория» на тренера. Модель «Теория / Практика» ведёт ядро (миграция 279, сессия A):
// tasker_tasks.kind = 'theory', исполнитель — assignee_bitrix_id (тренер), завершение — done_at.
// Здесь — единственное место, где модуль обучений об этом знает. До наката 279 колонок нет — очередь пуста
// (available=false), остальной раздел работает.
import 'server-only';
import { systemDb } from '@/lib/db/clients';

let cache: { at: number; ok: boolean } | null = null;

async function hasKindColumn(): Promise<boolean> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.ok;
  const r = await systemDb().query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tasker_tasks' AND table_schema = current_schema() AND column_name IN ('kind', 'assignee_bitrix_id', 'done_at')`);
  cache = { at: Date.now(), ok: (r.rowCount ?? 0) === 3 };
  return cache.ok;
}

/** WHERE-фрагмент «открытая задача Теория на тренера» для алиаса tasker_tasks ($1 = тренер); null — 279 не накачена. */
export async function theoryTaskWhere(alias: string, trainerId: string): Promise<{ sql: string; args: unknown[] } | null> {
  if (!(await hasKindColumn())) return null;
  return {
    sql: `${alias}.kind = 'theory' AND COALESCE(${alias}.assignee_bitrix_id, '') = $1 AND ${alias}.done_at IS NULL`,
    args: [trainerId],
  };
}
