// «Большой брат», поток D — адаптеры источников активности за интервал (BIG_BROTHER_SPEC.md, «Источники»).
//
// Определения сигналов — ТЕ ЖЕ, что у сторожа МОПов (lib/bots/idleWatch.ts → fetchSignals), чтобы «в работе» в
// агрегате и в стороже совпадало; отличие только в детализации: здесь каждое событие с action и количеством, а не
// одна отметка «был сигнал в эту минуту». Меняешь определение сигнала — правь оба места.
//   va.calls (failed_at_stage IS NULL, #10823) — исходящий: out_reached (> 20 с) / out_attempt; входящий принятый — in;
//     пропущенный входящий — in_missed («слабый»: не действие менеджера, сторож его тоже не считает);
//   sa.deal_events — deal_stage, автор = ответственный (manager_id); sa.deals — deal_new (current_manager_id);
//   sa.bitrix_task_current — create (created_by), close (closed_by); touch — changed_at ответственному и события
//     sa.bitrix_task_payload_raw ответственному («слабый»: автора нет, робот шлёт пачки — «в работе» не делает);
//   activity_events — mono_view / mono_action / session; activity_minutes (source = 'mono') — активные 5-мин бакеты;
//   repeat_kanban_events (actor_type = 'user') — kanban.<event_type>; logist_request_events — logist.<kind>.
// Каждый источник — отдельный запрос: сбой одного (нет таблицы — 42P01) не глушит остальные, имя попадает в failed.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { SECTION_SQL } from '@/lib/activity/section';
import type { DayBand } from './types';

export interface SourceEvent {
  mid: string;
  at: number;        // мс, начало минуты
  band: DayBand;
  kind: string;
  action: string | null;
  /** Раздел Монолитики (только activity_events; старые отчёты 'sales' + payload.path → 'sales/<slug>'). */
  section?: string | null;
  weak: boolean;
  n: number;
}

export interface MonoBucket { mid: string; at: number; section: string; surface: string }

export interface SourcesResult {
  events: SourceEvent[];
  monoBuckets: MonoBucket[];
  failed: string[];
}

type Row = { mid: unknown; at: unknown; kind: string; action: string | null; section?: string | null; n: unknown };

function isMissingTable(e: unknown): boolean {
  return (e as { code?: string })?.code === '42P01';
}

