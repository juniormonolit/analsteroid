// Какая задача — «Теория» на тренера. Модель «Теория / Практика» ведёт ядро (сессия A); здесь — единственное место,
// где модуль обучений об этом знает. Пока колонки типа задачи в tasker_tasks нет, очередь пуста (available=false).
import 'server-only';
import { systemDb } from '@/lib/db/clients';

let cache: { at: number; cols: Set<string> } | null = null;

async function taskColumns(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.cols;
  const r = await systemDb().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'tasker_tasks' AND table_schema = current_schema()`);
  cache = { at: Date.now(), cols: new Set(r.rows.map(x => x.column_name)) };
  return cache.cols;
}

/** WHERE-фрагмент «задача Теория на тренера» для алиаса tasker_tasks; null — модель ещё не развёрнута. */
export async function theoryTaskWhere(alias: string, trainerId: string): Promise<{ sql: string; args: unknown[] } | null> {
  const cols = await taskColumns();
  void trainerId;
  // Имя колонки у ядра на момент написания не зафиксировано (23.11) — берём первую существующую из вероятных.
  // Когда A закоммитит модель, оставить одну строку с точным именем.
  const col = ['kind', 'task_kind', 'task_type', 'work_type'].find(c => cols.has(c));
  if (col) return { sql: `${alias}.${col} = 'theory'`, args: [] };
  return null;
}
