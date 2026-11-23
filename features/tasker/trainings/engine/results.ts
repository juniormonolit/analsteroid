// Результаты замеров и журнал записей обучений (миграция 277).
import 'server-only';
import type { PoolClient } from 'pg';
import { systemDb } from '@/lib/db/clients';
import type { TaskerVerdict } from '../../types';
import type { TrainingLogEntry, TrainingResult } from '../types';

interface ResultRow {
  event_id: string; manager_bitrix_user_id: string; metric_id: string;
  before_from: string; before_to: string; after_from: string; after_to: string;
  value_before: string | null; value_after: string | null; dept_before: string | null; dept_after: string | null;
  dept_name: string | null; verdict: TaskerVerdict | null; error: string | null; measured_at: Date;
}

const num = (v: string | null) => (v === null ? null : Number(v));

export const resultKey = (eventId: string | number, managerId: string | number) => `${eventId}:${managerId}`;

/** Замеры по событиям (и, если задано, по менеджерам) → «событие:менеджер» → результаты. */
export async function loadResults(eventIds: (string | number)[], managerIds?: string[]): Promise<Map<string, TrainingResult[]>> {
  const out = new Map<string, TrainingResult[]>();
  if (eventIds.length === 0) return out;
  const r = await systemDb().query<ResultRow>(
    `SELECT event_id, manager_bitrix_user_id, metric_id,
            before_from::text, before_to::text, after_from::text, after_to::text,
            value_before, value_after, dept_before, dept_after, dept_name, verdict, error, measured_at
       FROM tasker_training_results
      WHERE event_id = ANY($1::bigint[]) AND ($2::text[] IS NULL OR manager_bitrix_user_id = ANY($2::text[]))
      ORDER BY metric_id`,
    [eventIds.map(String), managerIds ?? null],
  );
  for (const x of r.rows) {
    const k = resultKey(x.event_id, x.manager_bitrix_user_id);
    const list = out.get(k) ?? [];
    list.push({
      metricId: x.metric_id,
      before: { from: x.before_from, to: x.before_to },
      after: { from: x.after_from, to: x.after_to },
      valueBefore: num(x.value_before), valueAfter: num(x.value_after),
      deptBefore: num(x.dept_before), deptAfter: num(x.dept_after), deptName: x.dept_name,
      verdict: x.verdict, error: x.error, measuredAt: x.measured_at.toISOString(),
    });
    out.set(k, list);
  }
  return out;
}

type Q = Pick<PoolClient, 'query'>;

/** Запись в журнал записей/отписок/посещаемости. Ошибку журнала не пробрасываем — он не важнее действия. */
export async function writeLog(
  db: Q,
  e: { eventId: number | string; managerId: string; action: TrainingLogEntry['action']; actorUserId?: string | null; taskId?: number | null; details?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `INSERT INTO tasker_training_enrollment_log (event_id, manager_bitrix_user_id, action, actor_user_id, tasker_task_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT DO NOTHING`,
    [e.eventId, e.managerId, e.action, e.actorUserId ?? null, e.taskId ?? null, JSON.stringify(e.details ?? {})],
  ).catch(err => console.error('[tasker/trainings log]', err instanceof Error ? err.message : err));
}
