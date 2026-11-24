// Автозамер: на контрольную дату пересчитать показатель и поставить вердикт
// («достигнуто / рост, не дотянул / без изменений / мало данных»), комментарием — в задачу.
//
// Окно замера: от дня постановки до дня перед контрольной датой (не короче 7 дней) — эффект
// работы после задачи, тем же прогоном отчёта, что и снимок. Фоновая задача не имеет cookie,
// поэтому отчёт считается «глазами» постановщика (withLoopbackRunner, reportRunner.ts).
import { systemDb } from '@/lib/db/clients';
import type { Snapshot, TaskerVerdict } from '../types';
import { TASKER_VERDICT_LABELS } from '../types';
import { addDaysYmd, fmtValue, loadMetricDefs, mskToday, type TaskerMetricDef } from './config';
import { computeSnapshots, stripMeta } from './snapshot';
import { withLoopbackRunner, type ReportRunner } from './reportRunner';
import { drainTask, enqueue } from './bitrix';
import { TASK_COLUMNS, type TaskRow } from './repo';

const MAX_MEASURE_ATTEMPTS = 6;
/** Изменение меньше 2% от исходного — «без изменений». */
const NOISE_REL = 0.02;

export function measureWindow(createdAtIso: string, controlDate: string): { from: string; to: string } {
  const created = new Date(new Date(createdAtIso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
  const to = addDaysYmd(controlDate, -1);
  const minFrom = addDaysYmd(to, -6);
  return { from: created < minFrom ? created : minFrom, to };
}

export function verdictOf(metric: Pick<TaskerMetricDef, 'higherIsBetter'>, before: number | null, after: Snapshot, target: number | null): TaskerVerdict {
  if (!after.enoughData || after.value === null) return 'not_enough_data';
  const better = (a: number, b: number) => (metric.higherIsBetter ? a >= b : a <= b);
  // «Достигнуто» — только в правильную сторону: цель, поставленная хуже исходного значения (старые задачи до
  // правила defaultGoal, баг 24.11), не засчитывается простым удержанием/падением — планка = исходное значение.
  const bar = target === null ? null : before !== null && better(before, target) && before !== target ? before : target;
  if (bar !== null && better(after.value, bar)) return 'achieved';
  if (before === null) return 'no_change';
  const delta = metric.higherIsBetter ? after.value - before : before - after.value;
  const noise = Math.max(Math.abs(before) * NOISE_REL, 1e-9);
  return delta > noise ? 'improved' : 'no_change';
}

function commentText(metric: TaskerMetricDef, row: TaskRow, after: Snapshot, verdict: TaskerVerdict, win: { from: string; to: string }): string {
  const f = (v: number | null) => fmtValue(v, metric.format);
  const d = (s: string) => s.split('-').reverse().join('.');
  const target = row.target === null ? null : Number(row.target);
  return [
    `[B]Автозамер Задачника: ${TASKER_VERDICT_LABELS[verdict]}[/B]`,
    `${metric.label} за ${d(win.from)} — ${d(win.to)}: ${f(after.value)} (было ${f(row.snapshot?.value ?? null)}, цель ${f(target)}).`,
    `Среднее по отделу сейчас: ${f(after.deptAvg)}.`,
    ...(verdict === 'not_enough_data' ? [`[COLOR=#999999]Мало данных за окно замера (знаменатель ${after.denominator ?? 0}).[/COLOR]`] : []),
  ].join('\n');
}

async function measureOne(run: ReportRunner, row: TaskRow, metric: TaskerMetricDef): Promise<TaskerVerdict> {
  const win = measureWindow(new Date(row.created_at).toISOString(), row.control_date);
  const snaps = await computeSnapshots(run, [row.manager_bitrix_id], metric, win, { withOwnAvg: false });
  const after = stripMeta(snaps[row.manager_bitrix_id]);
  const target = row.target === null ? null : Number(row.target);
  const verdict = verdictOf(metric, row.snapshot?.value ?? null, after, target);
  await systemDb().query(
    `UPDATE tasker_tasks SET verdict = $2, measured_value = $3, measured_snapshot = $4::jsonb, measured_at = now(),
            measure_error = NULL, updated_at = now() WHERE id = $1 AND verdict IS NULL`,
    [row.id, verdict, after.value, JSON.stringify({ ...after, window: win })]);
  if (row.bitrix_task_id) {
    await enqueue(Number(row.id), [{ op: 'comment', text: commentText(metric, row, after, verdict, win) }]);
    await drainTask(Number(row.id)).catch(() => {});
  }
  return verdict;
}

/** Тик фоновой задачи: все задачи с наступившей контрольной датой без вердикта. */
export async function measureDue(limit = 30): Promise<{ measured: number; failed: number }> {
  const today = mskToday();
  const r = await systemDb().query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM tasker_tasks t
      WHERE t.verdict IS NULL AND t.cancelled_at IS NULL AND t.control_date <= $1::date
        AND t.measure_attempts < $2 AND (t.measured_at IS NULL OR t.measured_at < now() - interval '1 hour')
      ORDER BY t.control_date, t.id LIMIT $3`,
    [today, MAX_MEASURE_ATTEMPTS, limit]);
  if (!r.rows.length) return { measured: 0, failed: 0 };
  const metrics = new Map((await loadMetricDefs()).map(m => [m.id, m]));
  let measured = 0, failed = 0;
  // Группируем по постановщику: одна временная сессия на человека.
  const byCreator = new Map<string, TaskRow[]>();
  for (const row of r.rows) {
    const k = row.creator_user_id ?? '';
    byCreator.set(k, [...(byCreator.get(k) ?? []), row]);
  }
  for (const [creator, rows] of byCreator) {
    const fail = async (row: TaskRow, msg: string) => {
      failed++;
      // measured_at — отметка попытки (вердикта нет): следующая — не раньше чем через час.
      await systemDb().query(
        `UPDATE tasker_tasks SET measure_attempts = measure_attempts + 1, measure_error = $2, measured_at = now() WHERE id = $1`,
        [row.id, msg.slice(0, 500)]);
    };
    if (!creator) { for (const row of rows) await fail(row, 'нет постановщика для расчёта отчёта'); continue; }
    try {
      await withLoopbackRunner(creator, async run => {
        for (const row of rows) {
          const metric = metrics.get(row.metric_id);
          if (!metric) { await fail(row, 'показатель убран из белого списка'); continue; }
          try { await measureOne(run, row, metric); measured++; }
          catch (e) { await fail(row, e instanceof Error ? e.message : String(e)); }
        }
      });
    } catch (e) {
      for (const row of rows) await fail(row, e instanceof Error ? e.message : String(e));
    }
  }
  return { measured, failed };
}
