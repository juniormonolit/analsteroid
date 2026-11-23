// Замер эффективности обучений (миграция 277): для каждого посетившего × показателя — значение за N дней до события
// и за N дней после (после окончания окна «после»), плюс строка «Итого» его отдела за те же окна (контроль).
// Логика вердикта — verdictOf автозамера ядра (features/tasker/engine/measure.ts), без цели: «рост» / «без изменений»
// по тому же порогу шума; «мало данных» — если знаменатель < 5 хоть в одном окне (в ядре — только «после»: там «до»
// снимается при постановке и уже проверен).
// Отчёт считается тем же кодом, что видит человек (computeSnapshots ядра), «глазами» того, кто записал менеджера
// (РОП видит своего менеджера и его отдел); нет записавшего — создателя события.
// Запуск — из тика фоновой задачи «tasker» (features/tasker/engine/job.ts), раз в 15 минут.
import 'server-only';
import { systemDb } from '@/lib/db/clients';
import { loadMetricDefs, mskToday, type TaskerMetricDef } from '../../engine/config';
import { verdictOf } from '../../engine/measure';
import { withLoopbackRunner } from '../../engine/reportRunner';
import { computeSnapshots } from '../../engine/snapshot';
import type { TaskerVerdict } from '../../types';
import { personMetricIds, trainingWindows } from './effect';
import { syncTaskEnrollments } from './taskLink';

const MAX_ATTEMPTS = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Pending {
  eventId: string; startAt: Date; beforeDays: number; afterDays: number; createdBy: string | null;
  manager: string; enrolledBy: string | null; metricIds: string[];
}

/** Что нужно замерить: посетившие на событиях с закрытым окном «после», у кого нет готового результата. */
async function findPending(today: string, limitEvents: number): Promise<Pending[]> {
  const r = await systemDb().query<{
    event_id: string; start_at: Date; b: number; a: number; created_by: string | null; metric_ids: string[];
    manager: string; enrolled_by: string | null; goal_metric_ids: string[]; task_metric_id: string | null;
    done: string[] | null;
  }>(
    `WITH ev AS (
       SELECT e.id, e.start_at, e.measure_before_days AS b, e.measure_after_days AS a, e.created_by::text AS created_by, e.metric_ids
         FROM tasker_training_events e
        WHERE e.cancelled_at IS NULL
          AND e.start_at > now() - interval '200 days'
          AND ((e.start_at AT TIME ZONE 'Europe/Moscow')::date + e.measure_after_days) < $1::date
          AND EXISTS (SELECT 1 FROM tasker_training_enrollments x WHERE x.event_id = e.id AND x.attended)
        ORDER BY e.start_at
     )
     SELECT ev.id AS event_id, ev.start_at, ev.b, ev.a, ev.created_by, ev.metric_ids,
            x.manager_bitrix_user_id AS manager, x.enrolled_by::text AS enrolled_by, x.goal_metric_ids, x.task_metric_id,
            (SELECT array_agg(r.metric_id) FROM tasker_training_results r
              WHERE r.event_id = ev.id AND r.manager_bitrix_user_id = x.manager_bitrix_user_id
                AND (r.verdict IS NOT NULL OR r.attempts >= $2 OR r.measured_at > now() - interval '1 hour')) AS done
       FROM ev JOIN tasker_training_enrollments x ON x.event_id = ev.id AND x.attended`,
    [today, MAX_ATTEMPTS],
  );
  const out: Pending[] = [];
  const events = new Set<string>();
  for (const x of r.rows) {
    const need = personMetricIds(x.metric_ids ?? [], x.goal_metric_ids ?? [], x.task_metric_id)
      .filter(id => !(x.done ?? []).includes(id));
    if (!need.length) continue;
    if (!events.has(x.event_id) && events.size >= limitEvents) continue;
    events.add(x.event_id);
    out.push({
      eventId: x.event_id, startAt: x.start_at, beforeDays: x.b, afterDays: x.a, createdBy: x.created_by,
      manager: x.manager, enrolledBy: x.enrolled_by, metricIds: need,
    });
  }
  return out;
}

async function saveResult(
  p: Pending, metricId: string, win: ReturnType<typeof trainingWindows>,
  v: { valueBefore: number | null; valueAfter: number | null; deptBefore: number | null; deptAfter: number | null; deptName: string | null;
       enoughBefore: boolean; enoughAfter: boolean; verdict: TaskerVerdict | null; error: string | null },
) {
  await systemDb().query(
    `INSERT INTO tasker_training_results
       (event_id, manager_bitrix_user_id, metric_id, before_from, before_to, after_from, after_to,
        value_before, value_after, dept_before, dept_after, dept_name, enough_before, enough_after, verdict, error, attempts, measured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, CASE WHEN $15::text IS NULL THEN 1 ELSE 0 END, now())
     ON CONFLICT (event_id, manager_bitrix_user_id, metric_id) DO UPDATE SET
       before_from = EXCLUDED.before_from, before_to = EXCLUDED.before_to, after_from = EXCLUDED.after_from, after_to = EXCLUDED.after_to,
       value_before = EXCLUDED.value_before, value_after = EXCLUDED.value_after, dept_before = EXCLUDED.dept_before,
       dept_after = EXCLUDED.dept_after, dept_name = EXCLUDED.dept_name, enough_before = EXCLUDED.enough_before,
       enough_after = EXCLUDED.enough_after, verdict = EXCLUDED.verdict, error = EXCLUDED.error,
       attempts = CASE WHEN EXCLUDED.verdict IS NULL THEN tasker_training_results.attempts + 1 ELSE tasker_training_results.attempts END,
       measured_at = now()`,
    [p.eventId, p.manager, metricId, win.before.from, win.before.to, win.after.from, win.after.to,
      v.valueBefore, v.valueAfter, v.deptBefore, v.deptAfter, v.deptName, v.enoughBefore, v.enoughAfter, v.verdict, v.error?.slice(0, 500) ?? null],
  );
}