/** Все события людей ids за [from, to). */
export async function loadSourceEvents(ids: string[], from: Date, to: Date): Promise<SourcesResult> {
  const events: SourceEvent[] = [];
  const monoBuckets: MonoBucket[] = [];
  const failed: string[] = [];
  if (!ids.length) return { events, monoBuckets, failed };
  const idSet = new Set(ids);
  const an = analyticsDb();
  const sys = systemDb();
  const p = [ids, from.toISOString(), to.toISOString()];

  const sources: Array<{ name: string; band: DayBand; weak?: (r: Row) => boolean; run: () => Promise<{ rows: Row[] }> }> = [
    {
      name: 'va.calls', band: 'call', weak: r => r.action === 'in_missed',
      run: () => an.query(
        `SELECT c.manager_id::text AS mid, date_trunc('minute', c.called_at) AS at, 'call' AS kind,
                CASE WHEN c.direction::text = 'outbound' AND coalesce(c.duration_seconds, 0) > 20 THEN 'out_reached'
                     WHEN c.direction::text = 'outbound' THEN 'out_attempt'
                     WHEN coalesce(c.result::text, '') = 'missed' THEN 'in_missed'
                     ELSE 'in' END AS action,
                count(*) AS n
           FROM va.calls c
          WHERE c.failed_at_stage IS NULL -- #10823: служебные строки n8n — не звонки
            AND c.called_at >= $2 AND c.called_at < $3 AND c.manager_id::text = ANY($1)
          GROUP BY 1, 2, 3, 4`, p),
    },
    {
      name: 'sa.deal_events', band: 'deal',
      run: () => an.query(
        `SELECT manager_id::text AS mid, date_trunc('minute', event_at) AS at, 'deal_stage' AS kind, NULL AS action, count(*) AS n
           FROM sa.deal_events
          WHERE event_at >= $2 AND event_at < $3 AND manager_id::text = ANY($1) GROUP BY 1, 2`, p),
    },
    {
      name: 'sa.deals', band: 'deal',
      run: () => an.query(
        `SELECT current_manager_id::text AS mid, date_trunc('minute', created_at) AS at, 'deal_new' AS kind, NULL AS action, count(*) AS n
           FROM sa.deals
          WHERE created_at >= $2 AND created_at < $3 AND current_manager_id::text = ANY($1) GROUP BY 1, 2`, p),
    },
    {
      name: 'sa.bitrix_task_current', band: 'task', weak: r => r.action === 'touch',
      run: () => an.query(
        `SELECT mid, date_trunc('minute', at) AS at, 'task' AS kind, action, count(*) AS n FROM (
           SELECT created_by::text AS mid, created_at AS at, 'create' AS action FROM sa.bitrix_task_current
            WHERE created_at >= $2 AND created_at < $3
           UNION ALL
           SELECT closed_by::text, closed_at, 'close' FROM sa.bitrix_task_current WHERE closed_at >= $2 AND closed_at < $3
           UNION ALL
           SELECT responsible_id::text, changed_at, 'touch' FROM sa.bitrix_task_current WHERE changed_at >= $2 AND changed_at < $3
         ) x WHERE mid = ANY($1) GROUP BY 1, 2, 4`, p),
    },
    {
      name: 'sa.bitrix_task_payload_raw', band: 'task', weak: () => true,
      run: () => an.query(
        `SELECT t.responsible_id::text AS mid, date_trunc('minute', r.received_at) AS at, 'task' AS kind, 'touch' AS action,
                count(*) AS n
           FROM sa.bitrix_task_payload_raw r JOIN sa.bitrix_task_current t ON t.task_id = r.task_id
          WHERE r.received_at >= $2 AND r.received_at < $3 AND t.responsible_id::text = ANY($1)
          GROUP BY 1, 2`, p),
    },
    {
      name: 'activity_events', band: 'mono',
      run: () => sys.query(
        `SELECT mid, at, kind, CASE WHEN kind = 'mono_view' THEN section ELSE action END AS action, section, count(*) AS n
           FROM (SELECT bitrix_user_id AS mid, date_trunc('minute', ts) AS at, kind, action, ${SECTION_SQL} AS section
                   FROM activity_events
                  WHERE ts >= $2 AND ts < $3 AND bitrix_user_id = ANY($1)) e
          GROUP BY 1, 2, 3, 4, 5`, p),
    },
    {
      name: 'repeat_kanban_events', band: 'mono',
      run: () => sys.query(
        `SELECT actor_bitrix_id AS mid, date_trunc('minute', ts) AS at, 'kanban' AS kind, event_type AS action, count(*) AS n
           FROM repeat_kanban_events
          WHERE actor_type = 'user' AND ts >= $2 AND ts < $3 AND actor_bitrix_id = ANY($1) GROUP BY 1, 2, 4`, p),
    },
    {
      name: 'logist_request_events', band: 'mono',
      run: () => sys.query(
        `SELECT actor_bitrix_id AS mid, date_trunc('minute', at) AS at, 'logist' AS kind, kind AS action, count(*) AS n
           FROM logist_request_events
          WHERE at >= $2 AND at < $3 AND actor_bitrix_id = ANY($1) GROUP BY 1, 2, 4`, p),
    },
  ];

  const minutes = (async () => {
    try {
      const r = await sys.query<{ mid: string; at: Date; section: string; surface: string }>(
        `SELECT bitrix_user_id AS mid, bucket AS at, section, surface FROM activity_minutes
          WHERE source = 'mono' AND bucket >= $2 AND bucket < $3 AND bitrix_user_id = ANY($1)`, p);
      for (const x of r.rows) {
        if (idSet.has(x.mid)) monoBuckets.push({ mid: x.mid, at: new Date(x.at).getTime(), section: x.section, surface: x.surface });
      }
    } catch (e) {
      failed.push('activity_minutes');
      if (!isMissingTable(e)) console.warn('[activityDaily] activity_minutes:', e instanceof Error ? e.message : e);
    }
  })();

  await Promise.all([minutes, ...sources.map(async s => {
    try {
      const r = await s.run();
      for (const row of r.rows) {
        const mid = row.mid == null ? '' : String(row.mid);
        if (!idSet.has(mid) || !row.at) continue;
        const at = new Date(row.at as string).getTime();
        if (!Number.isFinite(at)) continue;
        events.push({ mid, at, band: s.band, kind: row.kind, action: row.action ?? null, section: row.section ?? null, weak: s.weak?.(row) ?? false, n: Number(row.n) || 1 });
      }
    } catch (e) {
      failed.push(s.name);
      if (!isMissingTable(e)) console.warn(`[activityDaily] источник ${s.name}:`, e instanceof Error ? e.message : e);
    }
  })]);
  events.sort((a, b) => a.at - b.at);
  return { events, monoBuckets, failed };
}

export interface TaskStats { closed: number; overdue: number }

/**
 * Задачи на ответственном: закрыто за [from, to) и просрочено на момент asOf (срок < asOf, создана до asOf, не удалена;
 * открыта сейчас — не начата / в работе / отложена — или закрыта позже asOf). «Ждёт контроля» (4) не считаем — как
 * дисциплина задач потока B. Формула «на момент» работает и для прошлых дат по текущей копии задач (истории статусов нет,
 * но closed_at/deadline_at есть; если срок потом переносили — видим последний срок).
 */
export async function loadTaskStats(ids: string[], from: Date, to: Date, asOf: Date): Promise<Map<string, TaskStats>> {
  const out = new Map<string, TaskStats>();
  if (!ids.length) return out;
  const r = await analyticsDb().query<{ rid: string; closed: number; overdue: number }>(
    `SELECT responsible_id::text AS rid,
            count(*) FILTER (WHERE status = 5 AND closed_at >= $2 AND closed_at < $3)::int AS closed,
            count(*) FILTER (WHERE created_at < $4 AND deadline_at < $4
                               AND ((status IN (1, 2, 3, 6)) OR (status = 5 AND closed_at > $4)))::int AS overdue
       FROM sa.bitrix_task_current
      WHERE NOT is_deleted AND responsible_id = ANY($1::int[])
        AND (closed_at IS NULL OR closed_at >= $2) AND created_at < $4
      GROUP BY 1`,
    [ids.map(Number).filter(Number.isFinite), from.toISOString(), to.toISOString(), asOf.toISOString()],
  );
  for (const x of r.rows) out.set(x.rid, { closed: x.closed, overdue: x.overdue });
  return out;
}