/** Один проход замера. Возвращает число записанных результатов (с вердиктом) и сбоев. */
export async function measureTrainingsDue(limitEvents = 3): Promise<{ measured: number; failed: number }> {
  const pending = await findPending(mskToday(), limitEvents);
  if (!pending.length) return { measured: 0, failed: 0 };
  const defs = new Map((await loadMetricDefs()).map(m => [m.id, m]));
  let measured = 0, failed = 0;

  // Группы: (событие, «чьими глазами») → менеджеры; внутри — по показателю одним прогоном на окно.
  const groups = new Map<string, Pending[]>();
  for (const p of pending) {
    const runner = [p.enrolledBy, p.createdBy].find(u => u && UUID_RE.test(u)) ?? '';
    const k = `${p.eventId}|${runner}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const [k, list] of groups) {
    const runner = k.split('|')[1];
    const first = list[0];
    const win = trainingWindows(first.startAt, first.beforeDays, first.afterDays);
    const fail = async (p: Pending, metricId: string, msg: string) => {
      failed++;
      await saveResult(p, metricId, win, {
        valueBefore: null, valueAfter: null, deptBefore: null, deptAfter: null, deptName: null,
        enoughBefore: false, enoughAfter: false, verdict: null, error: msg,
      }).catch(() => {});
    };
    if (!runner) { for (const p of list) for (const m of p.metricIds) await fail(p, m, 'нет пользователя, от имени которого считать отчёт'); continue; }
    const metricIds = [...new Set(list.flatMap(p => p.metricIds))];
    try {
      await withLoopbackRunner(runner, async run => {
        for (const metricId of metricIds) {
          const metric: TaskerMetricDef | undefined = defs.get(metricId);
          const who = list.filter(p => p.metricIds.includes(metricId));
          if (!metric) { for (const p of who) await fail(p, metricId, 'показатель убран из белого списка'); continue; }
          try {
            const ids = who.map(p => p.manager);
            const [before, after] = await Promise.all([
              computeSnapshots(run, ids, metric, win.before, { withOwnAvg: false }),
              computeSnapshots(run, ids, metric, win.after, { withOwnAvg: false }),
            ]);
            for (const p of who) {
              const empty = { value: null, deptAvg: null, ownAvg6m: null, deptName: null, enoughData: false };
              const b = before[p.manager];
              const a = after[p.manager] ?? empty;
              const verdict: TaskerVerdict = !b?.enoughData || b.value === null
                ? 'not_enough_data'
                : verdictOf(metric, b.value, a, null);
              await saveResult(p, metricId, win, {
                valueBefore: b?.value ?? null, valueAfter: a?.value ?? null,
                deptBefore: b?.deptAvg ?? null, deptAfter: a?.deptAvg ?? null, deptName: a?.deptName ?? b?.deptName ?? null,
                enoughBefore: !!b?.enoughData, enoughAfter: !!a?.enoughData, verdict, error: null,
              });
              measured++;
            }
          } catch (e) {
            for (const p of who) await fail(p, metricId, e instanceof Error ? e.message : String(e));
          }
        }
      });
    } catch (e) {
      for (const p of list) for (const m of p.metricIds) await fail(p, m, e instanceof Error ? e.message : String(e));
    }
  }
  return { measured, failed };
}

const MEASURE_EVERY_MS = 15 * 60_000;
let lastMeasure = 0;

/**
 * Тик обучений внутри job «tasker» (под её advisory lock): каждую минуту — запись «из формы задачи»;
 * раз в 15 минут — замер. Таблиц 277 ещё нет — молча (42P01/42703).
 */
export async function trainingsTick(): Promise<{ linked: number; measured: number; failed: number }> {
  const quiet = (e: unknown) => ['42P01', '42703'].includes((e as { code?: string })?.code ?? '');
  let linked = 0, m = { measured: 0, failed: 0 };
  try { linked = await syncTaskEnrollments(); } catch (e) { if (!quiet(e)) console.error('[tasker/trainings link]', e instanceof Error ? e.message : e); }
  if (Date.now() - lastMeasure >= MEASURE_EVERY_MS) {
    lastMeasure = Date.now();
    try { m = await measureTrainingsDue(); } catch (e) { if (!quiet(e)) console.error('[tasker/trainings measure]', e instanceof Error ? e.message : e); }
  }
  return { linked, ...m };
}
